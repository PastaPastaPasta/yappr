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
import { fetchFeeds, fetchFollowRequestsTo, fetchGrant, fetchMembers, type PrivateFeedDocument } from './private-feed-reads'
import { clearMove, loadMove, moveProgress, saveMove, type MoveJob } from './private-feed-move-job'
import { identityService } from './identity-service'
import { isAppConnectBuild } from '@/lib/app-connect/config'
import { resolveEncryptionPublicKey } from '@/lib/crypto/encryption-key-lookup'
import { normalizeBytes } from '@/lib/bytes'
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
  const followers = (await movableFollowers(ownerId, await currentMainFeed(ownerId))).length
  const credits = FEED_CREDITS + followers * GRANT_CREDITS
  return { followers, credits, usd: credits * USD_PER_CREDIT }
}

async function currentMainFeed(ownerId: string): Promise<PrivateFeedDocument> {
  const feed = (await fetchFeeds(ownerId, { fresh: true })).find((doc) => doc.audience === undefined)
  if (!feed) throw new Error('You have no private feed to renew.')
  return feed
}

/** The members of `feed` that still stand by their request (PF8), in leaf order. */
async function movableFollowers(ownerId: string, feed: PrivateFeedDocument): Promise<string[]> {
  const [members, requests] = await Promise.all([fetchMembers(ownerId, feed.feed), fetchFollowRequestsTo(ownerId)])
  const asking = new Set(requests.map((request) => request.$ownerId))
  return members.filter((grant) => asking.has(grant.recipientId)).sort((a, b) => a.leafIndex - b.leafIndex).map((grant) => grant.recipientId)
}

/** Whether a renewal can bring older posts along: this device can open the current feed's seed. */
export async function canBringHistory(ownerId: string, encryptionPrivateKey?: Uint8Array): Promise<boolean> {
  try {
    const synced = await privateFeedService.ownerFeedState(ownerId, encryptionPrivateKey)
    return synced.success
  } catch {
    return false
  }
}

export type MoveListener = (progress: { done: number; total: number }) => void

/**
 * Renew `ownerId`'s private feed: open the next feed (with a history link when
 * `bringHistory` and this device holds the current seed), then move every
 * follower. Doubles the tree when the followers fill more than half of it.
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
    const recipients = await movableFollowers(ownerId, current)
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
  let job: MoveJob = saved
  const pause = (error: string): PrivateFeedResult => {
    saveMove({ ...job, error })
    return { success: false, error }
  }
  const settle = (list: 'done' | 'skipped', recipientId: string) => {
    job = { ...job, [list]: [...job[list], recipientId] }
  }
  try {
    const synced = await privateFeedService.ownerFeedState(ownerId, encryptionPrivateKey)
    if (!synced.success) return synced.errorCode === 'SYNC_REQUIRED' ? synced : pause(synced.error ?? 'The move paused.')
    if (synced.state.feed.feed !== job.to) {
      clearMove(ownerId)
      return { success: false, error: 'Your private feed was renewed again on another device. Move your followers from there.' }
    }
    const [requests, existing] = await Promise.all([fetchFollowRequestsTo(ownerId), fetchMembers(ownerId, job.to)])
    const requestOf = new Map(requests.map((request) => [request.$ownerId, request]))
    const granted = new Set(existing.map((grant) => grant.recipientId))
    const taken = new Set(existing.map((grant) => grant.leafIndex))
    // Follower i takes leaf i, unless someone approved meanwhile (on a device without this job) holds it.
    const leafFor = (planned: number) => {
      let leaf = planned
      for (let candidate = 0; taken.has(leaf) && candidate < synced.state.feed.treeCapacity; candidate++) leaf = candidate
      return taken.has(leaf) ? null : leaf
    }
    job = { ...job, error: undefined }
    for (const [planned, recipientId] of job.recipients.entries()) {
      if (job.done.includes(recipientId) || job.skipped.includes(recipientId)) continue
      if (granted.has(recipientId)) settle('done', recipientId)
      else {
        const request = requestOf.get(recipientId)
        const key = request ? await recipientKey(recipientId, request.publicKey) : null
        const leafIndex = leafFor(planned)
        if (!key) settle('skipped', recipientId)
        else if (leafIndex === null) return pause('Your renewed private feed is full.')
        else {
          const outcome = await privateFeedService.writeGrant(ownerId, synced.state, recipientId, key, leafIndex)
          if (outcome.success) taken.add(leafIndex)
          if (outcome.success) settle('done', recipientId)
          else if (outcome.errorCode === 'REQUEST_WITHDRAWN') settle('skipped', recipientId)
          else if (await fetchGrant(ownerId, job.to, recipientId)) settle('done', recipientId)
          else return pause(outcome.error ?? 'The move paused.')
        }
      }
      saveMove(job)
      onProgress?.(moveProgress(job))
    }
    if (job.deleteOldGrants) {
      const old = await fetchMembers(ownerId, job.from)
      const deleted = await privateFeedService.deleteGrants(ownerId, old)
      if (deleted < old.length) return pause('Some of your old feed\'s access could not be cleaned up yet.')
    }
    clearMove(ownerId)
    return { success: true }
  } catch (error) {
    logger.error('Error moving private followers:', error)
    return pause(error instanceof Error ? error.message : 'The move paused.')
  }
}

/**
 * A move that no device finished, read off the chain (a crash before the job
 * was saved, or a move begun on another device): followers of the previous
 * feed who still stand by their request and have no grant in the current one.
 * Resumes it as this device's job; returns how many are left.
 */
export async function adoptUnfinishedMove(ownerId: string): Promise<number> {
  if (loadMove(ownerId)) return moveProgress(loadMove(ownerId) as MoveJob).total
  const main = (await fetchFeeds(ownerId, { fresh: true })).filter((doc) => doc.audience === undefined)
  const [current, previous] = main
  if (!current || !previous) return 0
  const [recipients, moved] = await Promise.all([movableFollowers(ownerId, previous), fetchMembers(ownerId, current.feed)])
  const granted = new Set(moved.map((grant) => grant.recipientId))
  const left = recipients.filter((recipientId) => !granted.has(recipientId))
  if (left.length === 0) return 0
  saveMove({ ownerId, from: previous.feed, to: current.feed, recipients, done: recipients.filter((id) => granted.has(id)), skipped: [], deleteOldGrants: current.carry !== undefined })
  return left.length
}
