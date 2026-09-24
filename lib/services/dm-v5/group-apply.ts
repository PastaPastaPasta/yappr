/**
 * Reading a group's documents (docs/DM_V5.md §5.2–§5.4, §6.3 APPLY/SWITCH).
 *
 * Per owner, one query fetches the roster and the next keyring handle of each
 * of that owner's groups; a keyring found for base b+1 is applied (my slot
 * unwrapped, or the owner's own derivation) and the following handle fetched,
 * until none is left. The roster is then opened by ratcheting forward from the
 * newest key held, bounded by how far its `$revision` moved (§5.4).
 */

import { bytesEqual, hexToBytes } from '@/lib/bytes'
import { epochBefore } from '@/lib/dm/keys'
import { keyringHandle, openKeyringSlot, openRoster, ownerKeyringBaseKey, rosterHandle } from '@/lib/dm/group'
import type { Epoch, IdentityId } from '@/lib/dm/types'
import { logger } from '@/lib/logger'
import { members, stream, type GroupConv } from './conversation'
import { curWeek, peerKey, seedHeads, type DmContext } from './context'
import type { ChainGroupDoc } from './types'
import { GROUP_FRESHNESS_MS, STALE_WINDOW_MS, groupBy, hexId, sameEpoch } from './util'

/** How many keyrings past the current base one apply follows (each is a removal; this is generous). */
const MAX_KEYRING_ROUNDS = 64

/**
 * SWITCH (§6.3): every member stream on the old epoch keeps its next tag for
 * the stale window, and streams on the new epoch start at the current week.
 * The first apply after load is not a live switch: nothing is left stale.
 */
export function switchEpoch(ctx: DmContext, conv: GroupConv, epoch: Epoch): void {
  if (sameEpoch(conv.epoch, epoch) || epochBefore(epoch, conv.epoch)) return
  if (conv.live) {
    const until = ctx.chain.now() + STALE_WINDOW_MS
    const cw = curWeek(ctx)
    for (const sender of members(conv, ctx.me.id)) {
      const st = stream(conv, sender, conv.epoch)
      if (!st) continue
      st.stale.push(st.cur ? { w: st.cur.w, j: st.cur.j + 1, until } : { w: cw, j: 0, until })
    }
    conv.epochSinceWeek = cw
  }
  conv.epoch = { b: epoch.b, r: epoch.r }
}

/**
 * Unwrap keyring `b` for this reader: the owner re-derives it, a member opens
 * their slot. `unknown` when the owner's key could not be fetched (a network
 * failure, not "no slot"): nothing can be concluded until a later poll.
 */
async function keyringBaseKey(ctx: DmContext, conv: GroupConv, b: number, blob: Uint8Array): Promise<Uint8Array | null | 'unknown'> {
  if (conv.secret) return ownerKeyringBaseKey(conv.secret, b, blob)
  const ownerPub = await peerKey(ctx, conv.owner)
  // peerKey caches an identity that has no key; a lookup that failed is not cached.
  if (!ownerPub) return ctx.peerKeys.has(hexId(conv.owner)) ? null : 'unknown'
  return openKeyringSlot(blob, { myPrivateKey: ctx.me.encPriv, otherPublicKey: ownerPub, gid: conv.gid, ownerId: conv.owner, memberId: ctx.me.id, b })
}

/**
 * Apply keyring `b` (= epoch.b + 1): `applied` (the next keyring may follow),
 * `removed` (no slot for me: the group stops here for me), or `unknown` (the
 * owner's key could not be fetched: nothing is concluded or marked, and the
 * group does not count as applied, so a send is refused until a later poll).
 */
async function applyKeyring(ctx: DmContext, conv: GroupConv, doc: ChainGroupDoc, b: number): Promise<'applied' | 'removed' | 'unknown'> {
  conv.keyrings.set(b, doc.blob)
  conv.keyringAt.set(b, doc.createdAt)
  const baseKey = await keyringBaseKey(ctx, conv, b, doc.blob)
  if (baseKey === 'unknown') return 'unknown'
  if (baseKey) {
    conv.keys.set({ b, r: 0 }, baseKey)
    switchEpoch(ctx, conv, { b, r: 0 })
    return 'applied'
  }
  // No slot, but a grant (or a re-add anchor another device saved) gave me a key on this base or a
  // later one: I was re-added after it (§6.4), and the keyrings up to that base have no slot for me.
  const granted = conv.keys.lowestFrom(b)
  if (granted) {
    switchEpoch(ctx, conv, granted)
    return 'applied'
  }
  conv.removed = true
  return 'removed'
}

/** True when the group was fully applied within the freshness window by BOTH clocks (§6.3 SEND). */
export function isFresh(ctx: DmContext, conv: GroupConv): boolean {
  const elapsed = Math.max(ctx.clock() - conv.appliedAt.local, ctx.wallClock() - conv.appliedAt.wall)
  return elapsed <= GROUP_FRESHNESS_MS
}

/** Record a full apply of `conv` now. */
export function markApplied(ctx: DmContext, conv: GroupConv): void {
  conv.appliedAt = { local: ctx.clock(), wall: ctx.wallClock() }
}

/**
 * Open the roster (§5.4) by ratcheting forward from the lowest key held on
 * each base, newest base first. Keys are one-way, so the lowest key reaches
 * every later step; the bound is how far the roster's `$revision` moved (each
 * add is at least one replace). Older bases are tried too: a roster can trail
 * the newest keyring when the owner's replace after a removal failed (§6.4),
 * and readers keep reading it until the owner's repair loop catches up.
 */
async function applyRoster(ctx: DmContext, conv: GroupConv, doc: ChainGroupDoc): Promise<void> {
  // Skip only the very bytes already opened: an id and revision alone can match a write this device
  // assumed landed while another device's competing write is what is really there.
  if (conv.roster && conv.roster.id === doc.id && conv.roster.revision === doc.revision && bytesEqual(conv.roster.blob, doc.blob) && conv.lastRoster) return
  const seen = conv.roster?.id === doc.id ? conv.roster.revision : 0
  for (let b = conv.epoch.b; b >= 0; b--) {
    const low = conv.keys.lowest(b)
    if (!low) continue
    const ahead = b === conv.epoch.b ? conv.epoch.r - low.r : 0
    const maxSteps = ahead + Math.max(0, doc.revision - (b === conv.epoch.b ? seen : 0))
    const opened = await openRoster({ blob: doc.blob, gid: conv.gid, known: low, maxSteps })
    if (!opened) continue
    const { content } = opened
    conv.keys.set(content, opened.key)
    conv.roster = { id: doc.id, revision: doc.revision, blob: doc.blob }
    conv.lastRoster = content
    conv.unreadable = false
    if (epochBefore(conv.epoch, content)) switchEpoch(ctx, conv, content)
    return
  }
  // Not opened: `conv.roster` keeps the last roster that did, so the ratchet bound (§5.4) still
  // counts from it. A group I hold no readable roster for: "ask the owner to resend your keys" (§6.4).
  if (!conv.lastRoster) conv.unreadable = true
}

/**
 * Apply every group of one owner (§6.3 APPLY). Resolves false when some group
 * could not be fully checked (a keyring whose slot could not be tested).
 */
async function applyOwner(ctx: DmContext, owner: IdentityId, groups: GroupConv[]): Promise<boolean> {
  const live = groups.filter((g) => !g.removed)
  if (live.length === 0) return true
  const unchecked = new Set<GroupConv>()
  const rosterById = new Map(live.map((g) => [hexId(rosterHandle(g.gid)), g]))
  let pending = live.map((g) => ({ g, b: g.epoch.b + 1 }))
  const rosters: ChainGroupDoc[] = []

  for (let round = 0; pending.length > 0 && round < MAX_KEYRING_ROUNDS; round++) {
    const keyringFor = new Map(pending.map((p) => [hexId(keyringHandle(p.g.gid, p.b)), p]))
    const handles = [...(round === 0 ? Array.from(rosterById.keys()) : []), ...Array.from(keyringFor.keys())]
    const docs = await ctx.chain.groupDocs(owner, handles.map((h) => hexToBytes(h)))
    const next: typeof pending = []
    for (const doc of docs) {
      if (!bytesEqual(doc.ownerId, owner)) continue
      const handle = hexId(doc.handle)
      if (round === 0 && rosterById.has(handle)) {
        rosters.push(doc)
        continue
      }
      const hit = keyringFor.get(handle)
      if (!hit) continue
      const result = await applyKeyring(ctx, hit.g, doc, hit.b)
      if (result === 'applied') next.push({ g: hit.g, b: hit.b + 1 })
      if (result === 'unknown') unchecked.add(hit.g)
    }
    pending = next
  }
  // Keyrings left unwalked at the round cap: the group is not known to be current.
  for (const { g } of pending) unchecked.add(g)

  for (const doc of rosters) {
    const g = rosterById.get(hexId(doc.handle))
    if (g && !g.removed) await applyRoster(ctx, g, doc)
  }
  for (const g of live) {
    if (g.lastRoster?.ended) g.ended = true
    // A group not fully checked is neither fresh nor live yet: the next poll applies it again.
    if (unchecked.has(g)) continue
    markApplied(ctx, g)
    const first = !g.live
    g.live = true
    if (first) seedHeads(ctx, g)
  }
  return unchecked.size === 0
}

/**
 * Apply every group, one query round per owner (§6.3 POLL, first line).
 * Resolves false when any owner's query failed or a group could not be fully
 * checked: those groups keep their old state, which a send must not trust
 * (§6.3 SEND).
 */
export async function applyGroups(ctx: DmContext, only?: GroupConv[]): Promise<boolean> {
  const groups = only ?? Array.from(ctx.convs.values()).filter((c): c is GroupConv => c.kind === 'group' && !c.ended)
  const byOwner = groupBy(groups, (g) => hexId(g.owner))
  const results = await Promise.all(
    Array.from(byOwner.values()).map((list) =>
      applyOwner(ctx, list[0].owner, list).then(
        (checked) => checked,
        (error) => {
          logger.warn('DM v5: applying group documents failed:', error)
          return false
        }
      )
    )
  )
  return results.every(Boolean)
}
