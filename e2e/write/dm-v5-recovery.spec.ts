/**
 * DM v5 lost-state recovery against the real moutai chain (docs/DM_V5.md §9).
 * Actors: G (slot 7), whose state is lost, and H (slot 8), who wrote to G.
 *
 *  9. A self-state can only be lost through a bug or a lost key; the
 *     contract lets its owner delete it (dmSelfState is owner-deletable), so
 *     the test deletes G's from Node — the closest honest stand-in for "the
 *     self-state never saved". G then opens the app on a device with empty
 *     storage. It has written DM v5 documents but has no self-state, so it
 *     runs recovery: H's conversation comes back from the invite rescan
 *     (starting as read, §9), with its messages; the recovered state is saved.
 *     Also: a cleared device (storage wiped, self-state intact) rebuilds from
 *     the self-state alone with no recovery.
 */
import { appUrl } from '../fixtures/app'
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'
import {
  DM_V5_BUILD,
  DM_V5_CONTRACT_ID,
  IS_DEVNET_RUN,
  NOT_DEVNET_REASON,
  NOT_V5_REASON,
  POOL_REASON,
  SLOT,
  bubbles,
  closeDevices,
  deleteDoc,
  directKey,
  dmBot,
  flushSelfState,
  gotoMessages,
  hasDirect,
  openDevice,
  openRow,
  poolTooSmall,
  queryDocs,
  row,
  selfStateOf,
  send,
  thread,
  type DmBot,
  type Device,
} from '../fixtures/dm'
import { uniqueTag } from '../fixtures/run-tag'

test.describe.configure({ mode: 'serial' })

const DELIVERY_MS = 180_000

test.describe('DM v5: lost-state recovery', () => {
  test.skip(!IS_DEVNET_RUN, NOT_DEVNET_REASON)
  test.skip(!DM_V5_BUILD, NOT_V5_REASON)
  test.skip(!hasSeedPhrase, NO_SEED_REASON)
  test.skip(poolTooSmall(), POOL_REASON)

  let G: DmBot
  let H: DmBot
  const devices: Device[] = []
  let tag = ''

  test.beforeEach(async () => {
    G = await dmBot(SLOT.G)
    H = await dmBot(SLOT.H)
    tag ||= uniqueTag(SLOT.G)
  })

  test.afterAll(async () => {
    await closeDevices(devices)
  })

  test('setup: H writes to G, G reads and replies (G has written, and has a self-state)', async ({ browser }) => {
    test.setTimeout(600_000)
    const h = await openDevice(browser, H, 'H')
    devices.push(h)
    await gotoMessages(h.page, `?startConversation=${G.identityId}`)
    await expect(thread(h.page)).toBeVisible({ timeout: 60_000 })
    await send(h.page, `${tag} H to G`)

    const g = await openDevice(browser, G, 'G1')
    devices.push(g)
    await gotoMessages(g.page)
    await openRow(g.page, row(g.page, directKey(H)), DELIVERY_MS)
    await expect(bubbles(g.page, `${tag} H to G`)).toBeVisible({ timeout: DELIVERY_MS })
    await send(g.page, `${tag} G replies`)
    await flushSelfState(g)
    await expect.poll(async () => {
      const saved = await selfStateOf(G)
      return Boolean(saved && hasDirect(saved.state, H))
    }, { timeout: 180_000, intervals: [3_000, 5_000] }).toBe(true)
    await g.context.close()
  })

  test('a device with wiped storage rebuilds from the self-state alone', async ({ browser }) => {
    test.setTimeout(300_000)
    const g = await openDevice(browser, G, 'G2')
    devices.push(g)
    await gotoMessages(g.page)
    await expect(g.page.getByText('Restoring your messages')).toHaveCount(0)
    await openRow(g.page, row(g.page, directKey(H)), DELIVERY_MS)
    await expect(bubbles(g.page, `${tag} H to G`)).toBeVisible({ timeout: DELIVERY_MS })
    await expect(bubbles(g.page, `${tag} G replies`)).toBeVisible({ timeout: DELIVERY_MS })
    await g.context.close()
  })

  test('lost self-state: G\'s incoming chat comes back through the invite rescan, starting as read', async ({ browser }) => {
    test.setTimeout(900_000)
    const saved = await selfStateOf(G)
    expect(saved, 'G has a self-state to lose').not.toBeNull()
    await deleteDoc(G, DM_V5_CONTRACT_ID, 'dmSelfState', saved!.id, async () =>
      (await queryDocs(DM_V5_CONTRACT_ID, 'dmSelfState', { where: [['$ownerId', '==', G.identityId]], limit: 1 })).length === 0
    )

    // H sends once more while G's state is gone.
    const h = devices.find((d) => d.label === 'H')!
    await gotoMessages(h.page)
    await openRow(h.page, row(h.page, directKey(G)))
    await send(h.page, `${tag} while G was lost`)

    const g = await openDevice(browser, G, 'G3')
    devices.push(g)
    await g.page.goto(appUrl('/messages/'), { waitUntil: 'domcontentloaded' })
    // Recovery runs in the background with a progress notice, or finishes before we look.
    const row_ = row(g.page, directKey(H))
    await expect(row_).toBeVisible({ timeout: DELIVERY_MS })
    // Recovered conversations start as read (§9): no unread badge even though H wrote after.
    await expect(row_).toHaveAttribute('data-unread', '0')
    await openRow(g.page, row_)
    await expect(bubbles(g.page, `${tag} while G was lost`)).toBeVisible({ timeout: DELIVERY_MS })
    await expect(bubbles(g.page, `${tag} H to G`)).toBeVisible({ timeout: DELIVERY_MS })
    // G's own earlier reply is found too (own stream probed on the recovered conversation).
    await expect(bubbles(g.page, `${tag} G replies`)).toBeVisible({ timeout: DELIVERY_MS })
    await expect(g.page.getByText('Restoring your messages')).toHaveCount(0, { timeout: DELIVERY_MS })

    // Recovery saves what it found: the self-state exists again and lists H.
    await expect.poll(async () => {
      const again = await selfStateOf(G)
      return Boolean(again && hasDirect(again.state, H))
    }, { timeout: 180_000, intervals: [3_000, 5_000] }).toBe(true)

    // And G can keep talking in the same thread.
    await send(g.page, `${tag} G is back`)
    await gotoMessages(h.page)
    await openRow(h.page, row(h.page, directKey(G)))
    await expect(bubbles(h.page, `${tag} G is back`)).toBeVisible({ timeout: DELIVERY_MS })
  })
})
