/**
 * Group membership, owner side and member side (docs/DM_V5.md §4.4, §6.4,
 * §6.5).
 *
 * Every owner write runs the one repair loop (§6.5): read the roster and walk
 * the keyrings to the newest; if the newest keyring's base is ahead of the
 * roster (an earlier roster replace failed), rebuild the member list from the
 * slots in that keyring and replace the roster first; then make the change,
 * and re-run on a stale (40106) or duplicate (40105) refusal. The owner never
 * grants or writes a keyring from a roster behind the newest keyring.
 */

import { bytesEqual } from '@/lib/bytes'
import { weekOf } from '@/lib/dm/kdf'
import { deriveBaseKey, deriveEpochKey, deriveGroupId, deriveGroupSecret } from '@/lib/dm/keys'
import {
  MAX_GROUP_MEMBERS,
  buildKeyring,
  encryptRoster,
  keyringHandle,
  keyringNonce,
  logEpoch,
  openKeyringSlot,
  rosterHandle,
} from '@/lib/dm/group'
import type { Epoch, GroupConversation, IdentityId, KeyringMember, RosterContent } from '@/lib/dm/types'
import { logger } from '@/lib/logger'
import { isMember, markStale, newGroupConv, type GroupConv } from './conversation'
import { attachGroup, curWeek, groupConv, isMe, peerKey, type Backoff, type DmContext } from './context'
import { ensureStarted, openDirect, startedDirect } from './directs'
import { applyGroups, markApplied, switchEpoch } from './group-apply'
import { sendContent } from './sender'
import type { WriteFailure, WriteOutcome } from './types'
import { nonceBackoffMs, realSleep, withNonceRetry } from './write-failure'
import { TAGS_PER_QUERY, hexId, includesId, range } from './util'

const MAX_OWNER_ROUNDS = 6
/** Transport failures one owner write retries (each re-reads the group first). */
const MAX_TRANSPORT_RETRIES = 2
/** Background owner work (removing a member who left, repairing a roster) retries on the poll cadence: 30 s, doubling, at most 5 min. */
const OWNER_RETRY_BASE_MS = 30_000
const OWNER_RETRY_MAX_MS = 5 * 60_000
const MAX_NAME_BYTES = 200

export class GroupError extends Error {}

// ---------------------------------------------------------------------------
// Owner keys

/** `K[b, r]` as the owner derives it from `S` and keyring `b`'s nonce. */
function ownerKey(conv: GroupConv, epoch: Epoch): Uint8Array {
  if (!conv.secret) throw new GroupError('Only the group owner can do this.')
  if (epoch.b === 0) return deriveEpochKey(conv.secret, 0, epoch.r)
  const keyring = conv.keyrings.get(epoch.b)
  const nonce = keyring ? keyringNonce(keyring) : null
  if (!nonce) throw new GroupError(`Keyring ${epoch.b} is missing`)
  return deriveEpochKey(conv.secret, epoch.b, epoch.r, nonce)
}

/** Returns the group secret `S`. */
function requireOwner(ctx: DmContext, conv: GroupConv): Uint8Array {
  if (!isMe(ctx, conv.owner) || !conv.secret) throw new GroupError('Only the group owner can do this.')
  if (conv.ended) throw new GroupError('This group has ended.')
  return conv.secret
}

/** The saved entry of a group I own, from its first epoch. */
function ownedGroupEntry(ctx: DmContext, gid: Uint8Array, since: number, readAt: number): GroupConversation {
  const secret = deriveGroupSecret(ctx.me.encPriv, gid)
  return { gid, owner: ctx.me.id, earliestEpoch: { b: 0, r: 0 }, earliestKey: deriveBaseKey(secret, 0), since, readAt, hiddenAt: 0, anchorChangedAt: 0 }
}

function checkName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new GroupError('Give the group a name.')
  if (new TextEncoder().encode(trimmed).length > MAX_NAME_BYTES) throw new GroupError('That name is too long.')
  return trimmed
}

async function publicKeysOf(ctx: DmContext, ids: IdentityId[]): Promise<KeyringMember[]> {
  const out: KeyringMember[] = []
  for (const id of ids) {
    const publicKey = await peerKey(ctx, id)
    if (!publicKey) throw new GroupError('A member has no encryption key, so they cannot be added to groups.')
    out.push({ id, publicKey })
  }
  return out
}

// ---------------------------------------------------------------------------
// The repair loop (§6.5)

/**
 * Write one of my group documents (create, or replace `before`) and settle a
 * result that is uncertain (the DAPI timeout) by reading its handle back.
 * Only these exact bytes count as landed: every seal draws a fresh IV, so my
 * other device's write never matches. A different document there means a
 * competing write won, reported as `stale` (a replace) or `duplicate` (a
 * create), so the owner loop re-runs on it (§6.5). Nothing new yet: the same
 * bytes are broadcast once more, so a late landing of the first reads as
 * landed, and any refusal of that rebroadcast is read back the same way (it is
 * usually the first broadcast having landed). If the rebroadcast is uncertain
 * too and still nothing is visible, the write is reported lost (`stale` or
 * `duplicate`) and never taken on trust: the owner loop re-reads and, for a
 * keyring, builds a fresh one with a new nonce. A late landing of the lost one
 * then refuses the new create (40105), and the loop reads it back and adopts
 * whatever is really on chain.
 */
async function writeGroupDoc(ctx: DmContext, handle: Uint8Array, blob: Uint8Array, before: { id: string; revision: number } | null): Promise<WriteOutcome> {
  const write = () => withNonceRetry(() => (before ? ctx.chain.replaceGroupDoc(before, handle, blob) : ctx.chain.createGroupDoc(handle, blob)), ctx.sleep)
  const lost: WriteFailure = before ? 'stale' : 'duplicate'
  let outcome = await write()
  for (let rebroadcast = false; ; rebroadcast = true) {
    const uncertain = outcome.ok && !outcome.confirmed
    // Any refusal of the rebroadcast may be the first broadcast having landed: check it the same way.
    const refusedAfterUncertain = rebroadcast && !outcome.ok
    if (!uncertain && !refusedAfterUncertain) return outcome
    const [doc] = await ctx.chain.groupDocs(ctx.me.id, [handle])
    if (doc && bytesEqual(doc.blob, blob)) return { ok: true, id: doc.id, confirmed: true }
    if (refusedAfterUncertain) return outcome
    if (doc && (!before || doc.id !== before.id || doc.revision > before.revision)) {
      return { ok: false, failure: lost, error: 'Another device changed the group first.' }
    }
    if (rebroadcast) return { ok: false, failure: lost, error: 'The group change is not visible yet.' }
    outcome = await write()
  }
}

/**
 * The week `epoch` started: its keyring's for a new base (members switch on
 * the keyring, before the roster lands), else now.
 */
function epochStartWeek(ctx: DmContext, conv: GroupConv, epoch: Epoch): number {
  const keyringAt = epoch.r === 0 ? conv.keyringAt.get(epoch.b) : undefined
  return keyringAt !== undefined ? weekOf(keyringAt) : curWeek(ctx)
}

/** Write the roster (create or replace) at `rosterContent`'s epoch, logging the epoch if it is new (§5.4). */
async function writeRoster(ctx: DmContext, conv: GroupConv, rosterContent: RosterContent): Promise<WriteOutcome> {
  const content = { ...rosterContent, epochLog: logEpoch(rosterContent.epochLog, rosterContent, epochStartWeek(ctx, conv, rosterContent)) }
  const blob = await encryptRoster(ownerKey(conv, content), conv.gid, content)
  const before = conv.roster
  const outcome = await writeGroupDoc(ctx, rosterHandle(conv.gid), blob, before)
  if (outcome.ok) {
    conv.roster = { id: before?.id ?? outcome.id, revision: (before?.revision ?? 0) + 1, blob }
    conv.lastRoster = content
    conv.keys.set(content, ownerKey(conv, content))
    switchEpoch(ctx, conv, content)
    if (content.ended) conv.ended = true
  }
  return outcome
}

/**
 * The roster's members who still hold a slot in keyring `b` (the owner tests
 * each pad). Null when a member's key could not be fetched (a failed lookup,
 * not an identity without a key): whether they hold a slot is unknown, and a
 * roster written now would drop a live member.
 */
async function survivorsOf(ctx: DmContext, conv: GroupConv, b: number, candidates: IdentityId[]): Promise<IdentityId[] | null> {
  const keyring = conv.keyrings.get(b)
  if (!keyring) return candidates
  const out: IdentityId[] = [conv.owner]
  for (const id of candidates) {
    if (bytesEqual(id, conv.owner)) continue
    const publicKey = await peerKey(ctx, id)
    if (!publicKey && !ctx.peerKeys.has(hexId(id))) return null
    if (!publicKey) continue
    const slot = openKeyringSlot(keyring, { myPrivateKey: ctx.me.encPriv, otherPublicKey: publicKey, gid: conv.gid, ownerId: conv.owner, memberId: id, b })
    if (slot) out.push(id)
  }
  return out
}

type Change = (current: RosterContent) => Promise<WriteOutcome | 'noop'>

/**
 * OWNER_WRITE (§6.5). `change` sees a roster at the newest epoch and returns
 * its last write's outcome; a stale or duplicate refusal re-runs the loop (up
 * to the round cap). A transport failure re-runs it too, after a short
 * backoff, at most twice; any other refusal (too few credits, say) throws at
 * once, since retrying only burns fees. Every round re-reads first, so a
 * keyring that landed before a failed roster write is repaired rather than
 * written twice. If the group cannot be re-read, the last roster held stays.
 * `endsGroup` marks the end itself: finding the roster already ended on a
 * re-run means an earlier uncertain tombstone landed, which is success.
 */
async function ownerWrite(ctx: DmContext, conv: GroupConv, change: Change, endsGroup = false): Promise<void> {
  try {
    await ownerWriteRounds(ctx, conv, change, endsGroup)
  } catch (error) {
    // Whatever landed before the failure (a keyring, say) is not reflected yet: re-read before any send.
    markStale(conv)
    throw error
  }
}

async function ownerWriteRounds(ctx: DmContext, conv: GroupConv, change: Change, endsGroup: boolean): Promise<void> {
  let transportRetries = 0
  // Stale and duplicate refusals re-run the loop; a transport failure may re-run it twice; the rest throw.
  const refused = async (outcome: { ok: false; failure: WriteFailure; error: string }): Promise<void> => {
    if (outcome.failure === 'stale' || outcome.failure === 'duplicate' || outcome.failure === 'nonce') return
    if (outcome.failure !== 'transport' || transportRetries >= MAX_TRANSPORT_RETRIES) throw new GroupError(outcome.error)
    await (ctx.sleep ?? realSleep)(nonceBackoffMs(transportRetries++))
  }
  for (let round = 0; round < MAX_OWNER_ROUNDS; round++) {
    const held = { roster: conv.roster, lastRoster: conv.lastRoster }
    conv.lastRoster = null
    conv.roster = null
    await applyGroups(ctx, [conv])
    const roster = conv.lastRoster as RosterContent | null
    if (!roster) {
      Object.assign(conv, held)
      throw new GroupError('The group roster could not be read.')
    }
    if (roster.ended) {
      if (endsGroup) return
      throw new GroupError('This group has ended.')
    }
    if (conv.epoch.b > roster.b) {
      // Every base the failed replaces skipped goes into the log too, so their history is found (§5.4).
      let epochLog = roster.epochLog
      for (let b = roster.b + 1; b < conv.epoch.b; b++) epochLog = logEpoch(epochLog, { b, r: 0 }, epochStartWeek(ctx, conv, { b, r: 0 }))
      const members = await survivorsOf(ctx, conv, conv.epoch.b, roster.members)
      if (!members) throw new GroupError('A member\'s key could not be fetched; the group will be repaired on a later poll.')
      const outcome = await writeRoster(ctx, conv, { ...roster, b: conv.epoch.b, r: 0, members, epochLog })
      if (!outcome.ok) await refused(outcome)
      continue
    }
    const outcome = await change(roster)
    if (outcome === 'noop' || outcome.ok) return
    await refused(outcome)
  }
  throw new GroupError('The group changed on another device while saving. Try again.')
}

// ---------------------------------------------------------------------------
// Grants

async function grant(ctx: DmContext, conv: GroupConv, member: IdentityId, epoch: Epoch): Promise<void> {
  const direct = await startedDirect(ctx, member)
  await sendContent(ctx, direct, { type: 'grant', grant: { gid: conv.gid, b: epoch.b, r: epoch.r, key: ownerKey(conv, epoch) } })
}

/** Grant to several members, reporting the ones that failed rather than stopping at the first. */
async function grantAll(ctx: DmContext, conv: GroupConv, memberIds: IdentityId[], epoch: Epoch): Promise<IdentityId[]> {
  const failed: IdentityId[] = []
  for (const member of memberIds) {
    try {
      await grant(ctx, conv, member, epoch)
    } catch (error) {
      logger.warn(`DM v5: grant to ${hexId(member)} failed:`, error)
      failed.push(member)
    }
  }
  return failed
}

// ---------------------------------------------------------------------------
// Owner operations

/** The first group number at or after the saved one whose roster handle is free (§4.4: `n` is never reused). */
async function freeGroupNumber(ctx: DmContext): Promise<number> {
  for (let start = ctx.store.state.nextGroupNumber; ; start += TAGS_PER_QUERY) {
    const ns = range(start, start + TAGS_PER_QUERY - 1)
    const handles = ns.map((n) => rosterHandle(deriveGroupId(ctx.me.selfRoot, n)))
    const taken = new Set((await ctx.chain.groupDocs(ctx.me.id, handles)).map((doc) => hexId(doc.handle)))
    const free = ns.find((_, i) => !taken.has(hexId(handles[i])))
    if (free !== undefined) return free
  }
}

export interface CreatedGroup {
  conv: GroupConv
  /** Members whose grant could not be sent; "Resend keys" retries them. */
  failed: IdentityId[]
}

/** Create a group (§6.4): one roster create, then a grant to each member on the owner's 1:1 stream. */
export async function createGroup(ctx: DmContext, name: string, memberIds: IdentityId[]): Promise<CreatedGroup> {
  const cleanName = checkName(name)
  const others = memberIds.filter((id, i) => !isMe(ctx, id) && memberIds.findIndex((o) => bytesEqual(o, id)) === i)
  if (others.length === 0) throw new GroupError('Pick at least one member.')
  if (others.length + 1 > MAX_GROUP_MEMBERS) throw new GroupError(`A group can have at most ${MAX_GROUP_MEMBERS} members.`)
  await publicKeysOf(ctx, others)

  for (let attempt = 0; attempt < MAX_OWNER_ROUNDS; attempt++) {
    const n = await freeGroupNumber(ctx)
    const gid = deriveGroupId(ctx.me.selfRoot, n)
    const now = ctx.chain.now()
    const entry = ownedGroupEntry(ctx, gid, weekOf(now), now)
    const conv = newGroupConv(entry, deriveGroupSecret(ctx.me.encPriv, gid))
    const content: RosterContent = { b: 0, r: 0, name: cleanName, avatarRef: '', members: [ctx.me.id, ...others], ended: false, epochLog: [] }
    const outcome = await writeRoster(ctx, conv, content)
    ctx.store.claimGroupNumber(n)
    if (!outcome.ok) {
      if (outcome.failure === 'duplicate') continue // another device took n
      throw new GroupError(outcome.error)
    }
    conv.live = true
    markApplied(ctx, conv)
    ctx.store.addGroup(entry)
    conv.entry = ctx.store.resolve(entry)
    ctx.convs.set(conv.key, conv)
    // Every member's 1:1 (and its invite, if new) first, then ONE self-state save, then the grants.
    const failed: IdentityId[] = []
    const reachable: IdentityId[] = []
    for (const member of others) {
      try {
        await ensureStarted(ctx, await openDirect(ctx, member), { save: false })
        reachable.push(member)
      } catch (error) {
        logger.warn(`DM v5: starting a 1:1 with ${hexId(member)} failed:`, error)
        failed.push(member)
      }
    }
    await ctx.store.flush()
    failed.push(...(await grantAll(ctx, conv, reachable, { b: 0, r: 0 })))
    return { conv, failed }
  }
  throw new GroupError('Could not reserve a group number. Try again.')
}

/**
 * Add a member (§6.4): a roster replace at (b, r+1) that lists them, then the
 * grant. The key goes out only once the membership is on chain: keys are
 * deterministic per (gid, b, r), so a grant sent before a roster write that
 * never landed would hand a non-member the key the next add reuses, and every
 * key ratcheted from it.
 */
export async function addMember(ctx: DmContext, conv: GroupConv, member: IdentityId): Promise<void> {
  requireOwner(ctx, conv)
  await publicKeysOf(ctx, [member])
  // The 1:1 (and its invite, if new) first, so the grant right after the roster write rarely fails.
  await startedDirect(ctx, member)
  await ownerWrite(ctx, conv, async (roster) => {
    if (includesId(roster.members, member)) return 'noop'
    if (roster.members.length + 1 > MAX_GROUP_MEMBERS) throw new GroupError(`A group can have at most ${MAX_GROUP_MEMBERS} members.`)
    return writeRoster(ctx, conv, { ...roster, r: roster.r + 1, members: [...roster.members, member] })
  })
  // Granted whenever the roster just read lists them: a re-run that found an uncertain write landed,
  // or an add tried again after its grant failed (or the page closed before it), still sends the key.
  const roster = conv.lastRoster
  if (!roster || !includesId(roster.members, member)) return
  try {
    await grant(ctx, conv, member, roster)
  } catch (error) {
    logger.warn(`DM v5: grant to ${hexId(member)} failed:`, error)
    throw new GroupError('They were added, but their key could not be sent. Use Resend keys.')
  }
}

/** Remove a member (§6.4): a keyring at b+1 for everyone else, then an immediate roster replace. */
export async function removeMember(ctx: DmContext, conv: GroupConv, member: IdentityId): Promise<void> {
  const secret = requireOwner(ctx, conv)
  if (bytesEqual(member, conv.owner)) throw new GroupError('The owner cannot be removed; end the group instead.')
  await ownerWrite(ctx, conv, async (roster) => {
    if (!includesId(roster.members, member)) return 'noop'
    const remaining = roster.members.filter((m) => !bytesEqual(m, member))
    const b = roster.b + 1
    const built = buildKeyring({
      ownerPrivateKey: ctx.me.encPriv,
      ownerId: ctx.me.id,
      gid: conv.gid,
      b,
      groupSecret: secret,
      members: await publicKeysOf(ctx, remaining.filter((m) => !bytesEqual(m, conv.owner))),
    })
    const keyring = await writeGroupDoc(ctx, keyringHandle(conv.gid, b), built.blob, null)
    if (!keyring.ok) return keyring
    conv.keyrings.set(b, built.blob)
    conv.keyringAt.set(b, ctx.chain.now())
    conv.keys.set({ b, r: 0 }, built.baseKey)
    // The removed member has no key for base b: move to it now, before the roster replace, so a
    // send in between never goes out on the old base, whether or not the replace lands.
    switchEpoch(ctx, conv, { b, r: 0 })
    return writeRoster(ctx, conv, { ...roster, b, r: 0, members: remaining })
  })
}

/** Rename (§6.4): one roster replace at the current epoch. */
export async function renameGroup(ctx: DmContext, conv: GroupConv, name: string): Promise<void> {
  requireOwner(ctx, conv)
  const cleanName = checkName(name)
  await ownerWrite(ctx, conv, async (roster) => (roster.name === cleanName ? 'noop' : writeRoster(ctx, conv, { ...roster, name: cleanName })))
}

/**
 * End the group (§6.4, owner leaves): the roster becomes a tombstone. It keeps
 * the member list, so every device can still find the group's history.
 */
export async function endGroup(ctx: DmContext, conv: GroupConv): Promise<void> {
  requireOwner(ctx, conv)
  await ownerWrite(ctx, conv, async (roster) => writeRoster(ctx, conv, { ...roster, ended: true }), true)
}

/** "Resend keys" (§6.4): a fresh grant for the current epoch to one member. */
export async function resendKeys(ctx: DmContext, conv: GroupConv, member: IdentityId): Promise<void> {
  requireOwner(ctx, conv)
  await ownerWrite(ctx, conv, async (roster) => {
    if (!includesId(roster.members, member)) throw new GroupError('They are not in this group.')
    await grant(ctx, conv, member, roster)
    return 'noop'
  })
}

/** Leave (§6.4): a `0x02` on my stream; the owner's client removes me on its next poll. */
export async function leaveGroup(ctx: DmContext, conv: GroupConv): Promise<void> {
  if (isMe(ctx, conv.owner)) {
    await endGroup(ctx, conv)
    return
  }
  await sendContent(ctx, conv, { type: 'leave' })
}

/** Schedule the next attempt after a failure: 30 s, doubling, at most 5 min (chain time). */
function backOff(ctx: DmContext, backoff: Backoff): void {
  backoff.retryAt = ctx.chain.now() + Math.min(OWNER_RETRY_BASE_MS * 2 ** backoff.failures, OWNER_RETRY_MAX_MS)
  backoff.failures++
}

/**
 * The owner's client removes members who sent a leave (§6.4). A failure is
 * retried on the poll cadence (30 s, doubling to 5 min), so one transient
 * refusal does not leave the member reading for long.
 */
export async function processLeaves(ctx: DmContext, tried: Set<string> = new Set()): Promise<void> {
  if (!ctx.chain.canWrite()) return
  for (const [id, pending] of Array.from(ctx.pendingLeaves.entries())) {
    const { conv, member } = pending
    // One backoff per group, shared with the repair step: a failing group costs one attempt per window.
    const backoff = ctx.ownerRepairs.get(conv.key)
    if (tried.has(conv.key) || (backoff && backoff.retryAt > ctx.chain.now())) continue
    tried.add(conv.key)
    try {
      if (!conv.ended && isMember(conv, member, ctx.me.id)) await removeMember(ctx, conv, member)
      ctx.pendingLeaves.delete(id)
      ctx.ownerRepairs.delete(conv.key)
    } catch (error) {
      failedOwnerWork(ctx, conv.key)
      logger.warn('DM v5: removing a member who left failed:', error)
    }
  }
}

/** Record a failed background owner write on a group: its shared backoff grows. */
function failedOwnerWork(ctx: DmContext, key: string): void {
  const backoff = ctx.ownerRepairs.get(key) ?? { retryAt: 0, failures: 0 }
  backOff(ctx, backoff)
  ctx.ownerRepairs.set(key, backoff)
}

/**
 * Finish a partial removal (§6.5): a group I own whose newest keyring is
 * ahead of its roster (the roster replace after it failed, perhaps on a
 * device or page that is gone) gets the roster rebuilt from the keyring's
 * slots on the next poll, without waiting for another owner change. Until
 * then readers still list the removed member.
 */
export async function repairOwnedGroups(ctx: DmContext, tried: Set<string> = new Set()): Promise<void> {
  if (!ctx.chain.canWrite()) return
  // A group that needs no owner work any more starts its backoff afresh next time.
  const pendingLeaveGroups = new Set(Array.from(ctx.pendingLeaves.values()).map((p) => p.conv.key))
  for (const conv of Array.from(ctx.convs.values())) {
    const needsRepair = conv.kind === 'group' && !!conv.secret && !conv.ended && !!conv.lastRoster && conv.epoch.b > conv.lastRoster.b
    if (!needsRepair && !pendingLeaveGroups.has(conv.key)) ctx.ownerRepairs.delete(conv.key)
    if (conv.kind !== 'group' || !needsRepair) continue
    const backoff = ctx.ownerRepairs.get(conv.key)
    if (tried.has(conv.key) || (backoff && backoff.retryAt > ctx.chain.now())) continue
    tried.add(conv.key)
    try {
      await ownerWrite(ctx, conv, async () => 'noop')
      ctx.ownerRepairs.delete(conv.key)
    } catch (error) {
      failedOwnerWork(ctx, conv.key)
      logger.warn('DM v5: repairing a group roster failed:', error)
    }
  }
}

// ---------------------------------------------------------------------------
// Recovery (§4.4, §9.3)

/**
 * Find every group I own by probing the roster handles of `gid_0, gid_1, …`
 * in batches of 100, stopping at an empty batch. Returns how many were found.
 */
export async function recoverOwnedGroups(ctx: DmContext): Promise<number> {
  let found = 0
  for (let start = 0; ; start += TAGS_PER_QUERY) {
    const ns = range(start, start + TAGS_PER_QUERY - 1)
    const gids = ns.map((n) => deriveGroupId(ctx.me.selfRoot, n))
    const handles = gids.map((gid) => rosterHandle(gid))
    const byHandle = new Map(handles.map((handle, i) => [hexId(handle), { gid: gids[i], n: ns[i] }]))
    const docs = await ctx.chain.groupDocs(ctx.me.id, handles)
    if (docs.length === 0) return found
    for (const doc of docs) {
      const hit = byHandle.get(hexId(doc.handle))
      if (!hit) continue
      ctx.store.claimGroupNumber(hit.n)
      if (groupConv(ctx, ctx.me.id, hit.gid)) continue
      // Recovered conversations start as read (§9).
      const entry = ownedGroupEntry(ctx, hit.gid, weekOf(doc.createdAt), ctx.chain.now())
      ctx.store.addGroup(entry)
      const conv = attachGroup(ctx, ctx.store.resolve(entry))
      conv.deepProbe = true
      found++
    }
  }
}
