/**
 * Renewing a private feed (design §7.4–§7.7, §8; PF3–PF6b, PF9): the owner
 * opens their next feed and every follower is re-granted into it
 * automatically, one grant per follower (batch cap 1), paid by the owner.
 * Followers do nothing; their standing follow request is the consent the new
 * grant refers to (PF8).
 *
 * - With the old feed's seed on this device the new feed can carry a history
 *   link (`carry`): followers, and anyone approved later, read older posts
 *   through it. The owner chooses (PF9: "Bring your older private posts
 *   along?", yes by default). After such a move the old feed's grants are
 *   deleted (PF6), refunding part of their storage.
 * - Without the old seed (the owner's encryption key changed and no device
 *   kept it, PF5), or on a fresh start, there is no link: the old grants stay,
 *   so the followers who held them keep reading older posts (PF6b).
 *
 * The move is a {@link MoveJob} this device keeps until it finishes: private
 * posting, approvals and revocations wait for it (PF4), and it resumes after a
 * reload or a crash. Follower i of the old feed's leaf order gets leaf i, so
 * two devices running the same move write the same grants, and a grant that
 * exists already counts as done.
 */

import { logger } from '@/lib/logger'
import { privateFeedService, type PrivateFeedResult } from './private-feed-service'
import {
  activeGrants, fetchCurrentFeed, fetchFeeds, fetchFollowRequestsTo, fetchGrant, fetchMembers, fetchRekeys, grantIsRevoked, mainFeeds,
  type PrivateFeedDocument,
} from './private-feed-reads'
import { clearMove, loadMove, moveProgress, saveMove, type MoveJob } from './private-feed-move-job'
import { identityService } from './identity-service'
import { isAppConnectBuild } from '@/lib/app-connect/config'
import { resolveEncryptionPublicKey } from '@/lib/crypto/encryption-key-lookup'
import { normalizeBytes } from '@/lib/bytes'
import { scopedKey } from '@/lib/storage-scope'
import { cekAt, DEFAULT_FEED_CAPS, historyKey, MAX_TREE_CAPACITY, type CarriedFeed } from '@/lib/private-feed/crypto'

/** Measured on sakura (docs/SOCIAL_V17.md): a grant 51–76M credits, a new feed 24–39M. Estimates sit at the upper middle. */
const GRANT_CREDITS = 65_000_000
const FEED_CREDITS = 35_000_000
/** 1M credits ≈ 0.06¢ (1 DASH = 1e11 credits at $60). */
const USD_PER_CREDIT = 60 / 1e11

export interface RenewalEstimate {
  followers: number
  credits: number
  usd: number
}

/** What renewing would move and roughly cost (PF3: "Moving your N followers costs about $X"). */
export async function estimateRenewal(ownerId: string): Promise<RenewalEstimate> {
  const followers = (await movableFollowers(ownerId, (await currentMainFeed(ownerId)).feed)).length
  const credits = FEED_CREDITS + followers * GRANT_CREDITS
  return { followers, credits, usd: credits * USD_PER_CREDIT }
}

async function currentMainFeed(ownerId: string): Promise<PrivateFeedDocument> {
  const feed = await fetchCurrentFeed(ownerId, { fresh: true })
  if (!feed) throw new Error('You have no private feed to renew.')
  return feed
}

/** Everyone `ownerId` blocks themselves: never carried into a renewed feed, even when the block's revocation failed. */
async function blockedBy(ownerId: string): Promise<Set<string>> {
  const { blockService } = await import('./block-service')
  return new Set((await blockService.getUserBlocks(ownerId)).map((block) => block.blockedId))
}

/**
 * The members of `feed` to move: grants in force (a revoked grant stays as a
 * record, never a member) whose holder still stands by their request (PF8)
 * and is not blocked by the owner, in leaf order.
 */
async function movableFollowers(ownerId: string, feed: number): Promise<string[]> {
  const [grants, rekeys, requests, blocked] = await Promise.all([fetchMembers(ownerId, feed), fetchRekeys(ownerId, feed, 1), fetchFollowRequestsTo(ownerId), blockedBy(ownerId)])
  const asking = new Set(requests.map((request) => request.$ownerId))
  return activeGrants(grants, rekeys).filter((grant) => asking.has(grant.recipientId) && !blocked.has(grant.recipientId)).map((grant) => grant.recipientId)
}

/**
 * Whether a renewal can bring older posts along: `yes` when this device can
 * open the current feed's seed, `no` only when the seed is sealed to an
 * encryption key this owner no longer holds (PF5), `unknown` otherwise (no
 * key entered yet, or a read failed): the choice is still offered then, and
 * the renewal itself finds out.
 */
export async function canBringHistory(ownerId: string, encryptionPrivateKey?: Uint8Array): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const synced = await privateFeedService.ownerFeedState(ownerId, encryptionPrivateKey)
    if (synced.success) return 'yes'
    return synced.errorCode === 'KEY_CHANGED' ? 'no' : 'unknown'
  } catch {
    return 'unknown'
  }
}

export type MoveListener = (progress: { done: number; total: number }) => void

/**
 * Renew `ownerId`'s private feed: open the next feed (with a history link when
 * `bringHistory` and the current seed opens), then move every follower.
 * Doubles the tree when the followers fill more than half of it.
 */
export async function renewPrivateFeed(
  ownerId: string, encryptionPrivateKey: Uint8Array, options: { bringHistory: boolean }, onProgress?: MoveListener,
): Promise<PrivateFeedResult & { historyLinked?: boolean }> {
  if (loadMove(ownerId)) return { success: false, error: 'Your followers are still being moved. Continue that first.' }
  try {
    const current = await currentMainFeed(ownerId)
    let carryFrom: CarriedFeed | undefined
    if (options.bringHistory) {
      const synced = await privateFeedService.ownerFeedState(ownerId, encryptionPrivateKey)
      if (synced.success) {
        const { keys } = synced.state
        carryFrom = { feed: current.feed, finalKeyGeneration: keys.keyGeneration, cek: cekAt(keys.seed, keys.maxKeyGeneration, keys.keyGeneration), history: historyKey(keys.seed) }
      } else if (synced.errorCode !== 'KEY_CHANGED') {
        return synced
      }
    }
    const recipients = await movableFollowers(ownerId, current.feed)
    const treeCapacity = recipients.length > current.treeCapacity / 2 ? Math.min(current.treeCapacity * 2, MAX_TREE_CAPACITY) : current.treeCapacity
    const opened = await privateFeedService.openFeed(ownerId, encryptionPrivateKey, {
      carryFrom, caps: { treeCapacity: Math.max(treeCapacity, DEFAULT_FEED_CAPS.treeCapacity), maxKeyGeneration: DEFAULT_FEED_CAPS.maxKeyGeneration },
    })
    if (!opened.success || !opened.feed) return opened
    saveMove({ ownerId, from: current.feed, to: opened.feed.feed, recipients, done: [], skipped: [], deleteOldGrants: carryFrom !== undefined })
    const moved = await runMove(ownerId, encryptionPrivateKey, onProgress)
    return { ...moved, historyLinked: carryFrom !== undefined }
  } catch (error) {
    logger.error('Error renewing private feed:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Could not renew your private feed.' }
  }
}

/** The 33-byte key to seal `recipientId`'s grant to, or null when they have none. */
async function recipientKey(recipientId: string, requestKey?: Uint8Array): Promise<Uint8Array | null> {
  // Legacy builds may take the key the request carries; App Connect builds read the anchor's current key.
  if (requestKey && !isAppConnectBuild()) return normalizeBytes(requestKey)
  return resolveEncryptionPublicKey(recipientId, async () => (await identityService.getIdentity(recipientId, { fresh: true }))?.publicKeys ?? null)
}

// Followers a move left behind (no encryption key), per move, so a later look does not adopt them again.
const leftBehindKey = (job: Pick<MoveJob, 'ownerId' | 'from' | 'to'>) => scopedKey(`yappr_pf_move_left:${job.ownerId}:${job.from}:${job.to}`)

function leftBehind(job: Pick<MoveJob, 'ownerId' | 'from' | 'to'>): string[] {
  try {
    const raw = typeof window === 'undefined' ? null : window.localStorage.getItem(leftBehindKey(job))
    return raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    return []
  }
}

function rememberLeftBehind(job: Pick<MoveJob, 'ownerId' | 'from' | 'to'>, ids: string[]): void {
  try {
    window.localStorage.setItem(leftBehindKey(job), JSON.stringify(ids))
  } catch {
    // only spares a later look one pass over them
  }
}

const running = new Map<string, Promise<PrivateFeedResult>>()

/** Continue this device's follower move for `ownerId` (one run at a time per owner). */
export function runMove(ownerId: string, encryptionPrivateKey?: Uint8Array, onProgress?: MoveListener): Promise<PrivateFeedResult> {
  const inFlight = running.get(ownerId)
  if (inFlight) return inFlight
  const run = moveFollowers(ownerId, encryptionPrivateKey, onProgress).finally(() => running.delete(ownerId))
  running.set(ownerId, run)
  return run
}

async function moveFollowers(ownerId: string, encryptionPrivateKey?: Uint8Array, onProgress?: MoveListener): Promise<PrivateFeedResult> {
  const saved = loadMove(ownerId)
  if (!saved) return { success: true }
  let job: MoveJob = { ...saved, error: undefined }
  // A removal elsewhere in this tab (a block, the followers list) marks its follower skipped in the saved job.
  const mergeSkipped = () => {
    const skippedElsewhere = (loadMove(ownerId)?.skipped ?? []).filter((id) => !job.skipped.includes(id) && !job.done.includes(id))
    if (skippedElsewhere.length > 0) job = { ...job, skipped: [...job.skipped, ...skippedElsewhere] }
  }
  const pause = (error: string): PrivateFeedResult => {
    mergeSkipped()
    saveMove({ ...job, error })
    return { success: false, error }
  }
  const settle = (list: 'done' | 'skipped', recipientId: string) => {
    job = { ...job, [list]: [...job[list], recipientId] }
  }
  try {
    const synced = await privateFeedService.ownerFeedState(ownerId, encryptionPrivateKey)
    if (!synced.success) return pause(synced.errorCode === 'SYNC_REQUIRED' ? 'Enter your encryption key to finish moving your followers.' : synced.error ?? 'The move paused.')
    if (synced.state.feed.feed !== job.to) {
      clearMove(ownerId)
      return { success: false, error: 'Your private feed was renewed again on another device. Move your followers from there.' }
    }
    const [requests, existing, blocked] = await Promise.all([fetchFollowRequestsTo(ownerId), fetchMembers(ownerId, job.to), blockedBy(ownerId)])
    // Anyone who joined the old feed since the move was planned moves too.
    const joined = (await movableFollowers(ownerId, job.from)).filter((id) => !job.recipients.includes(id))
    if (joined.length > 0) job = { ...job, recipients: [...job.recipients, ...joined] }
    const requestOf = new Map(requests.map((request) => [request.$ownerId, request]))
    const grantedTo = new Map(existing.map((grant) => [grant.recipientId, grant]))
    const taken = new Set(existing.map((grant) => grant.leafIndex))
    const capacity = synced.state.feed.treeCapacity
    const isTaken = (leaf: number) => leaf >= capacity || taken.has(leaf)
    // Follower i takes leaf i, unless someone approved meanwhile (on a device without this job) holds it.
    const leafFor = (planned: number) => {
      let leaf = planned
      for (let candidate = 0; isTaken(leaf) && candidate < capacity; candidate++) leaf = candidate
      return isTaken(leaf) ? null : leaf
    }
    for (const [planned, recipientId] of job.recipients.entries()) {
      mergeSkipped()
      if (job.done.includes(recipientId) || job.skipped.includes(recipientId)) continue
      const already = grantedTo.get(recipientId)
      if (already) {
        // Granted by an earlier run (or device): removed from the old feed since, the new grant goes back.
        const source = await fetchGrant(ownerId, job.from, recipientId)
        if (source && (await grantIsRevoked(source)) && !(await grantIsRevoked(already))) {
          const back = await privateFeedService.revokeLeaf(ownerId, synced.state.feed, already.leafIndex, encryptionPrivateKey)
          if (!back.success) return pause(back.error ?? 'The move paused.')
          settle('skipped', recipientId)
        } else settle('done', recipientId)
      } else {
        // Re-read their old grant and its revocations now: removed since the plan, on any device, they stay behind.
        const source = await fetchGrant(ownerId, job.from, recipientId)
        const stillMember = source !== null && !blocked.has(recipientId) && !(await grantIsRevoked(source))
        const request = requestOf.get(recipientId)
        const key = stillMember && request ? await recipientKey(recipientId, request.publicKey) : null
        const leafIndex = leafFor(planned)
        if (!key) settle('skipped', recipientId)
        else if (leafIndex === null) return pause('Your renewed private feed is full.')
        else {
          const outcome = await privateFeedService.writeGrant(ownerId, synced.state, recipientId, key, leafIndex)
          if (outcome.success) {
            taken.add(leafIndex)
            // Removed while their grant was being written: revoke exactly the grant just written, or pause (a later run re-checks).
            if (source && (await grantIsRevoked(source))) {
              const back = await privateFeedService.revokeLeaf(ownerId, synced.state.feed, leafIndex, encryptionPrivateKey)
              if (!back.success) return pause(back.error ?? 'The move paused.')
              settle('skipped', recipientId)
            } else settle('done', recipientId)
          } else if (outcome.errorCode === 'REQUEST_WITHDRAWN') settle('skipped', recipientId)
          else if (await fetchGrant(ownerId, job.to, recipientId)) settle('done', recipientId)
          else return pause(outcome.error ?? 'The move paused.')
        }
      }
      mergeSkipped()
      saveMove(job)
      onProgress?.(moveProgress(job))
    }
    if (job.deleteOldGrants) {
      // PF6: the moved followers read the old feed through the history link now. Grants of
      // removed followers stay: they are the record that their request was answered.
      const moved = new Set(job.done)
      const old = (await fetchMembers(ownerId, job.from)).filter((grant) => moved.has(grant.recipientId))
      const deleted = await privateFeedService.deleteGrants(ownerId, old)
      if (deleted < old.length) return pause('Some of your old feed\'s access could not be cleaned up yet.')
    }
    if (job.skipped.length > 0) rememberLeftBehind(job, job.skipped)
    clearMove(ownerId)
    return { success: true }
  } catch (error) {
    logger.error('Error moving private followers:', error)
    return pause(error instanceof Error ? error.message : 'The move paused.')
  }
}

/**
 * A move that no device finished, read off the chain (a crash before the job
 * was saved, or a move begun on another device): followers in force of the
 * previous feed who still stand by their request and have no grant in the
 * current one. Saves it as this device's job, paused until it runs; returns
 * how many are left.
 */
export async function adoptUnfinishedMove(ownerId: string): Promise<number> {
  const existing = loadMove(ownerId)
  if (existing) return moveProgress(existing).total - moveProgress(existing).done
  const [current, previous] = mainFeeds(await fetchFeeds(ownerId, { fresh: true }))
  if (!current || !previous) return 0
  const [recipients, moved, requests] = await Promise.all([movableFollowers(ownerId, previous.feed), fetchMembers(ownerId, current.feed), fetchFollowRequestsTo(ownerId)])
  const granted = new Set(moved.map((grant) => grant.recipientId))
  const requestOf = new Map(requests.map((request) => [request.$ownerId, request]))
  // Left behind here, or with no encryption key to seal a grant to (every device would only skip them again).
  const behind = new Set(leftBehind({ ownerId, from: previous.feed, to: current.feed }))
  const behindBefore = behind.size
  for (const recipientId of recipients) {
    if (granted.has(recipientId) || behind.has(recipientId)) continue
    if (!(await recipientKey(recipientId, requestOf.get(recipientId)?.publicKey))) behind.add(recipientId)
  }
  if (behind.size > behindBefore) rememberLeftBehind({ ownerId, from: previous.feed, to: current.feed }, [...behind])
  const left = recipients.filter((recipientId) => !granted.has(recipientId) && !behind.has(recipientId))
  if (left.length === 0) return 0
  saveMove({
    ownerId, from: previous.feed, to: current.feed, recipients,
    done: recipients.filter((id) => granted.has(id)), skipped: recipients.filter((id) => behind.has(id)),
    deleteOldGrants: current.carry !== undefined, error: 'Some of your followers have not been moved to your renewed private feed yet.',
  })
  return left.length
}
