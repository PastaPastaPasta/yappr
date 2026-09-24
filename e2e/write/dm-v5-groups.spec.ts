/**
 * DM v5 groups against the real moutai chain (docs/DM_V5.md §4.4, §5.2–§5.4,
 * §6.2, §6.4, §6.5). Owner A (slot 1), members B, C, D (slots 2–4), and E
 * (slot 5) as a non-member who forges.
 *
 * Covered, in order (serial):
 *  5. A creates {A, B, C}: everyone sees the name and members; each member
 *     posts and every other member receives it. Rename. Add D: D reads what is
 *     sent after joining and cannot read what came before. Remove C: C sees it
 *     was removed and cannot read new messages; the rest carry on; a message C
 *     writes on the old base after the removal is dropped by everyone. B
 *     leaves: A's client removes B on its next poll. "Resend keys" writes a
 *     fresh grant for a member. End: members see the tombstone.
 * 12. Security: a grant for this group forwarded by a non-owner (E, from
 *     Node, on E's own 1:1 stream with D) is ignored; a message a squatter
 *     puts at another member's next tag does not show, and that member's send
 *     retries at j + 1 and lands.
 */
import type { Page } from '@playwright/test'
import { bytesToHex } from '../../lib/bytes'
import { keyringHandle, rosterHandle } from '../../lib/dm/group'
import { encryptMessage, messageTag } from '../../lib/dm/stream'
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'
import {
  DM_V5_BUILD,
  IS_DEVNET_RUN,
  NOT_DEVNET_REASON,
  NOT_V5_REASON,
  POOL_REASON,
  SLOT,
  asBytes,
  bubbles,
  closeDevices,
  currentWeek,
  decryptAt,
  directKey,
  directStream,
  dmBot,
  expectAbsentFor,
  gotoMessages,
  groupDocsOf,
  groupStream,
  nextGroupNumber,
  openDevice,
  openRow,
  ownedGroup,
  ownerEpochKey,
  ownerRoster,
  pickUser,
  poolTooSmall,
  row,
  rowNamed,
  send,
  streamWeek,
  thread,
  threadMenu,
  writeInvite,
  writeMessage,
  writeRawMessage,
  type DmBot,
  type Device,
} from '../fixtures/dm'
import { uniqueTag } from '../fixtures/run-tag'

test.describe.configure({ mode: 'serial' })

const DELIVERY_MS = 180_000
const username = (bot: DmBot) => `yappr-dm-e2e-${bot.index}`
const groupKeyOf = (owner: DmBot, gid: Uint8Array) => `g:${owner.hex}:${bytesToHex(gid)}`

test.describe('DM v5: groups', () => {
  test.skip(!IS_DEVNET_RUN, NOT_DEVNET_REASON)
  test.skip(!DM_V5_BUILD, NOT_V5_REASON)
  test.skip(!hasSeedPhrase, NO_SEED_REASON)
  test.skip(poolTooSmall(), POOL_REASON)

  let A: DmBot, B: DmBot, C: DmBot, D: DmBot, E: DmBot
  const devices: Record<string, Device | undefined> = {}
  let tag = ''
  let name = ''
  let n = -1
  let gid: Uint8Array
  let key = ''

  const dev = async (browser: import('@playwright/test').Browser, bot: DmBot, label: string) => {
    devices[label] ??= await openDevice(browser, bot, label)
    return devices[label]!
  }

  /** Open the group thread on a device (from a fresh inbox load). */
  const openGroup = async (page: Page) => {
    await gotoMessages(page)
    await openRow(page, row(page, key), DELIVERY_MS)
  }

  const openSettings = async (page: Page) => {
    await threadMenu(page, 'Group settings')
    const dialog = page.getByRole('dialog', { name: 'Group settings' })
    await expect(dialog).toBeVisible()
    return dialog
  }

  /** Confirm in the ConfirmDialog titled `title` (the settings dialog stays open underneath). */
  const confirm = async (page: Page, title: string, text: string) => {
    await page.getByRole('dialog', { name: title }).getByRole('button', { name: text, exact: true }).click()
  }

  test.beforeEach(async () => {
    ;[A, B, C, D, E] = await Promise.all([SLOT.A, SLOT.B, SLOT.C, SLOT.D, SLOT.E].map((s) => dmBot(s)))
    tag ||= uniqueTag(SLOT.A)
  })

  test.afterAll(async () => {
    await closeDevices(Object.values(devices))
  })

  test('A creates a group with B and C; everyone sees its name and members', async ({ browser }) => {
    test.setTimeout(900_000)
    name = `grp ${tag.slice(-8)}`
    n = await nextGroupNumber(A)
    gid = ownedGroup(A, n).gid
    key = groupKeyOf(A, gid)

    const a = await dev(browser, A, 'A')
    await gotoMessages(a.page)
    await a.page.getByRole('button', { name: 'New conversation' }).click()
    await a.page.getByRole('menuitem', { name: 'New group' }).click()
    const dialog = a.page.getByRole('dialog', { name: 'New Group' })
    await dialog.getByLabel('Group name').fill(name)
    await pickUser(dialog, a.page, username(B))
    await pickUser(dialog, a.page, username(C))
    await expect(dialog.getByText('3 of 100 members, including you')).toBeVisible()
    await dialog.getByRole('button', { name: 'Create group' }).click()
    await expect(dialog).toBeHidden({ timeout: 300_000 })
    await expect(thread(a.page)).toHaveAttribute('data-key', key, { timeout: 60_000 })
    await expect(thread(a.page)).toContainText(name)
    await expect(thread(a.page)).toContainText('3 members')

    // On chain: the roster under A's handle, listing A, B, C at epoch (0, 0).
    const roster = await ownerRoster(A, n)
    expect(roster?.name).toBe(name)
    expect(roster?.members.map(bytesToHex).sort()).toEqual([A, B, C].map((x) => x.hex).sort())

    for (const [bot, label] of [[B, 'B'], [C, 'C']] as const) {
      const d = await dev(browser, bot, label)
      await gotoMessages(d.page)
      const r = row(d.page, key)
      await expect(r).toBeVisible({ timeout: DELIVERY_MS })
      await expect(r).toContainText(name)
      await expect(r).toContainText('3 members')
      // The grant-only 1:1 with A stays out of the inbox (the group shows instead), unless they already chat.
    }
  })

  test('each member posts and every other member receives it', async ({ browser }) => {
    test.setTimeout(900_000)
    const all = [
      [A, 'A'],
      [B, 'B'],
      [C, 'C'],
    ] as const
    for (const [bot, label] of all) {
      const d = await dev(browser, bot, label)
      await openGroup(d.page)
      await send(d.page, `${tag} from ${label}`)
    }
    for (const [bot, label] of all) {
      const d = await dev(browser, bot, label)
      for (const [, other] of all) {
        await expect(bubbles(d.page, `${tag} from ${other}`)).toBeVisible({ timeout: DELIVERY_MS })
      }
      // Group threads name the sender of others' messages.
      if (label !== 'A') await expect(thread(d.page).getByText(username(A)).first()).toBeVisible()
    }
  })

  test('rename: members see the new name', async ({ browser }) => {
    test.setTimeout(600_000)
    const a = await dev(browser, A, 'A')
    await openGroup(a.page)
    const dialog = await openSettings(a.page)
    name = `${name} v2`
    await dialog.getByLabel('Name').fill(name)
    await dialog.getByRole('button', { name: 'Rename' }).click()
    await expect(a.page.getByText('Group renamed')).toBeVisible({ timeout: 180_000 })
    await a.page.keyboard.press('Escape')
    expect((await ownerRoster(A, n))?.name).toBe(name)
    const b = await dev(browser, B, 'B')
    await gotoMessages(b.page)
    await expect(row(b.page, key)).toContainText(name, { timeout: DELIVERY_MS })
  })

  test('add D: D reads what is sent after joining, not before', async ({ browser }) => {
    test.setTimeout(900_000)
    const a = await dev(browser, A, 'A')
    await openGroup(a.page)
    const dialog = await openSettings(a.page)
    await dialog.getByRole('button', { name: 'Add member' }).click()
    await pickUser(dialog, a.page, username(D))
    await expect(a.page.getByText(/added$/)).toBeVisible({ timeout: 240_000 })
    await a.page.keyboard.press('Escape')
    const roster = await ownerRoster(A, n)
    expect(roster?.members.map(bytesToHex)).toContain(D.hex)
    expect(roster?.r).toBeGreaterThanOrEqual(1)

    const b = await dev(browser, B, 'B')
    await openGroup(b.page)
    await send(b.page, `${tag} welcome D`)

    const d = await dev(browser, D, 'D')
    await gotoMessages(d.page)
    await openRow(d.page, row(d.page, key), DELIVERY_MS)
    await expect(bubbles(d.page, `${tag} welcome D`)).toBeVisible({ timeout: DELIVERY_MS })
    await expect(thread(d.page)).toContainText('4 members')
    // Messages from before D joined were on (0, 0): D's key is (0, r ≥ 1) and cannot step back.
    await expectAbsentFor(d.page, bubbles(d.page, `${tag} from A`), 15_000)
    await expect(bubbles(d.page, `${tag} from B`)).toHaveCount(0)
  })

  test('a grant forwarded by a non-owner is ignored (security)', async ({ browser }) => {
    test.setTimeout(600_000)
    // E is not in the group. On its own 1:1 stream with D, E sends a grant carrying the REAL
    // current key of A's group (as a member could leak it). A grant is accepted only from the
    // roster's owner (§6.2): the roster at roster(gid) under E does not exist, so D ignores it.
    const { secret } = ownedGroup(A, n)
    const roster = await ownerRoster(A, n)
    const keyNow = await ownerEpochKey(A, gid, secret, roster!.b, roster!.r)
    const w = currentWeek()
    const stream = directStream(E, D, E)
    const existing = await streamWeek(stream, w)
    const j = (existing.at(-1)?.j ?? -1) + 1
    // First contact from E so D polls the stream: an invite, then the forged grant as E's first message.
    await writeInvite(E, D)
    await writeMessage(E, stream, w, j, { prev: existing.at(-1) ? { w, b: 0, r: 0, j: j - 1 } : null, content: { type: 'grant', grant: { gid, b: roster!.b, r: roster!.r, key: keyNow } } })
    const forgedKey = groupKeyOf(E, gid)
    const d = await dev(browser, D, 'D')
    await gotoMessages(d.page)
    // D keeps the real group and never shows one "owned" by E (the roster lives only under A).
    await expect(row(d.page, key)).toBeVisible({ timeout: DELIVERY_MS })
    await expectAbsentFor(d.page, row(d.page, forgedKey), 75_000)
    // A 1:1 holding only a grant is not shown either (§6.2).
    await expect(row(d.page, directKey(E))).toHaveCount(0)
  })

  test('a squatter at a member\'s next tag is ignored, and the member\'s send retries at j + 1 (security)', async ({ browser }) => {
    test.setTimeout(900_000)
    // C (a member, so able to compute B's tags) squats B's next tag on the current epoch.
    const { secret } = ownedGroup(A, n)
    const roster = (await ownerRoster(A, n))!
    const epochKey = await ownerEpochKey(A, gid, secret, roster.b, roster.r)
    const bStream = groupStream(A, epochKey, B)
    const w = currentWeek()

    // A is already reading the group live: its poll asks for B's NEXT tag, the one about to be squatted.
    const a = await dev(browser, A, 'A')
    await openGroup(a.page)
    const b = await dev(browser, B, 'B')
    await openGroup(b.page)
    await send(b.page, `${tag} B before squat`)
    await expect(bubbles(a.page, `${tag} B before squat`)).toBeVisible({ timeout: DELIVERY_MS })

    const taken = await streamWeek(bStream, w)
    const nextJ = (taken.at(-1)?.j ?? -1) + 1
    const squat = await encryptMessage({ streamKey: bStream, senderId: B.id, w, j: nextJ }, { prev: null, content: { type: 'text', text: `${tag} SQUAT impersonating B` } })
    await writeRawMessage(C, squat.tag, squat.body)

    await send(b.page, `${tag} B after squat`)
    const after = await streamWeek(bStream, w)
    const mine = after.filter((x) => x.ownerId === B.identityId)
    const squatted = after.find((x) => x.j === nextJ)
    expect(squatted?.ownerId, 'the squatter holds the tag').toBe(C.identityId)
    expect(mine.some((x) => x.j === nextJ + 1), 'B wrote past the squatted slot, at j + 1').toBe(true)

    // A, still on the same page load, reads past the squatted slot to B's message (no reload).
    await expect(bubbles(a.page, `${tag} B after squat`)).toBeVisible({ timeout: DELIVERY_MS })
    await expectAbsentFor(a.page, bubbles(a.page, 'SQUAT impersonating B'), 20_000)
    // B's own devices ignore it too.
    await expect(bubbles(b.page, 'SQUAT impersonating B')).toHaveCount(0)
    expect(messageTag(bStream, w, nextJ)).toEqual(squat.tag)
  })

  test('remove C: C is cut off, the others carry on, and C\'s old-base writes are dropped', async ({ browser }) => {
    test.setTimeout(900_000)
    const before = (await ownerRoster(A, n))!
    const a = await dev(browser, A, 'A')
    await openGroup(a.page)
    const dialog = await openSettings(a.page)
    const cRow = dialog.getByRole('listitem').filter({ hasText: username(C) })
    await cRow.getByRole('button', { name: 'Remove' }).click()
    await confirm(a.page, 'Remove member?', 'Remove')
    await expect(a.page.getByText('Member removed')).toBeVisible({ timeout: 300_000 })
    await a.page.keyboard.press('Escape')
    const after = (await ownerRoster(A, n))!
    expect(after.b).toBe(before.b + 1)
    expect(after.members.map(bytesToHex)).not.toContain(C.hex)
    // The keyring for the new base exists (a permanent document).
    expect(await groupDocsOf(A, [keyringHandle(gid, after.b)])).toHaveLength(1)

    await send(a.page, `${tag} after removing C`)

    // C: removed notice, and the new message never shows.
    const c = await dev(browser, C, 'C')
    await gotoMessages(c.page)
    await expect(row(c.page, key)).toContainText('You are no longer in this group', { timeout: DELIVERY_MS })
    await openRow(c.page, row(c.page, key))
    await expect(thread(c.page).getByText('You are no longer a member of this group.')).toBeVisible()
    await expectAbsentFor(c.page, bubbles(c.page, `${tag} after removing C`), 20_000)

    // C writes on the OLD base after the removal (a client that missed the keyring, or a
    // malicious one): readers drop it — keyringAt < its $createdAt and C is not in the roster.
    const { secret } = ownedGroup(A, n)
    const oldKey = await ownerEpochKey(A, gid, secret, before.b, before.r)
    const cOld = groupStream(A, oldKey, C)
    const w = currentWeek()
    const cDocs = await streamWeek(cOld, w)
    const j = (cDocs.at(-1)?.j ?? -1) + 1
    await writeMessage(C, cOld, w, j, { prev: cDocs.length ? { w, b: before.b, r: before.r, j: j - 1 } : null, content: { type: 'text', text: `${tag} C late on old base` } })

    // B and D read the new base and continue; neither shows C's late write.
    for (const [bot, label] of [[B, 'B'], [D, 'D']] as const) {
      const d = await dev(browser, bot, label)
      await openGroup(d.page)
      await expect(bubbles(d.page, `${tag} after removing C`)).toBeVisible({ timeout: DELIVERY_MS })
      await expect(thread(d.page)).toContainText('3 members')
    }
    const b = await dev(browser, B, 'B')
    await send(b.page, `${tag} B on new base`)
    await expect(bubbles(a.page, `${tag} B on new base`)).toBeVisible({ timeout: DELIVERY_MS })
    for (const label of ['A', 'B', 'D']) {
      await expectAbsentFor(devices[label]!.page, bubbles(devices[label]!.page, 'C late on old base'), 10_000)
    }
  })

  test('B leaves: A\'s client removes B on its next poll', async ({ browser }) => {
    test.setTimeout(900_000)
    const b = await dev(browser, B, 'B')
    await openGroup(b.page)
    const dialog = await openSettings(b.page)
    await dialog.getByRole('button', { name: 'Leave group' }).click()
    await confirm(b.page, 'Leave this group?', 'Leave')
    await expect(b.page.getByText('You left the group')).toBeVisible({ timeout: 180_000 })
    // B's inbox stops showing it.
    await gotoMessages(b.page)
    await expect(row(b.page, key)).toHaveCount(0, { timeout: 60_000 })

    // A's next poll sees the leave (0x02) and writes a keyring without B.
    const a = await dev(browser, A, 'A')
    await gotoMessages(a.page)
    await expect
      .poll(async () => (await ownerRoster(A, n))?.members.map(bytesToHex).includes(B.hex), { timeout: 300_000, intervals: [5_000, 10_000] })
      .toBe(false)
    await openGroup(a.page)
    await expect(thread(a.page)).toContainText('2 members', { timeout: DELIVERY_MS })
  })

  test('resend keys: the owner writes a fresh grant to a member', async ({ browser }) => {
    test.setTimeout(600_000)
    const w = currentWeek()
    const toD = directStream(A, D, A)
    const before = (await streamWeek(toD, w)).length
    const a = await dev(browser, A, 'A')
    await openGroup(a.page)
    const dialog = await openSettings(a.page)
    await dialog.getByRole('listitem').filter({ hasText: username(D) }).getByRole('button', { name: 'Resend keys' }).click()
    await expect(a.page.getByText('Keys sent')).toBeVisible({ timeout: 180_000 })
    await a.page.keyboard.press('Escape')
    const after = await streamWeek(toD, w)
    expect(after.length).toBe(before + 1)
    // It is a grant for this group at the current epoch, readable by D.
    const last = after.at(-1)!
    const m = await decryptAt(toD, A, w, last.j, last.doc)
    expect(m?.content.type).toBe('grant')
    if (m?.content.type === 'grant') {
      expect(bytesToHex(m.content.grant.gid)).toBe(bytesToHex(gid))
      const roster = (await ownerRoster(A, n))!
      expect([m.content.grant.b, m.content.grant.r]).toEqual([roster.b, roster.r])
    }
    // D still reads the group.
    const d = await dev(browser, D, 'D')
    await send(a.page, `${tag} after resend`)
    await openGroup(d.page)
    await expect(bubbles(d.page, `${tag} after resend`)).toBeVisible({ timeout: DELIVERY_MS })
  })

  test('end group: the roster becomes a tombstone and members see it ended', async ({ browser }) => {
    test.setTimeout(600_000)
    const a = await dev(browser, A, 'A')
    await openGroup(a.page)
    const dialog = await openSettings(a.page)
    await dialog.getByRole('button', { name: 'End group' }).click()
    await confirm(a.page, 'End this group?', 'End group')
    await expect(a.page.getByText('Group ended')).toBeVisible({ timeout: 180_000 })
    expect((await ownerRoster(A, n))?.ended).toBe(true)
    const [doc] = await groupDocsOf(A, [rosterHandle(gid)])
    expect(asBytes(doc.blob).length).toBeLessThanOrEqual(128 + 28)

    const d = await dev(browser, D, 'D')
    await gotoMessages(d.page)
    await expect(row(d.page, key)).toContainText('This group has ended', { timeout: DELIVERY_MS })
    await openRow(d.page, row(d.page, key))
    await expect(thread(d.page).getByText('This group has ended.')).toBeVisible()
    await expect(rowNamed(d.page, name)).toHaveCount(1)
  })
})
