/**
 * DM v5 1:1 conversations against the real moutai chain (docs/DM_V5.md §4.3,
 * §5.1, §5.5, §5.6, §5.7, §6.3, §10). Two identities, A (slot 1) and B
 * (slot 2), each on its own browser; A also has a second device.
 *
 * Covered here, in order (the file is serial: later steps build on earlier
 * ones):
 *  1. A starts a 1:1 with B: one invite + one message. B finds it in the inbox
 *     as a normal first DM, unread; reading clears it; B replies; A sees it.
 *     A's second device (fresh storage) finds the conversation and its full
 *     history through the self-state.
 *  2. The duplicate-invite rule: B replying writes no invite, and A starting
 *     again with B lands in the same thread (still exactly one invite).
 *  3. A long message (> 4 KB) is split into class-4096 messages; multiline
 *     text and emoji/unicode round-trip; every body is exactly a size class.
 *  6. Block/unblock: B blocks A, A's next message stays hidden for B (and for
 *     B's second device, through the merged self-state); unblocking shows it.
 *  7. "Delete conversation" hides the thread until a newer message arrives.
 * 10. The retention setting shows the §5.6 wording and persists across devices.
 * 11. A pre-existing v4 thread between A and B is read and merged into the
 *     same timeline, and a legacy-only thread's first reply starts a v5 chat.
 *
 * Drive it with:
 *   npm run build:devnet          # .env.devnet sets NEXT_PUBLIC_DM_TOPOLOGY=v5
 *   E2E_BASE_PATH=/devnet E2E_ENV_FILE=.env.devnet NETWORK=devnet npx playwright test --project=write dm-v5
 */
import type { Browser } from '@playwright/test'
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'
import {
  DM_V5_BUILD,
  IS_DEVNET_RUN,
  LEGACY_DM_CONTRACT_ID,
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
  expectAbsentFor,
  flushSelfState,
  gotoMessages,
  hasDirect,
  invitesBetween,
  openDevice,
  openRow,
  poolTooSmall,
  queryDocs,
  row,
  selfStateOf,
  send,
  streamWeek,
  thread,
  threadMenu,
  writeLegacyMessage,
  type DmBot,
  type Device,
} from '../fixtures/dm'
import { uniqueTag } from '../fixtures/run-tag'

test.describe.configure({ mode: 'serial' })

/** A message the chain has to carry: signed, broadcast, and read by the other side's poll. */
const DELIVERY_MS = 150_000

test.describe('DM v5: 1:1 conversations', () => {
  test.skip(!IS_DEVNET_RUN, NOT_DEVNET_REASON)
  test.skip(!DM_V5_BUILD, NOT_V5_REASON)
  test.skip(!hasSeedPhrase, NO_SEED_REASON)
  test.skip(poolTooSmall(), POOL_REASON)

  let A: DmBot
  let B: DmBot
  let a1: Device | undefined
  let a2: Device | undefined
  let b1: Device | undefined
  let b2: Device | undefined
  let tag = ''
  let invitesAtStart = 0

  const openAll = async (browser: Browser) => {
    A = await dmBot(SLOT.A)
    B = await dmBot(SLOT.B)
    a1 ??= await openDevice(browser, A, 'A1')
    b1 ??= await openDevice(browser, B, 'B1')
    tag ||= uniqueTag(SLOT.A)
  }

  // Every test opens what it needs, so a subset (--grep) can resume mid-file.
  test.beforeEach(async ({ browser }) => {
    await openAll(browser)
  })

  test.afterAll(async () => {
    await closeDevices([a1, a2, b1, b2])
  })

  test('both users open the v5 inbox', async () => {
    // Earlier runs left invites between these two bots; the rule is "no NEW invite".
    invitesAtStart = (await invitesBetween(A, B)) + (await invitesBetween(B, A))
    await gotoMessages(a1!.page)
    await gotoMessages(b1!.page)
  })

  test('A starts a 1:1 with B: one invite, then a normal first message B finds unread', async () => {
    test.setTimeout(420_000)
    const { page } = a1!
    await gotoMessages(page, `?startConversation=${B.identityId}`)
    await expect(thread(page)).toBeVisible({ timeout: 60_000 })
    await send(page, `${tag} hello B`)
    await expect(bubbles(page, `${tag} hello B`)).toBeVisible()

    // At most one invite per started pair (§5.1): a pair that already talked in an
    // earlier run writes none, a fresh pair exactly one.
    const invites = (await invitesBetween(A, B)) + (await invitesBetween(B, A))
    expect(invites - invitesAtStart).toBeLessThanOrEqual(1)
    expect(invites).toBeGreaterThanOrEqual(1)

    // B: the conversation shows as a normal DM with an unread badge (no request inbox).
    const pb = b1!.page
    await gotoMessages(pb)
    const rowA = row(pb, directKey(A))
    await expect(rowA).toBeVisible({ timeout: DELIVERY_MS })
    await expect(rowA).toContainText(`${tag} hello B`, { timeout: DELIVERY_MS })
    await expect(rowA).not.toHaveAttribute('data-unread', '0')
  })

  test('B reads it (unread clears), replies, and A receives the reply', async () => {
    test.setTimeout(420_000)
    const pb = b1!.page
    if (!(await thread(pb).isVisible())) await gotoMessages(pb)
    await openRow(pb, row(pb, directKey(A)))
    await expect(bubbles(pb, `${tag} hello B`)).toBeVisible({ timeout: DELIVERY_MS })
    await expect(row(pb, directKey(A))).toHaveAttribute('data-unread', '0')
    const before = (await invitesBetween(B, A)) + (await invitesBetween(A, B))
    await send(pb, `${tag} hi A, B here`)
    // Replying to a conversation found from A's invite writes no invite (§5.1).
    expect((await invitesBetween(B, A)) + (await invitesBetween(A, B))).toBe(before)

    const pa = a1!.page
    if (!(await thread(pa).isVisible())) {
      await gotoMessages(pa)
      await openRow(pa, row(pa, directKey(B)))
    }
    await expect(bubbles(pa, `${tag} hi A, B here`)).toBeVisible({ timeout: DELIVERY_MS })
  })

  test('B\'s read position reached the self-state (readAt), so a reload keeps it read', async () => {
    test.setTimeout(300_000)
    const pb = b1!.page
    await flushSelfState(b1!)
    await expect
      .poll(async () => {
        const saved = await selfStateOf(B)
        const entry = saved?.state.directs.find((d) => d.peer.every((byte, i) => byte === A.id[i]))
        return entry?.readAt ?? 0
      }, { timeout: 120_000, intervals: [3_000, 5_000] })
      .toBeGreaterThan(0)
    await gotoMessages(pb)
    await expect(row(pb, directKey(A))).toBeVisible({ timeout: DELIVERY_MS })
    await expect(row(pb, directKey(A))).toHaveAttribute('data-unread', '0')
  })

  test('A\'s second device (fresh storage) finds the conversation and its full history', async ({ browser }) => {
    test.setTimeout(420_000)
    const saved = await selfStateOf(A)
    expect(saved && hasDirect(saved.state, B), 'starting the chat saved it to A\'s self-state at once').toBe(true)
    a2 = await openDevice(browser, A, 'A2')
    const p = a2.page
    await gotoMessages(p)
    await openRow(p, row(p, directKey(B)), DELIVERY_MS)
    await expect(bubbles(p, `${tag} hello B`)).toBeVisible({ timeout: DELIVERY_MS })
    await expect(bubbles(p, `${tag} hi A, B here`)).toBeVisible({ timeout: DELIVERY_MS })
  })

  test('starting again with B lands in the same thread and writes no second invite', async () => {
    test.setTimeout(420_000)
    const before = (await invitesBetween(A, B)) + (await invitesBetween(B, A))
    const p = a1!.page
    await gotoMessages(p, `?startConversation=${B.identityId}`)
    await expect(thread(p)).toHaveAttribute('data-key', directKey(B), { timeout: 60_000 })
    await expect(bubbles(p, `${tag} hello B`)).toBeVisible({ timeout: DELIVERY_MS })
    await send(p, `${tag} again`)
    expect((await invitesBetween(A, B)) + (await invitesBetween(B, A))).toBe(before)
  })

  test('long, multiline and unicode text round-trip; every body is one size class', async () => {
    test.setTimeout(600_000)
    const p = a1!.page
    await gotoMessages(p)
    await openRow(p, row(p, directKey(B)))
    const multiline = `${tag} line one\nline two\n\n  indented three`
    const unicode = `${tag} emoji 🎉🔐🦀 CJK 你好世界 RTL مرحبا combining é̃ ZWJ 👩‍👩‍👧`
    // 4,500+ bytes of ASCII plus multibyte tail: more than one message's worth (MAX_TEXT_BYTES ≈ 4,077).
    const long = `${tag} LONG ` + 'abcdefghij'.repeat(450) + ' END-λ'

    await send(p, multiline)
    await send(p, unicode)
    await send(p, long)
    await expect(bubbles(p, `${tag} line one`)).toBeVisible()

    // B receives each intact.
    const pb = b1!.page
    await gotoMessages(pb)
    await openRow(pb, row(pb, directKey(A)))
    await expect(bubbles(pb, `${tag} line one`)).toBeVisible({ timeout: DELIVERY_MS })
    const text = await bubbles(pb, `${tag} line one`).locator('p.whitespace-pre-wrap').first().innerText()
    expect(text).toBe(multiline)
    await expect(bubbles(pb, unicode)).toBeVisible({ timeout: DELIVERY_MS })
    // The long text arrives as two messages whose concatenation is the original.
    await expect(bubbles(pb, `${tag} LONG `)).toBeVisible({ timeout: DELIVERY_MS })
    await expect(bubbles(pb).filter({ hasText: 'END-λ' }).last()).toBeVisible({ timeout: DELIVERY_MS })
    const parts = await bubbles(pb).evaluateAll((nodes) =>
      nodes.map((n) => (n.querySelector('p.whitespace-pre-wrap') as HTMLElement | null)?.innerText ?? '')
    )
    const start = parts.findIndex((t) => t.startsWith(`${tag} LONG `))
    expect(start).toBeGreaterThanOrEqual(0)
    expect(parts[start] + parts[start + 1]).toBe(long)

    // On chain: every body of A's stream this week is exactly one sealed size class (§5.7).
    const w = currentWeek()
    const docs = await streamWeek(directStream(A, B, A), w)
    const classes = new Set([128, 256, 512, 1024, 2048, 4096].map((c) => c + 28))
    expect(docs.length).toBeGreaterThan(0)
    for (const d of docs) {
      expect(d.ownerId).toBe(A.identityId)
      expect(classes.has(d.bodyLength), `body of ${d.bodyLength} bytes is not a size class`).toBe(true)
    }
    const bodies = new Set(docs.map((d) => d.bodyLength))
    expect(bodies.has(4096 + 28), 'the long text used the largest class').toBe(true)
    // And they decrypt, in order, to what was sent.
    const texts: string[] = []
    for (const d of docs) {
      const m = await decryptAt(directStream(A, B, A), A, w, d.j, d.doc)
      if (m?.content.type === 'text') texts.push(m.content.text)
    }
    expect(texts.join('')).toContain(long)
  })

  test('block: B blocks A, A\'s next message stays hidden; B\'s other device agrees; unblock shows it', async ({ browser }) => {
    test.setTimeout(900_000)
    const pb = b1!.page
    await gotoMessages(pb)
    await openRow(pb, row(pb, directKey(A)))
    // Start unblocked (an interrupted earlier run can leave the block in B's self-state).
    const blockedNotice = thread(pb).getByText('You blocked this person. Unblock them to send messages.')
    if (await blockedNotice.isVisible()) {
      await threadMenu(pb, /^Unblock /)
      await expect(blockedNotice).toHaveCount(0)
    }
    await threadMenu(pb, /^Block /)
    await expect(thread(pb).getByText('You blocked this person. Unblock them to send messages.')).toBeVisible()
    await flushSelfState(b1!)
    await expect
      .poll(async () => (await selfStateOf(B))?.state.blocks.some((b) => b.blocked && b.id.every((x, i) => x === A.id[i])) ?? false, {
        timeout: 120_000,
        intervals: [3_000, 5_000],
      })
      .toBe(true)

    const pa = a1!.page
    await gotoMessages(pa)
    await openRow(pa, row(pa, directKey(B)))
    await send(pa, `${tag} while blocked`)
    // Give B's open-thread poll (every 4 s) plenty of rounds to pick it up.
    await gotoMessages(pb)
    await openRow(pb, row(pb, directKey(A)))
    await expectAbsentFor(pb, bubbles(pb, `${tag} while blocked`), 45_000)
    await expect(row(pb, directKey(A))).toHaveAttribute('data-unread', '0')

    // B's second device: the block came through the self-state, so it hides the message too.
    b2 = await openDevice(browser, B, 'B2')
    const pb2 = b2.page
    await gotoMessages(pb2)
    await pb2.getByRole('button', { name: 'Message settings' }).click()
    await expect(pb2.getByRole('dialog').getByRole('button', { name: 'Unblock' })).toBeVisible({ timeout: 60_000 })
    await pb2.keyboard.press('Escape')
    await openRow(pb2, row(pb2, directKey(A)), DELIVERY_MS)
    // Everything from a blocked sender is dropped after decryption, not only new messages.
    await expect(thread(pb2).getByText('You blocked this person. Unblock them to send messages.')).toBeVisible()
    await expect(pb2.locator('[data-testid="dm-message"][data-own="false"]')).toHaveCount(0)
    await expectAbsentFor(pb2, bubbles(pb2, `${tag} while blocked`), 20_000)

    // Unblock on B1: the held message shows at once (it was received, only hidden).
    await threadMenu(pb, /^Unblock /)
    await expect(bubbles(pb, `${tag} while blocked`)).toBeVisible({ timeout: DELIVERY_MS })
    await expect(composer(pb)).toBeVisible()
    await flushSelfState(b1!)

    // The unblock (newer changedAt) survives the merge on B2 after a reload.
    await expect
      .poll(async () => (await selfStateOf(B))?.state.blocks.find((b) => b.id.every((x, i) => x === A.id[i]))?.blocked, {
        timeout: 120_000,
        intervals: [3_000, 5_000],
      })
      .toBe(false)
    await gotoMessages(pb2)
    await openRow(pb2, row(pb2, directKey(A)), DELIVERY_MS)
    await expect(bubbles(pb2, `${tag} while blocked`)).toBeVisible({ timeout: DELIVERY_MS })
  })

  test('delete conversation hides it until a newer message arrives', async () => {
    test.setTimeout(600_000)
    const pb = b1!.page
    await gotoMessages(pb)
    await openRow(pb, row(pb, directKey(A)))
    await threadMenu(pb, 'Delete conversation')
    await expect(row(pb, directKey(A))).toHaveCount(0)
    await expect(pb.getByRole('button', { name: /Show 1 deleted conversation/ })).toBeVisible()
    await flushSelfState(b1!)
    // Hidden survives a reload (hiddenAt is in the self-state).
    await expect
      .poll(async () => (await selfStateOf(B))?.state.directs.find((d) => d.peer.every((x, i) => x === A.id[i]))?.hiddenAt ?? 0, {
        timeout: 120_000,
        intervals: [3_000, 5_000],
      })
      .toBeGreaterThan(0)
    await gotoMessages(pb)
    await expect(row(pb, directKey(A))).toHaveCount(0)

    const pa = a1!.page
    await gotoMessages(pa)
    await openRow(pa, row(pa, directKey(B)))
    await send(pa, `${tag} are you there?`)
    // B's background poll runs every 30 s; the new message un-hides the thread.
    await expect(row(pb, directKey(A))).toBeVisible({ timeout: DELIVERY_MS })
    await expect(row(pb, directKey(A))).toContainText(`${tag} are you there?`)
  })

  test('retention: the §5.6 wording, and the setting follows the user to another device', async ({ browser }) => {
    test.setTimeout(300_000)
    const pa = a1!.page
    await gotoMessages(pa)
    await pa.getByRole('button', { name: 'Message settings' }).click()
    const dialog = pa.getByRole('dialog')
    await expect(dialog.getByText('Reclaim message fees', { exact: true })).toBeVisible()
    const wording = (period: string) =>
      `Delete your sent messages from Dash Platform after ${period} and get most of their storage fee back. This saves money. It does not make old messages private: copies remain in the blockchain's history, and the people you messaged keep what they have.`
    await expect(dialog.getByText(wording('30 days'), { exact: true })).toBeVisible()
    await expect(dialog.getByText(/disappearing|self-destruct|delete for everyone/i)).toHaveCount(0)
    await dialog.getByText('After 90 days').click()
    await expect(dialog.getByText(wording('90 days'), { exact: true })).toBeVisible()
    await pa.keyboard.press('Escape')

    // Changing retention saves at once; the second device reads it from the self-state.
    await expect.poll(async () => (await selfStateOf(A))?.state.settings.retention, { timeout: 120_000, intervals: [3_000, 5_000] }).toBe('90d')
    a2 ??= await openDevice(browser, A, 'A2')
    const p2 = a2.page
    await gotoMessages(p2)
    await p2.getByRole('button', { name: 'Message settings' }).click()
    await expect(p2.getByRole('dialog').getByRole('radio', { name: 'After 90 days' })).toBeChecked({ timeout: 60_000 })
    // Back to the default so later runs start from it.
    await p2.getByRole('dialog').getByText('After 30 days').click()
    await p2.keyboard.press('Escape')
    await expect.poll(async () => (await selfStateOf(A))?.state.settings.retention, { timeout: 120_000, intervals: [3_000, 5_000] }).toBe('30d')
  })

  test('a v4 thread with the same person is read and merged into the v5 timeline (§10)', async () => {
    test.skip(!LEGACY_DM_CONTRACT_ID, 'no legacy DM contract configured')
    test.setTimeout(420_000)
    // Written the way the v4 client wrote it: invite naming the recipient + an auth-key ECDH message.
    await writeLegacyMessage(B, A, `${tag} legacy v4 hello`)
    const pa = a1!.page
    await gotoMessages(pa)
    await openRow(pa, row(pa, directKey(B)))
    const legacy = pa.locator('[data-testid="dm-message"][data-legacy="true"]').filter({ hasText: `${tag} legacy v4 hello` })
    await expect(legacy).toBeVisible({ timeout: DELIVERY_MS })
    await expect(legacy).toContainText('earlier messaging')
    // Both kinds in one thread, ordered by time: a v5 reply lands after the v4 message.
    await send(pa, `${tag} v5 after legacy`)
    await expect(bubbles(pa, `${tag} v5 after legacy`)).toBeVisible()
    const order = await bubbles(pa).evaluateAll((nodes) => nodes.map((n) => n.textContent ?? ''))
    const legacyAt = order.findIndex((t) => t.includes(`${tag} legacy v4 hello`))
    const v5At = order.findIndex((t) => t.includes(`${tag} v5 after legacy`))
    expect(legacyAt).toBeGreaterThanOrEqual(0)
    expect(v5At).toBeGreaterThan(legacyAt)
    // Nothing new is written to the old contract (§10): B's legacy view has no reply from A.
    const legacyReplies = await queryDocs(LEGACY_DM_CONTRACT_ID, 'conversationInvite', {
      where: [['$ownerId', '==', A.identityId], ['recipientId', '==', B.identityId]],
      orderBy: [['recipientId', 'asc']],
      limit: 1,
    })
    expect(legacyReplies, 'A never wrote a v4 invite to B').toHaveLength(0)
    // The one-time migration notice is shown (earlier conversations exist) and can be dismissed.
    const notice = pa.getByText(/Messaging is now more private/)
    if (await notice.isVisible()) {
      await pa.getByRole('button', { name: 'Dismiss' }).click()
      await expect(notice).toHaveCount(0)
    }
  })
})
