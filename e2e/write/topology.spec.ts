/**
 * The v3 interaction topology, exercised against a real chain.
 *
 * Everything here is a claim the contract's shape makes that the client has to
 * honour, and that a unit test could not check because it depends on consensus:
 * a reply names its thread ROOT so a reply-to-a-reply must appear in the root's
 * thread; reply likes live in their own `likeReply` doctype; `repost.postId` and
 * `bookmark.postId` are `refersTo`-checked against `post`, so those controls must
 * not exist on a reply card at all; a quote of a reply goes in `quotedReplyId`;
 * and `post`/`reply` are `canBeDeleted: false`, so "delete" leaves a tombstone.
 *
 * This runs against the moutai devnet (`.env.devnet` — the only deployment on the
 * v3 contract) and self-skips anywhere else, since on v2 every assertion below is
 * either meaningless or actively wrong. Drive it with:
 *
 *   npm run build:devnet
 *   E2E_BASE_PATH=/devnet E2E_ENV_FILE=.env.devnet NETWORK=devnet npx playwright test topology
 *
 * Ordering matters — later steps operate on the documents earlier ones created —
 * so the whole file runs serially and aborts the rest on the first failure.
 *
 * Assertion strategy follows post-lifecycle.spec.ts: assert optimistically right
 * after each action (the app updates as soon as a transition is broadcast, because
 * DAPI's confirmation wait times out routinely), then use reloading polls for
 * anything that has to come back out of a chain query.
 */
import type { Locator } from '@playwright/test'
import { appUrl } from '../fixtures/app'
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'
import { expectedSocialContractId, expectedTopology } from '../fixtures/contracts'
import { reloadUntilVisible } from '../fixtures/eventual'
import { uniqueTag } from '../fixtures/run-tag'

test.describe.configure({ mode: 'serial' })

/** Broadcast waits are long and chained; each write test budgets its own. */
const COMPOSE_TIMEOUT = 120_000

/**
 * The devnet run is the only one this file applies to, and it is identified the
 * same way the build is: by which env file was selected. Read synchronously so it
 * can gate the whole describe — a per-test `test.skip` would leave the rest of a
 * serial group running against the wrong contract.
 */
const IS_DEVNET_RUN = (process.env.E2E_ENV_FILE ?? '').includes('devnet')
const NOT_DEVNET_REASON =
  'E2E_ENV_FILE does not select the devnet deployment — the v3 topology is only deployed there'

test.describe('v3 interaction topology on the devnet contract', () => {
  test.skip(!IS_DEVNET_RUN, NOT_DEVNET_REASON)
  test.skip(!hasSeedPhrase, NO_SEED_REASON)

  let runTag = ''
  let rootPostId = ''
  let firstReplyId = ''
  let firstReplyText = ''
  let nestedReplyText = ''

  /**
   * Compose from the currently open dialog and wait for it to close, which is the
   * app's own signal that the transition was broadcast (on failure it stays open
   * with a retry affordance).
   */
  const submitCompose = async (dialog: Locator, text: string) => {
    await dialog.getByTestId('compose-textarea').first().fill(text)
    await dialog.getByTestId('compose-submit-btn').click()
    await expect(dialog).toBeHidden({ timeout: COMPOSE_TIMEOUT })
  }

  test('the build under test targets the v3 devnet contract', async ({ page }) => {
    const [contractId, topology] = await Promise.all([expectedSocialContractId(), expectedTopology()])
    expect(contractId, 'the env file must define NEXT_PUBLIC_YAPPR_CONTRACT_ID').not.toBe('')

    // The describe already skipped anything that is not the devnet run, so a
    // topology other than v3 here means the devnet env file lost its flag — which
    // would make every assertion below fail against the UI instead of naming the
    // real problem.
    expect(topology, 'the devnet env file must set NEXT_PUBLIC_CONTRACT_TOPOLOGY=v3').toBe('v3')

    await page.goto(appUrl('/about/'))
    await expect(page.getByText(contractId, { exact: true })).toBeVisible()
    await expect(page.getByTestId('about-topology')).toHaveText('v3')
  })

  test('a root post and a reply to it are created', async ({ page, bot }) => {
    test.setTimeout(420_000)

    runTag = uniqueTag(bot.index)
    firstReplyText = `${runTag} first reply`

    await page.goto(appUrl('/feed/'))
    await page.getByTestId('open-compose-btn').click()
    const composeDialog = page.getByRole('dialog', { name: 'Create a new post' })
    await expect(composeDialog).toBeVisible()
    await submitCompose(composeDialog, `${runTag} topology root post`)

    const card = await reloadUntilVisible(
      page,
      appUrl(`/user?id=${bot.identityId}`),
      (p) => p.locator('[data-testid^="post-card-"]').filter({ hasText: `${runTag} topology root post` })
    )
    rootPostId = ((await card.getAttribute('data-testid')) ?? '').replace('post-card-', '')
    expect(rootPostId, 'the post card should expose the document id').not.toBe('')

    await page.goto(appUrl(`/post?id=${rootPostId}`))
    await expect(page.getByTestId(`post-card-${rootPostId}`)).toBeVisible({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Post your reply' }).click()

    const replyDialog = page.getByRole('dialog', { name: 'Reply to post' })
    await expect(replyDialog).toBeVisible()
    await submitCompose(replyDialog, firstReplyText)

    const replyCard = await reloadUntilVisible(page, appUrl(`/post?id=${rootPostId}`), (p) =>
      p.locator('[data-testid^="post-card-"]').filter({ hasText: firstReplyText })
    )
    firstReplyId = ((await replyCard.getAttribute('data-testid')) ?? '').replace('post-card-', '')
    expect(firstReplyId, 'the reply card should expose the document id').not.toBe('')
  })

  test('a reply to that reply renders in the ROOT thread', async ({ page }) => {
    // The point of the flat model: the nested reply carries rootPostId = the root
    // post, so it belongs to (and is rendered on) the root's page — not on a
    // sub-page of the reply it answers.
    test.setTimeout(420_000)

    nestedReplyText = `${runTag} nested reply`

    await page.goto(appUrl(`/post?id=${rootPostId}`))
    await expect(page.getByTestId(`reply-btn-${firstReplyId}`)).toBeVisible({ timeout: 60_000 })
    await page.getByTestId(`reply-btn-${firstReplyId}`).click()

    const dialog = page.getByRole('dialog', { name: 'Reply to post' })
    await expect(dialog).toBeVisible()
    await submitCompose(dialog, nestedReplyText)

    // Optimistic insert first, then the real read-back from the root's thread query.
    await expect(page.getByText(nestedReplyText)).toBeVisible()

    await reloadUntilVisible(page, appUrl(`/post?id=${rootPostId}`), (p) =>
      p.locator('[data-testid^="post-card-"]').filter({ hasText: nestedReplyText })
    )
  })

  test('repost and bookmark controls are absent on a reply card', async ({ page }) => {
    // Consensus rejects a reply id on repost.postId / bookmark.postId, so offering
    // the controls would be offering a write that cannot succeed. The root post's
    // own card, on the same page, still has both.
    test.setTimeout(120_000)

    await page.goto(appUrl(`/post?id=${rootPostId}`))
    await expect(page.getByTestId(`post-card-${firstReplyId}`)).toBeVisible({ timeout: 60_000 })

    await expect(page.getByTestId(`bookmark-btn-${firstReplyId}`)).toHaveCount(0)

    // The repost/quote dropdown still exists on a reply (quoting IS allowed), so
    // this checks the menu's contents rather than the trigger.
    await page.getByTestId(`repost-menu-btn-${firstReplyId}`).click()
    await expect(page.getByRole('menuitem', { name: 'Quote' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /Repost/ })).toHaveCount(0)
    await page.keyboard.press('Escape')

    // The root post's card, on the same page, still has both — so this is the
    // topology talking, not a missing control.
    await expect(page.getByTestId(`bookmark-btn-${rootPostId}`)).toHaveCount(1)
    await page.getByTestId(`repost-menu-btn-${rootPostId}`).click()
    await expect(page.getByRole('menuitem', { name: /Repost/ })).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('liking a reply toggles and persists', async ({ page }) => {
    // A reply's like is a `likeReply` document keyed on replyId, a doctype the v2
    // contract does not have — so a persisted toggle proves the split wiring end
    // to end (write, unique-index read-back, and count).
    test.setTimeout(300_000)

    await page.goto(appUrl(`/post?id=${rootPostId}`))
    const likeButton = page.getByTestId(`like-btn-${firstReplyId}`)
    await expect(likeButton).toBeVisible({ timeout: 60_000 })
    await expect(likeButton).toHaveAttribute('aria-pressed', 'false')

    await likeButton.click()
    await expect(likeButton).toHaveAttribute('aria-pressed', 'true')
    await expect(likeButton).toBeEnabled({ timeout: 60_000 })
    await expect(likeButton).toHaveAttribute('aria-pressed', 'true')

    // Reload: the pressed state now has to come back out of a likeReply query.
    await reloadUntilVisible(page, appUrl(`/post?id=${rootPostId}`), (p) =>
      p.getByTestId(`like-btn-${firstReplyId}`).and(p.locator('[aria-pressed="true"]'))
    )

    // Unlike, so a re-run of this spec on the same identity starts clean.
    const toggled = page.getByTestId(`like-btn-${firstReplyId}`)
    await toggled.click()
    await expect(toggled).toHaveAttribute('aria-pressed', 'false')
    await expect(toggled).toBeEnabled({ timeout: 60_000 })
  })

  test('a quote of a reply renders the quoted reply', async ({ page, bot }) => {
    // Written to post.quotedReplyId (refersTo reply) and read back through
    // field-directed resolution — a v2 client would have written the reply id to
    // quotedPostId, which consensus now rejects.
    test.setTimeout(420_000)

    const quoteText = `${runTag} quote of a reply`

    await page.goto(appUrl(`/post?id=${rootPostId}`))
    const replyCard = page.getByTestId(`post-card-${firstReplyId}`)
    await expect(replyCard).toBeVisible({ timeout: 60_000 })

    await replyCard.locator('button[aria-haspopup="menu"]').last().click()
    await page.getByRole('menuitem', { name: 'Quote' }).click()

    const dialog = page.getByRole('dialog', { name: 'Quote post' })
    await expect(dialog).toBeVisible()
    await submitCompose(dialog, quoteText)

    // The quote post carries the quoted reply's text in an embedded card, so
    // finding both strings on one card is the assertion.
    await reloadUntilVisible(page, appUrl(`/user?id=${bot.identityId}`), (p) =>
      p
        .locator('[data-testid^="post-card-"]')
        .filter({ hasText: quoteText })
        .filter({ hasText: firstReplyText })
    )
  })

  test('deleting the nested reply leaves a tombstone card', async ({ page }) => {
    // reply is canBeDeleted:false, so this is a replace that blanks the content
    // and sets deleted:true. The document — and every refersTo reference to it —
    // survives; only the text goes.
    test.setTimeout(300_000)

    await page.goto(appUrl(`/post?id=${rootPostId}`))
    const nestedCard = page.locator('[data-testid^="post-card-"]').filter({ hasText: nestedReplyText })
    await expect(nestedCard).toBeVisible({ timeout: 60_000 })

    await nestedCard.locator('button[aria-haspopup="menu"]').first().click()
    await page.getByRole('menuitem', { name: /Delete/ }).click()

    const confirm = page.getByRole('dialog', { name: /Delete/ })
    await expect(confirm).toBeVisible()
    // The copy must not promise a permanent removal on a permanent-document contract.
    await expect(confirm.getByText(/tombstone remains on-chain/)).toBeVisible()
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(confirm).toBeHidden({ timeout: COMPOSE_TIMEOUT })

    // The text is gone from the thread and the deleted card is in its place.
    await reloadUntilVisible(page, appUrl(`/post?id=${rootPostId}`), (p) =>
      p.getByText('This reply was deleted.')
    )
    await expect(page.getByText(nestedReplyText)).toHaveCount(0)
  })
})
