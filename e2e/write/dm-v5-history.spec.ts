/**
 * DM v5 history paging and concurrency against the real moutai chain
 * (docs/DM_V5.md §5.5, §6.1, §6.3). Actors: E (slot 5) and F (slot 6).
 *
 *  4. BACKFILL: E writes ~120 messages on its stream in one week (bulk, from
 *     Node, with the app's own encoding and `prev` links), then one through
 *     the UI. F opens the thread on a fresh device: the whole history arrives
 *     by walking `prev` back past the 100-tag page, and again after a reload.
 *     Week rollovers, stale windows and gaps across epochs cannot be forced on
 *     a live chain; lib/services/dm-v5/poller.test.ts covers them.
 *  8. Self-state concurrency: two devices of E change the self-state at once
 *     (both save immediately); the replace race is lost by one (40106) and it
 *     merges and saves again — the saved state holds both changes.
 *  -  Own-device tag collision: two devices of E send into the same thread
 *     at the same moment; one wins each tag, the other retries at j + 1, and
 *     both messages arrive.
 */
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'
import {
  DM_V5_BUILD,
  IS_DEVNET_RUN,
  NOT_DEVNET_REASON,
  NOT_V5_REASON,
  POOL_REASON,
  SLOT,
  bubbles,
  closeDevices,
  composer,
  currentWeek,
  decryptAt,
  directKey,
  directStream,
  dmBot,
  gotoMessages,
  openDevice,
  openRow,
  poolTooSmall,
  row,
  selfStateOf,
  send,
  flushSelfState,
  threadMenu,
  streamWeek,
  thread,
  writeInvite,
  writeStreamBulk,
  type DmBot,
  type Device,
} from '../fixtures/dm'
import { uniqueTag } from '../fixtures/run-tag'

test.describe.configure({ mode: 'serial' })

const DELIVERY_MS = 150_000
/** Messages written in bulk: past one 100-tag backfill page. */
const BULK = Number(process.env.E2E_DM_BULK ?? 120)

test.describe('DM v5: history and concurrency', () => {
  test.skip(!IS_DEVNET_RUN, NOT_DEVNET_REASON)
  test.skip(!DM_V5_BUILD, NOT_V5_REASON)
  test.skip(!hasSeedPhrase, NO_SEED_REASON)
  test.skip(poolTooSmall(), POOL_REASON)

  let E: DmBot
  let F: DmBot
  let e1: Device | undefined
  let e2: Device | undefined
  let f1: Device | undefined
  let tag = ''

  test.beforeEach(async () => {
    E = await dmBot(SLOT.E)
    F = await dmBot(SLOT.F)
    tag ||= uniqueTag(SLOT.E)
  })

  test.afterAll(async () => {
    await closeDevices([e1, e2, f1])
  })

  test(`scroll-back: ${BULK}+ messages in one week arrive through prev (BACKFILL)`, async ({ browser }) => {
    test.setTimeout(1_500_000)
    // Make sure the conversation exists for F: an invite from E (a no-op for F if one exists already).
    e1 = await openDevice(browser, E, 'E1')
    await gotoMessages(e1.page, `?startConversation=${F.identityId}`)
    await expect(thread(e1.page)).toBeVisible({ timeout: 60_000 })
    await send(e1.page, `${tag} start`)

    // Bulk-write BULK messages on E's stream, continuing after what is there.
    const w = currentWeek()
    const stream = directStream(E, F, E)
    const existing = await streamWeek(stream, w)
    const last = existing.at(-1)
    expect(last, 'the UI send is on chain').toBeDefined()
    const texts = Array.from({ length: BULK }, (_, i) => `${tag} bulk ${String(i).padStart(3, '0')}`)
    await writeStreamBulk(E, stream, w, last!.j + 1, texts, { w, b: 0, r: 0, j: last!.j })
    const onChain = await streamWeek(stream, w)
    expect(onChain.length, 'the week holds more than one 100-tag page').toBeGreaterThan(100)
    // One more through the UI: its prev points at the last bulk message, so a reader that
    // sees only this one must walk the whole chain back (BACKFILL, 100 tags a query).
    await gotoMessages(e1.page)
    await openRow(e1.page, row(e1.page, directKey(F)))
    await send(e1.page, `${tag} after bulk`)

    // F on a fresh device (nothing cached): open the thread and scroll back through everything.
    f1 = await openDevice(browser, F, 'F1')
    const p = f1.page
    await gotoMessages(p)
    await openRow(p, row(p, directKey(E)), DELIVERY_MS)
    await expect(bubbles(p, `${tag} after bulk`)).toBeVisible({ timeout: DELIVERY_MS })
    await expect(bubbles(p, `${tag} bulk 000`)).toBeVisible({ timeout: DELIVERY_MS })
    await expect(bubbles(p, new RegExp(`${tag} bulk \\d{3}`))).toHaveCount(BULK, { timeout: DELIVERY_MS })
    await expect(bubbles(p, `${tag} start`)).toBeVisible()
    // Everything E wrote this week reached F, not only this run's messages (> 100: past one backfill page).
    const fromE = await p.locator('[data-testid="dm-message"][data-own="false"]').count()
    expect(fromE, 'every message on E\'s stream this week is on screen').toBeGreaterThanOrEqual(onChain.length)

    // Order on screen is block-time order. (The bulk writer broadcasts eight at once, so they land
    // in blocks out of j order; a real client sends one at a time, so for it the two agree.)
    const firstJ = last!.j + 1
    const createdAtOfJ = new Map(onChain.map((d) => [d.j, Number(d.doc.$createdAt)]))
    const shown = await bubbles(p, new RegExp(`${tag} bulk \\d{3}`)).allInnerTexts()
    const times = shown.map((t) => createdAtOfJ.get(firstJ + Number(/bulk (\d{3})/.exec(t)?.[1])) ?? NaN)
    expect(times.every((t) => Number.isFinite(t))).toBe(true)
    expect(times).toEqual([...times].sort((a, b) => a - b))

    // A reload rebuilds the same timeline (cached heads + prev walk).
    await gotoMessages(p)
    await openRow(p, row(p, directKey(E)), DELIVERY_MS)
    await expect(bubbles(p, new RegExp(`${tag} bulk \\d{3}`))).toHaveCount(BULK, { timeout: DELIVERY_MS })
  })

  test('two devices save the self-state at once: one loses the race, merges, and both changes survive', async ({ browser }) => {
    test.setTimeout(900_000)
    const partnerA = await dmBot(SLOT.A)
    const partnerB = await dmBot(SLOT.B)
    e1 ??= await openDevice(browser, E, 'E1')
    e2 = await openDevice(browser, E, 'E2')

    // Setup: E has a 1:1 with each partner (the first run creates them, later runs reuse them).
    await Promise.all([
      gotoMessages(e1.page, `?startConversation=${partnerA.identityId}`),
      gotoMessages(e2.page, `?startConversation=${partnerB.identityId}`),
    ])
    await Promise.all([
      expect(thread(e1.page)).toHaveAttribute('data-key', directKey(partnerA), { timeout: 60_000 }),
      expect(thread(e2.page)).toHaveAttribute('data-key', directKey(partnerB), { timeout: 60_000 }),
    ])
    // An interrupted earlier run can leave a partner blocked: start from unblocked.
    for (const device of [e1, e2]) {
      if (await thread(device.page).getByText('You blocked this person. Unblock them to send messages.').isVisible()) {
        await threadMenu(device.page, /^Unblock /)
      }
    }
    await Promise.all([send(e1.page, `${tag} setup A`), send(e2.page, `${tag} setup B`)])
    const idEq = (a: Uint8Array, b: Uint8Array) => a.every((x, i) => x === b[i])
    await expect
      .poll(async () => {
        const saved = await selfStateOf(E)
        return Boolean(saved && [partnerA, partnerB].every((p) => saved.state.directs.some((d) => idEq(d.peer, p.id))))
      }, { timeout: 180_000, intervals: [3_000, 5_000] })
      .toBe(true)

    // Each device toggles a DIFFERENT block entry, then both save in the same instant:
    // two replaces built on one revision. The loser gets 40106, re-reads, merges, saves.
    const stale: string[] = []
    for (const device of [e1, e2]) {
      device.page.on('console', (m) => {
        if (/invalid revision|40106/i.test(m.text())) stale.push(device.label)
      })
    }
    for (const round of [1, 2]) {
      const before = await selfStateOf(E)
      const blockedBefore = (p: DmBot) => before?.state.blocks.find((b) => idEq(b.id, p.id))?.blocked ?? false
      const want = { a: !blockedBefore(partnerA), b: !blockedBefore(partnerB) }
      // Refresh both devices onto the current revision first, so both build on it.
      await Promise.all([gotoMessages(e1.page), gotoMessages(e2.page)])
      await openRow(e1.page, row(e1.page, directKey(partnerA)))
      await openRow(e2.page, row(e2.page, directKey(partnerB)))
      await threadMenu(e1.page, want.a ? /^Block / : /^Unblock /)
      await threadMenu(e2.page, want.b ? /^Block / : /^Unblock /)
      await Promise.all([flushSelfState(e1), flushSelfState(e2)])
      await expect
        .poll(async () => {
          const saved = await selfStateOf(E)
          const flag = (p: DmBot) => saved?.state.blocks.find((b) => idEq(b.id, p.id))?.blocked
          return `${flag(partnerA)}/${flag(partnerB)}`
        }, { timeout: 180_000, intervals: [3_000, 5_000] })
        .toBe(`${want.a}/${want.b}`)
      const after = await selfStateOf(E)
      // Both devices saved (navigation also flushes read positions, so possibly more than two), and
      // the content check above proves neither change was lost to the other.
      expect(after!.revision, `round ${round}: both devices saved`).toBeGreaterThanOrEqual((before?.revision ?? 0) + 2)
    }
    test.info().annotations.push({ type: 'self-state race', description: stale.length > 0 ? `stale replace seen on ${stale.join(', ')}` : 'no stale refusal logged (saves did not overlap)' })
    // Leave both partners unblocked.
    const final = await selfStateOf(E)
    for (const [device, partner] of [[e1, partnerA], [e2, partnerB]] as const) {
      if (final?.state.blocks.find((b) => idEq(b.id, partner.id))?.blocked) {
        await threadMenu(device.page, /^Unblock /)
        await flushSelfState(device)
      }
    }
  })

  test('two devices send into one thread at once: one takes the tag, the other retries at j + 1', async ({ browser }) => {
    test.setTimeout(600_000)
    e1 ??= await openDevice(browser, E, 'E1')
    e2 ??= await openDevice(browser, E, 'E2')
    await Promise.all([gotoMessages(e1.page), gotoMessages(e2.page)])
    await openRow(e1.page, row(e1.page, directKey(F)))
    await openRow(e2.page, row(e2.page, directKey(F)))
    // Both devices have caught up on E's own stream (open threads poll it), so both pick the same next j.
    await e1.page.waitForTimeout(10_000)
    const w = currentWeek()
    const before = (await streamWeek(directStream(E, F, E), w)).length
    // Both send at once. The loser's broadcast is refused (or only times out) and it retries at j + 1,
    // linking its prev to the winner's message; a timed-out broadcast plus its read-back can take minutes.
    await Promise.all([send(e1.page, `${tag} collide 1`, 420_000), send(e2.page, `${tag} collide 2`, 420_000)])
    const docs = await streamWeek(directStream(E, F, E), w)
    expect(docs.length).toBe(before + 2)
    // The stream has no hole (j runs 0..n-1) and no fork: each message links to the one before it.
    expect(docs.map((d) => d.j)).toEqual(docs.map((_, i) => i))
    for (const d of docs.slice(-2)) {
      const m = await decryptAt(directStream(E, F, E), E, w, d.j, d.doc)
      expect(m?.prev?.j, `prev of j = ${d.j}`).toBe(d.j - 1)
    }

    f1 ??= await openDevice(browser, F, 'F1')
    await gotoMessages(f1.page)
    await openRow(f1.page, row(f1.page, directKey(E)), DELIVERY_MS)
    await expect(bubbles(f1.page, `${tag} collide 1`)).toBeVisible({ timeout: DELIVERY_MS })
    await expect(bubbles(f1.page, `${tag} collide 2`)).toBeVisible({ timeout: DELIVERY_MS })
  })

  test('an invite from someone already known is ignored: still one conversation', async ({ browser }) => {
    test.setTimeout(300_000)
    // A second invite from E (as a buggy or malicious client could write) adds nothing on F's side.
    await writeInvite(E, F)
    f1 ??= await openDevice(browser, F, 'F1')
    await gotoMessages(f1.page)
    await expect(row(f1.page, directKey(E))).toHaveCount(1, { timeout: DELIVERY_MS })
    await f1.page.waitForTimeout(35_000)
    await expect(row(f1.page, directKey(E))).toHaveCount(1)
  })
})
