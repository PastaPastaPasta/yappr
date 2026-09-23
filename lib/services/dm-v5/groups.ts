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
  openKeyringSlot,
  rosterHandle,
} from '@/lib/dm/group'
import type { Epoch, GroupConversation, IdentityId, KeyringMember, RosterContent } from '@/lib/dm/types'
import { logger } from '@/lib/logger'
import { isMember, newGroupConv, type GroupConv } from './conversation'
import { attachGroup, groupConv, isMe, peerKey, type DmContext } from './context'
import { ensureStarted, openDirect, startedDirect } from './directs'
import { applyGroups, switchEpoch } from './group-apply'
import { sendContent } from './sender'
import type { WriteOutcome } from './types'
import { withNonceRetry } from './write-failure'
import { TAGS_PER_QUERY, hexId, includesId, range, sameEpoch } from './util'

const MAX_OWNER_ROUNDS = 6
const LEAVE_RETRY_MS = 30 * 60_000
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
  return { gid, owner: ctx.me.id, earliestEpoch: { b: 0, r: 0 }, earliestKey: deriveBaseKey(secret, 0), since, readAt, hiddenAt: 0 }
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

/** Write the roster (create or replace) at `content`'s epoch. */
async function writeRoster(ctx: DmContext, conv: GroupConv, content: RosterContent): Promise<WriteOutcome> {
  const blob = await encryptRoster(ownerKey(conv, content), conv.gid, content)
  const handle = rosterHandle(conv.gid)
  const roster = conv.roster
  const outcome = await withNonceRetry(
    () => (roster ? ctx.chain.replaceGroupDoc(roster, handle, blob) : ctx.chain.createGroupDoc(handle, blob)),
    ctx.sleep
  )
  if (outcome.ok) {
    conv.roster = { id: conv.roster?.id ?? outcome.id, revision: (conv.roster?.revision ?? 0) + 1 }
    conv.lastRoster = content
    conv.keys.set(content, ownerKey(conv, content))
    switchEpoch(ctx, conv, content)
    if (content.ended) conv.ended = true
  }
  return outcome
}

/** The roster's members who still hold a slot in keyring `b` (the owner tests each pad). */
async function survivorsOf(ctx: DmContext, conv: GroupConv, b: number, candidates: IdentityId[]): Promise<IdentityId[]> {
  const keyring = conv.keyrings.get(b)
  if (!keyring) return candidates
  const out: IdentityId[] = [conv.owner]
  for (const id of candidates) {
    if (bytesEqual(id, conv.owner)) continue
    const publicKey = await peerKey(ctx, id)
    if (!publicKey) continue
    const slot = openKeyringSlot(keyring, { myPrivateKey: ctx.me.encPriv, otherPublicKey: publicKey, gid: conv.gid, ownerId: conv.owner, memberId: id, b })
    if (slot) out.push(id)
  }
  return out
}

type Change = (current: RosterContent) => Promise<WriteOutcome | 'noop'>

/**
 * OWNER_WRITE (§6.5). `change` sees a roster at the newest epoch and returns
 * its last write's outcome; a stale or duplicate refusal re-runs the loop.
 */
async function ownerWrite(ctx: DmContext, conv: GroupConv, change: Change): Promise<void> {
  for (let round = 0; round < MAX_OWNER_ROUNDS; round++) {
    conv.lastRoster = null
    conv.roster = null
    await applyGroups(ctx, [conv])
    const roster = conv.lastRoster as RosterContent | null
    if (!roster) throw new GroupError('The group roster could not be read.')
    if (roster.ended) throw new GroupError('This group has ended.')
    if (conv.epoch.b > roster.b) {
      const repaired: RosterContent = { ...roster, b: conv.epoch.b, r: 0, members: await survivorsOf(ctx, conv, conv.epoch.b, roster.members) }
      const outcome = await writeRoster(ctx, conv, repaired)
      if (!outcome.ok && outcome.failure === 'other') throw new GroupError(outcome.error)
      continue
    }
    const outcome = await change(roster)
    if (outcome === 'noop' || outcome.ok) return
    if (outcome.failure === 'other') throw new GroupError(outcome.error)
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
    const content: RosterContent = { b: 0, r: 0, name: cleanName, avatarRef: '', members: [ctx.me.id, ...others], ended: false }
    const outcome = await writeRoster(ctx, conv, content)
    ctx.store.claimGroupNumber(n)
    if (!outcome.ok) {
      if (outcome.failure === 'duplicate') continue // another device took n
      throw new GroupError(outcome.error)
    }
    conv.live = true
    conv.appliedAt = ctx.chain.now()
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

/** Add a member (§6.4): a grant at (b, r+1), then an immediate roster replace. */
export async function addMember(ctx: DmContext, conv: GroupConv, member: IdentityId): Promise<void> {
  requireOwner(ctx, conv)
  await publicKeysOf(ctx, [member])
  let granted: Epoch | null = null
  await ownerWrite(ctx, conv, async (roster) => {
    if (includesId(roster.members, member)) return 'noop'
    if (roster.members.length + 1 > MAX_GROUP_MEMBERS) throw new GroupError(`A group can have at most ${MAX_GROUP_MEMBERS} members.`)
    const next = { b: roster.b, r: roster.r + 1 }
    // Keys are deterministic per (gid, b, r), so a re-run after a refused roster write re-grants only on a new epoch.
    if (!granted || !sameEpoch(granted, next)) {
      await grant(ctx, conv, member, next)
      granted = next
    }
    return writeRoster(ctx, conv, { ...roster, ...next, members: [...roster.members, member] })
  })
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
    const keyring = await withNonceRetry(() => ctx.chain.createGroupDoc(keyringHandle(conv.gid, b), built.blob), ctx.sleep)
    if (!keyring.ok) return keyring
    conv.keyrings.set(b, built.blob)
    conv.keyringAt.set(b, ctx.chain.now())
    conv.keys.set({ b, r: 0 }, built.baseKey)
    return writeRoster(ctx, conv, { ...roster, b, r: 0, members: remaining })
  })
}

/** Rename (§6.4): one roster replace at the current epoch. */
export async function renameGroup(ctx: DmContext, conv: GroupConv, name: string): Promise<void> {
  requireOwner(ctx, conv)
  const cleanName = checkName(name)
  await ownerWrite(ctx, conv, async (roster) => (roster.name === cleanName ? 'noop' : writeRoster(ctx, conv, { ...roster, name: cleanName })))
}

/** End the group (§6.4, owner leaves): the roster becomes a tombstone. */
export async function endGroup(ctx: DmContext, conv: GroupConv): Promise<void> {
  requireOwner(ctx, conv)
  await ownerWrite(ctx, conv, async (roster) => writeRoster(ctx, conv, { ...roster, members: [], avatarRef: '', ended: true }))
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

/** The owner's client removes members who sent a leave (§6.4). */
export async function processLeaves(ctx: DmContext): Promise<void> {
  if (!ctx.chain.canWrite()) return
  const now = ctx.chain.now()
  for (const [id, pending] of Array.from(ctx.pendingLeaves.entries())) {
    if (pending.retryAt > now) continue
    const { conv, member } = pending
    try {
      if (!conv.ended && isMember(conv, member, ctx.me.id)) await removeMember(ctx, conv, member)
      ctx.pendingLeaves.delete(id)
    } catch (error) {
      // A refused transition still costs a fee: back off instead of retrying every poll.
      pending.retryAt = now + LEAVE_RETRY_MS
      logger.warn('DM v5: removing a member who left failed:', error)
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
