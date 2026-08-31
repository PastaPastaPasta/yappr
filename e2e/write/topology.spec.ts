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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
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
  'E2E_ENV_FILE does not select the devnet deployment — the v3+ topologies are only deployed there'

/**
 * Synchronous topology read (same sources `expectedTopology()` uses), so the
 * describe gates can be decided at collection time: a per-test skip inside a
 * serial group would leave later tests running against the wrong contract.
 */
function compiledTopology(): string {
  const fromEnv = process.env.NEXT_PUBLIC_CONTRACT_TOPOLOGY
  if (fromEnv) return fromEnv
  try {
    const file = process.env.E2E_ENV_FILE?.trim() || '.env.testing'
    const match = readFileSync(join(process.cwd(), file), 'utf8')
      .match(/^NEXT_PUBLIC_CONTRACT_TOPOLOGY=(\S+)/m)
    return match?.[1] ?? 'v2'
  } catch {
    return 'v2'
  }
}
const SPEC_TOPOLOGY = compiledTopology()

// Everything in the first describe holds on v3, v4 AND v5: the v4/v5 contracts
// keep v3's document graph (flat threads, likeReply, posts-only
// repost/bookmark, dual quote fields, tombstones) and change only how likes
// and hashtags are stored — which makes the reply-like test double as live
// coverage of the v4/v5 indexOnly likeReply path (agreement-bound create +
// delete-by-values unlike).
test.describe('v3+ interaction topology on the devnet contract', () => {
  test.skip(!IS_DEVNET_RUN, NOT_DEVNET_REASON)
  test.skip(!['v3', 'v4', 'v5'].includes(SPEC_TOPOLOGY), 'the compiled topology predates the v3 document graph')
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

  test('the build under test targets the expected devnet contract and topology', async ({ page }) => {
    const [contractId, topology] = await Promise.all([expectedSocialContractId(), expectedTopology()])
    expect(contractId, 'the env file must define NEXT_PUBLIC_YAPPR_CONTRACT_ID').not.toBe('')

    // The describe already skipped anything that is not the devnet run, so a
    // topology outside the v3 family here means the devnet env file lost its
    // flag — which would make every assertion below fail against the UI instead
    // of naming the real problem.
    expect(['v3', 'v4', 'v5'], 'the devnet env file must set NEXT_PUBLIC_CONTRACT_TOPOLOGY to v3, v4 or v5').toContain(topology)
    expect(topology, 'sync and async topology reads must agree').toBe(SPEC_TOPOLOGY)

    await page.goto(appUrl('/about/'))
    await expect(page.getByText(contractId, { exact: true })).toBeVisible()
    // /about prints the compiled-in descriptor value — the build's own claim.
    await expect(page.getByTestId('about-topology')).toHaveText(topology)
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

/**
 * The v4-only surfaces: indexOnly post likes end to end, the inline single
 * hashtag, and the server-ranked profile Top tab.
 *
 * What each step proves on-chain:
 * - the tagged post carries `author` + `hashtag` (consensus rejects a v4 post
 *   without them, so its very existence is the assertion), and appears on the
 *   tag page via `post.tagAndTime` — no postHashtag documents exist to serve it;
 * - a like is an indexOnly create whose agreement-bound values matched (40127
 *   rejects otherwise), read back through `byLiker` after reload;
 * - the visible count comes from the countable `byPost` axis;
 * - the profile feed's pressed state is the batched `in`-membership query;
 * - unlike is a delete-by-values whose tuple (incl. the consensus `$createdAt`)
 *   was recovered from `byAuthorTimePost`; re-like proves the entries really
 *   left the trees (a duplicate would be rejected structurally, 40105);
 * - the Top tab renders from a proved `documents.ranked()` page on
 *   `byAuthorPost` pinned to the author;
 * - the explore Top tab renders the GLOBAL ranked page (`byPost`, unpinned) and
 *   the tag page's Top toggle the tag-pinned one (`byHashtagPost` — fed by the
 *   like's agreement-bound `hashtag` copy);
 * - the trending widget is client-derived activity (inline hashtags of recent
 *   posts, deliberately unproven) and is labeled as such.
 */
test.describe('v4 indexOnly like lifecycle on the devnet contract', () => {
  test.skip(!IS_DEVNET_RUN, NOT_DEVNET_REASON)
  test.skip(SPEC_TOPOLOGY !== 'v4', 'the compiled topology has stored likes — indexOnly surfaces do not exist')
  test.skip(!hasSeedPhrase, NO_SEED_REASON)

  let runTag = ''
  let hashtag = ''
  let postId = ''
  let postText = ''

  test('a tagged post is created and listed on its tag page', async ({ page, bot }) => {
    test.setTimeout(420_000)

    runTag = uniqueTag(bot.index)
    // A run-unique tag, so the tag page assertion can only match this run's post.
    hashtag = `v4${runTag.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`.slice(0, 63)
    postText = `${runTag} v4 like target #${hashtag}`

    await page.goto(appUrl('/feed/'))
    await page.getByTestId('open-compose-btn').click()
    const composeDialog = page.getByRole('dialog', { name: 'Create a new post' })
    await expect(composeDialog).toBeVisible()
    await composeDialog.getByTestId('compose-textarea').first().fill(postText)
    await composeDialog.getByTestId('compose-submit-btn').click()
    await expect(composeDialog).toBeHidden({ timeout: COMPOSE_TIMEOUT })

    const card = await reloadUntilVisible(
      page,
      appUrl(`/user?id=${bot.identityId}`),
      (p) => p.locator('[data-testid^="post-card-"]').filter({ hasText: runTag })
    )
    postId = ((await card.getAttribute('data-testid')) ?? '').replace('post-card-', '')
    expect(postId, 'the post card should expose the document id').not.toBe('')

    // Inline hashtag: the tag page lists the post straight off post.tagAndTime.
    await reloadUntilVisible(page, appUrl(`/hashtag?tag=${hashtag}`), (p) =>
      p.locator('[data-testid^="post-card-"]').filter({ hasText: runTag })
    )
  })

  test('liking the post persists and its count is served from the count tree', async ({ page }) => {
    test.setTimeout(300_000)

    await page.goto(appUrl(`/post?id=${postId}`))
    const likeButton = page.getByTestId(`like-btn-${postId}`)
    await expect(likeButton).toBeVisible({ timeout: 60_000 })
    await expect(likeButton).toHaveAttribute('aria-pressed', 'false')

    await likeButton.click()
    await expect(likeButton).toHaveAttribute('aria-pressed', 'true')
    await expect(likeButton).toBeEnabled({ timeout: 60_000 })
    await expect(likeButton).toHaveAttribute('aria-pressed', 'true')

    // Reload: pressed state must come back out of the byLiker readback, and the
    // rendered count out of the countable byPost axis.
    const persisted = await reloadUntilVisible(page, appUrl(`/post?id=${postId}`), (p) =>
      p.getByTestId(`like-btn-${postId}`).and(p.locator('[aria-pressed="true"]'))
    )
    await expect(persisted).toContainText('1')
  })

  test('the liked state survives a feed listing (batched membership)', async ({ page, bot }) => {
    test.setTimeout(180_000)

    // The profile feed resolves liked-state for the whole page in ONE
    // owner-pinned `in` query — the batch shape that lowers onto byLiker.
    await reloadUntilVisible(page, appUrl(`/user?id=${bot.identityId}`), (p) =>
      p.getByTestId(`like-btn-${postId}`).and(p.locator('[aria-pressed="true"]'))
    )
  })

  test('unliking deletes by values and re-liking works', async ({ page }) => {
    test.setTimeout(420_000)

    await page.goto(appUrl(`/post?id=${postId}`))
    const likeButton = page.getByTestId(`like-btn-${postId}`)
    await expect(likeButton).toBeVisible({ timeout: 60_000 })
    await expect(likeButton).toHaveAttribute('aria-pressed', 'true')

    // Unlike: tuple recovery (byAuthorTimePost) + delete-by-values.
    await likeButton.click()
    await expect(likeButton).toHaveAttribute('aria-pressed', 'false')
    await expect(likeButton).toBeEnabled({ timeout: 120_000 })
    await expect(likeButton).toHaveAttribute('aria-pressed', 'false')

    // Reload: absence must ALSO come back out of the chain.
    await reloadUntilVisible(page, appUrl(`/post?id=${postId}`), (p) =>
      p.getByTestId(`like-btn-${postId}`).and(p.locator('[aria-pressed="false"]'))
    )

    // Re-like: only possible if the delete really removed the index entries
    // (a leftover would reject the duplicate structurally).
    const again = page.getByTestId(`like-btn-${postId}`)
    await again.click()
    await expect(again).toHaveAttribute('aria-pressed', 'true')
    await expect(again).toBeEnabled({ timeout: 60_000 })
    await expect(again).toHaveAttribute('aria-pressed', 'true')

    await reloadUntilVisible(page, appUrl(`/post?id=${postId}`), (p) =>
      p.getByTestId(`like-btn-${postId}`).and(p.locator('[aria-pressed="true"]'))
    )
  })

  test('the profile Top tab renders the ranked top post', async ({ page, bot }) => {
    test.setTimeout(180_000)

    await page.goto(appUrl(`/user?id=${bot.identityId}`))
    const topFilter = page.getByTestId('profile-top-filter')
    await expect(topFilter).toBeVisible({ timeout: 60_000 })
    await topFilter.click()

    // The just-liked post has a proved count of 1 on byAuthorPost, so the
    // author-pinned ranked page must contain it.
    await expect(
      page.locator('[data-testid^="post-card-"]').filter({ hasText: runTag })
    ).toBeVisible({ timeout: 60_000 })
  })

  test('the explore Top tab lists the liked post', async ({ page }) => {
    test.setTimeout(180_000)

    // The liked post has a proved count on the GLOBAL byPost axis, so the
    // explore Top tab — one unpinned ranked page hydrated into post cards —
    // must list it. (Top-20 only; if the devnet ever accumulates more than 20
    // higher-ranked posts, the run tag ages out and this needs a re-think.)
    await page.goto(appUrl('/explore/'))
    const topTab = page.getByTestId('explore-top-tab')
    await expect(topTab).toBeVisible({ timeout: 60_000 })
    await topTab.click()

    await expect(
      page.locator('[data-testid^="post-card-"]').filter({ hasText: runTag })
    ).toBeVisible({ timeout: 60_000 })
  })

  test('the tag page Top toggle lists the liked post under its hashtag', async ({ page }) => {
    test.setTimeout(180_000)

    // The like repeated the post's hashtag (agreement-bound), so the tag-pinned
    // byHashtagPost axis ranks the post inside its own tag group. The tag is
    // run-unique, so the Top listing can only contain this run's post.
    await page.goto(appUrl(`/hashtag?tag=${hashtag}`))
    const topToggle = page.getByTestId('hashtag-sort-top')
    await expect(topToggle).toBeVisible({ timeout: 60_000 })
    await topToggle.click()

    await expect(
      page.locator('[data-testid^="post-card-"]').filter({ hasText: runTag })
    ).toBeVisible({ timeout: 60_000 })
  })

  test('the trending widget surfaces the tag from recent activity', async ({ page }) => {
    test.setTimeout(180_000)

    // v4 trending is client-derived (activity-based, unproven by design until
    // prefix-level ranked aggregation ships upstream): the inline hashtags of
    // the most recent posts, newest-first. The tagged post from this run is
    // among the newest posts on the chain, so its tag must surface — and the
    // surface must be labeled as activity-based rather than a proved count.
    await reloadUntilVisible(page, appUrl('/explore/'), (p) =>
      p.getByText(`#${hashtag}`, { exact: true })
    )
    await expect(page.getByTestId('trending-activity-note')).toBeVisible()
  })
})

/**
 * The v5-only surfaces: OPTIONAL hashtags and the proved prefix rankings.
 *
 * What each step proves on-chain:
 * - a tagged post carries its `hashtag` (maxLength 61 now) and lists on the
 *   tag page via `post.tagAndTime`, exactly as on v4;
 * - an UNTAGGED post omits the property entirely — consensus would reject the
 *   v4 `''` sentinel outright (`minLength: 1`), so the post existing at all is
 *   the assertion;
 * - a like of the untagged post MIRRORS the absence: the absence-aware
 *   propertyAgreement only accepts both-absent (a client still writing `''`
 *   would get 40127), and `skipIfAbsent` keeps the like out of byHashtagPost
 *   entirely; the persisted toggle after reload is the byLiker readback;
 * - unlike of the untagged post is a delete-by-values whose tuple reproduces
 *   the same absence (a tuple carrying `''` would name a different — absent —
 *   document and fail); re-like proves the entries really left the trees;
 * - the tagged like/unlike pair covers the value-carrying twin of the same
 *   agreement;
 * - trending is now a PROVED prefix ranked page (groupBy at `hashtag` on
 *   `byHashtagPost {at: hashtag}`) counting likes per tag — so the liked tag
 *   must appear WITH its count, and the v4 "Based on recent activity"
 *   disclaimer must be gone;
 * - the Creators tab renders the proved leaderboard (groupBy at `postAuthor`
 *   on `byAuthorPost {at: [postAuthor, postId]}`) and must list the bot, who
 *   just received a like;
 * - the profile Top tab still rides the same index's TERMINAL ranking, proving
 *   the at-form serves both levels at once.
 */
test.describe('v5 optional-hashtag topology and prefix rankings on the devnet contract', () => {
  test.skip(!IS_DEVNET_RUN, NOT_DEVNET_REASON)
  test.skip(SPEC_TOPOLOGY !== 'v5', 'the compiled topology predates optional hashtags and prefix rankings')
  test.skip(!hasSeedPhrase, NO_SEED_REASON)

  let runTag = ''
  let hashtag = ''
  let taggedPostId = ''
  let untaggedPostId = ''

  /** Compose a top-level post from the feed and return its document id. */
  const composePost = async (page: Page, identityId: string, text: string): Promise<string> => {
    await page.goto(appUrl('/feed/'))
    await page.getByTestId('open-compose-btn').click()
    const composeDialog = page.getByRole('dialog', { name: 'Create a new post' })
    await expect(composeDialog).toBeVisible()
    await composeDialog.getByTestId('compose-textarea').first().fill(text)
    await composeDialog.getByTestId('compose-submit-btn').click()
    await expect(composeDialog).toBeHidden({ timeout: COMPOSE_TIMEOUT })

    const card = await reloadUntilVisible(page, appUrl(`/user?id=${identityId}`), (p) =>
      p.locator('[data-testid^="post-card-"]').filter({ hasText: text })
    )
    const id = ((await card.getAttribute('data-testid')) ?? '').replace('post-card-', '')
    expect(id, 'the post card should expose the document id').not.toBe('')
    return id
  }

  /** Toggle a like and wait for the pressed state to persist across a reload. */
  const likeAndVerify = async (page: Page, postId: string) => {
    await page.goto(appUrl(`/post?id=${postId}`))
    const likeButton = page.getByTestId(`like-btn-${postId}`)
    await expect(likeButton).toBeVisible({ timeout: 60_000 })
    await expect(likeButton).toHaveAttribute('aria-pressed', 'false')

    await likeButton.click()
    await expect(likeButton).toHaveAttribute('aria-pressed', 'true')
    await expect(likeButton).toBeEnabled({ timeout: 60_000 })
    await expect(likeButton).toHaveAttribute('aria-pressed', 'true')

    await reloadUntilVisible(page, appUrl(`/post?id=${postId}`), (p) =>
      p.getByTestId(`like-btn-${postId}`).and(p.locator('[aria-pressed="true"]'))
    )
  }

  /** Unlike (delete-by-values), verify the absence persists, then re-like. */
  const unlikeAndRelike = async (page: Page, postId: string) => {
    await page.goto(appUrl(`/post?id=${postId}`))
    const likeButton = page.getByTestId(`like-btn-${postId}`)
    await expect(likeButton).toBeVisible({ timeout: 60_000 })
    await expect(likeButton).toHaveAttribute('aria-pressed', 'true')

    await likeButton.click()
    await expect(likeButton).toHaveAttribute('aria-pressed', 'false')
    await expect(likeButton).toBeEnabled({ timeout: 120_000 })
    await expect(likeButton).toHaveAttribute('aria-pressed', 'false')

    await reloadUntilVisible(page, appUrl(`/post?id=${postId}`), (p) =>
      p.getByTestId(`like-btn-${postId}`).and(p.locator('[aria-pressed="false"]'))
    )

    // Re-like: only possible if the delete really removed the index entries
    // (a leftover would reject the duplicate structurally).
    const again = page.getByTestId(`like-btn-${postId}`)
    await again.click()
    await expect(again).toHaveAttribute('aria-pressed', 'true')
    await expect(again).toBeEnabled({ timeout: 60_000 })
    await expect(again).toHaveAttribute('aria-pressed', 'true')

    await reloadUntilVisible(page, appUrl(`/post?id=${postId}`), (p) =>
      p.getByTestId(`like-btn-${postId}`).and(p.locator('[aria-pressed="true"]'))
    )
  }

  test('a tagged post is created and listed on its tag page', async ({ page, bot }) => {
    test.setTimeout(420_000)

    runTag = uniqueTag(bot.index)
    // Run-unique tag, capped at the v5 ranked-key ceiling of 61 (was 63).
    hashtag = `v5${runTag.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`.slice(0, 61)

    taggedPostId = await composePost(page, bot.identityId, `${runTag} v5 tagged target #${hashtag}`)

    // Inline hashtag: the tag page lists the post straight off post.tagAndTime.
    await reloadUntilVisible(page, appUrl(`/hashtag?tag=${hashtag}`), (p) =>
      p.locator('[data-testid^="post-card-"]').filter({ hasText: runTag })
    )
  })

  test('an untagged post is created with the hashtag property absent', async ({ page, bot }) => {
    test.setTimeout(420_000)

    // No '#' anywhere: the client must OMIT `hashtag` (v4 wrote ''), and v5
    // consensus would reject '' against `minLength: 1` — so the post landing
    // and rendering at all proves the omission happened.
    untaggedPostId = await composePost(page, bot.identityId, `${runTag} v5 untagged target`)
  })

  test('liking and unliking the TAGGED post round-trips the agreement value', async ({ page }) => {
    test.setTimeout(420_000)

    await likeAndVerify(page, taggedPostId)
  })

  test('liking the UNTAGGED post mirrors the absence and persists', async ({ page }) => {
    test.setTimeout(300_000)

    // The create must omit like.hashtag — both-absent is the only agreeing
    // combination — and skipIfAbsent keeps it out of byHashtagPost entirely.
    await likeAndVerify(page, untaggedPostId)
  })

  test('unliking the UNTAGGED post reproduces the absence in the delete tuple', async ({ page }) => {
    test.setTimeout(420_000)

    // Delete-by-values rebuilds the tuple through the same boundary translation
    // the create used; a tuple carrying '' would address a like that does not
    // exist. The re-like inside proves the entries really left the trees.
    await unlikeAndRelike(page, untaggedPostId)
  })

  test('unliking the TAGGED post still round-trips with the value present', async ({ page }) => {
    test.setTimeout(420_000)

    await unlikeAndRelike(page, taggedPostId)
  })

  test('trending lists the tag with a PROVED like count and no activity disclaimer', async ({ page }) => {
    test.setTimeout(180_000)

    // v5 trending is a proved prefix ranked page on byHashtagPost {at: hashtag}
    // counting likes per tag. The tagged post holds a like, so its run-unique
    // tag must rank — and the v4 "Based on recent activity" label must be gone,
    // because this ranking is proved, not derived.
    await reloadUntilVisible(page, appUrl('/explore/'), (p) =>
      p.getByText(`#${hashtag}`, { exact: true })
    )
    await expect(page.getByTestId('trending-activity-note')).toHaveCount(0)
    // The proved metric is likes-per-tag: exactly one like on this run's tag.
    const trendRow = page
      .locator('div')
      .filter({ has: page.getByText(`#${hashtag}`, { exact: true }) })
      .filter({ hasText: /1 like/ })
    await expect(trendRow.first()).toBeVisible()
  })

  test('the Creators tab lists the liked author on the proved leaderboard', async ({ page, bot }) => {
    test.setTimeout(180_000)

    // The bot just received likes on its posts, so the prefix ranked page on
    // byAuthorPost {at: [postAuthor, postId]} must include its identity.
    await page.goto(appUrl('/explore/'))
    const creatorsTab = page.getByTestId('explore-creators-tab')
    await expect(creatorsTab).toBeVisible({ timeout: 60_000 })
    await creatorsTab.click()

    await expect(page.getByTestId(`explore-top-creators-${bot.identityId}`)).toBeVisible({
      timeout: 60_000,
    })
  })

  test('the profile Top tab still serves the terminal ranking of the same index', async ({ page, bot }) => {
    test.setTimeout(180_000)

    // The at-form covers [postAuthor, postId]: the leaderboard groups at the
    // prefix, the profile Top tab at the terminal. Both must answer.
    await page.goto(appUrl(`/user?id=${bot.identityId}`))
    const topFilter = page.getByTestId('profile-top-filter')
    await expect(topFilter).toBeVisible({ timeout: 60_000 })
    await topFilter.click()

    await expect(
      page.locator('[data-testid^="post-card-"]').filter({ hasText: runTag })
    ).toBeVisible({ timeout: 60_000 })
  })
})
