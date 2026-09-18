/**
 * The devnet (`v7`) interaction topology, exercised against a real chain.
 *
 * Everything here is a claim the contract's shape makes that the client has to
 * honour, and that a unit test could not check because it depends on consensus:
 * a reply names its thread ROOT so a reply-to-a-reply must appear in the root's
 * thread; reply likes live in their own `likeReply` doctype; `repost.postId` and
 * `bookmark.postId` are `refersTo`-checked against `post`, so those controls must
 * not exist on a reply card at all; a quote of a reply goes in `quotedReplyId`;
 * and `post`/`reply` are `canBeDeleted: false`, so "delete" leaves a tombstone.
 *
 * This runs against the moutai devnet (`.env.devnet` — the only deployment on
 * the v7 contract) and self-skips anywhere else, since on v2 every assertion
 * below is either meaningless or actively wrong. Drive it with:
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
import { expect, hasSeedPhrase, NO_SEED_REASON, seedContext, test } from '../fixtures/auth'
import { expectedSocialContractId, expectedTopology } from '../fixtures/contracts'
import { reloadUntilVisible } from '../fixtures/eventual'
import { uniqueTag } from '../fixtures/run-tag'

test.describe.configure({ mode: 'serial' })

/** Broadcast waits are long and chained; each write test budgets its own. */
const COMPOSE_TIMEOUT = 120_000

/** The static Explore tabs are visible before React attaches their handlers. */
async function openReadyExplore(page: Page): Promise<void> {
  await page.goto(appUrl('/explore/'), { waitUntil: 'domcontentloaded' })
  await expect(page.getByTestId('explore-creators-tab')).toBeVisible({ timeout: 30_000 })
  // The initial trending request starts in a client effect. Its loading state
  // disappearing proves hydration has run, including when the result is empty.
  await expect(page.getByText('Loading trending hashtags...', { exact: true }))
    .toBeHidden({ timeout: 60_000 })
}

/**
 * The devnet run is the only one this file applies to, and it is identified the
 * same way the build is: by which env file was selected. Read synchronously so it
 * can gate the whole describe — a per-test `test.skip` would leave the rest of a
 * serial group running against the wrong contract.
 */
const IS_DEVNET_RUN = (process.env.E2E_ENV_FILE ?? '').includes('devnet')
const NOT_DEVNET_REASON =
  'E2E_ENV_FILE does not select the devnet deployment — the v7 topology is only deployed there'

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

/**
 * The one non-default topology in `CONTRACT_TOPOLOGIES` (lib/constants.ts),
 * hand-copied because e2e/ cannot import from lib/ — it reads the COMPILED
 * bundle, and Playwright runs outside the app's module graph.
 * `lib/contract-topology.test.ts` fails if this literal drifts, which matters
 * because drift would silently skip every devnet suite below rather than error.
 */
const DEVNET_TOPOLOGY = 'v7'
const WRONG_TOPOLOGY_REASON = `the compiled topology is not ${DEVNET_TOPOLOGY}`

test.describe('interaction topology on the devnet contract', () => {
  test.skip(!IS_DEVNET_RUN, NOT_DEVNET_REASON)
  test.skip(SPEC_TOPOLOGY !== DEVNET_TOPOLOGY, WRONG_TOPOLOGY_REASON)
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
    // different topology here means the devnet env file lost its flag — which
    // would make every assertion below fail against the UI instead of naming
    // the real problem.
    expect(topology, `the devnet env file must set NEXT_PUBLIC_CONTRACT_TOPOLOGY=${DEVNET_TOPOLOGY}`)
      .toBe(DEVNET_TOPOLOGY)
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
    await expect(page.getByTestId(`more-btn-${firstReplyId}`)).toHaveAccessibleName('Reply options')

    // The repost/quote dropdown still exists on a reply (quoting IS allowed), so
    // this checks the menu's contents rather than the trigger.
    await expect(page.getByTestId(`repost-menu-btn-${firstReplyId}`)).toHaveAccessibleName('Quote')
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
 * Optional hashtags and the proved prefix rankings.
 *
 * What each step proves on-chain:
 * - a tagged post carries its `hashtag` (maxLength 61) and lists on the tag
 *   page via `post.tagAndTime`;
 * - an UNTAGGED post omits the property entirely — consensus rejects a `''`
 *   sentinel outright (`minLength: 1`), so the post existing at all is the
 *   assertion;
 * - a like of the untagged post MIRRORS the absence: the absence-aware
 *   propertyAgreement only accepts both-absent (a client still writing `''`
 *   would get 40127), and `skipIfAbsent` keeps the like out of byHashtagPost
 *   entirely; the persisted toggle after reload is the byLiker readback;
 * - unlike of the untagged post is a delete-by-values whose tuple reproduces
 *   the same absence (a tuple carrying `''` would name a different — absent —
 *   document and fail); re-like proves the entries really left the trees;
 * - the tagged like/unlike pair covers the value-carrying twin of the same
 *   agreement;
 * - trending is a PROVED prefix ranked page (groupBy at `hashtag` on
 *   `byHashtagPost {at: hashtag}`) counting likes per tag — so the surface must
 *   show like counts, with no "Based on recent activity" disclaimer;
 * - the Creators tab renders the proved leaderboard (groupBy at `postAuthor`
 *   on `byAuthorPost {at: [postAuthor, postId]}`) and must list the bot, who
 *   just received a like;
 * - the profile Top tab still rides the same index's TERMINAL ranking, proving
 *   the at-form serves both levels at once.
 */
test.describe('optional hashtags and prefix rankings on the devnet contract', () => {
  test.skip(!IS_DEVNET_RUN, NOT_DEVNET_REASON)
  test.skip(SPEC_TOPOLOGY !== DEVNET_TOPOLOGY, WRONG_TOPOLOGY_REASON)
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

    const persisted = await reloadUntilVisible(page, appUrl(`/post?id=${postId}`), (p) =>
      p.getByTestId(`like-btn-${postId}`).and(p.locator('[aria-pressed="true"]'))
    )
    // The pressed state comes out of the byLiker readback; the RENDERED COUNT
    // comes out of the countable byPost axis. The posts are run-unique, so the
    // only like on them is this one.
    await expect(persisted).toContainText('1')
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
    // Run-unique tag, capped at the ranked-key ceiling of 61.
    hashtag = `tag${runTag.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`.slice(0, 61)

    taggedPostId = await composePost(page, bot.identityId, `${runTag} tagged target #${hashtag}`)

    // Inline hashtag: the tag page lists the post straight off post.tagAndTime.
    await reloadUntilVisible(page, appUrl(`/hashtag?tag=${hashtag}`), (p) =>
      p.locator('[data-testid^="post-card-"]').filter({ hasText: runTag })
    )
  })

  test('an untagged post is created with the hashtag property absent', async ({ page, bot }) => {
    test.setTimeout(420_000)

    // No '#' anywhere: the client must OMIT `hashtag`, and consensus would
    // reject '' against `minLength: 1` — so the post landing and rendering at
    // all proves the omission happened.
    untaggedPostId = await composePost(page, bot.identityId, `${runTag} untagged target`)
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

  test('the liked state survives a feed listing (batched membership)', async ({ page, bot }) => {
    test.setTimeout(180_000)

    // A single-post page resolves liked-state one target at a time. The profile
    // feed resolves the WHOLE page in one owner-pinned `in` query — the batch
    // shape that lowers onto byLiker — so it is the only surface that proves
    // the batched form answers at all.
    await reloadUntilVisible(page, appUrl(`/user?id=${bot.identityId}`), (p) =>
      p.getByTestId(`like-btn-${taggedPostId}`).and(p.locator('[aria-pressed="true"]'))
    )
  })

  test('trending is the PROVED ranking (like counts, no disclaimer) and the tag ranks on its pinned surface', async ({ page }) => {
    test.setTimeout(180_000)

    // Trending is a proved prefix ranked page on byHashtagPost {at: hashtag}
    // counting likes per tag — ALL-TIME, top-K. On a populated network a
    // run-unique tag holding one like can never crack the widget (seeded tags
    // carry dozens of likes), so the widget assertions are structural: it must
    // be the proved variant — tags with like-count rows and no "Based on
    // recent activity" disclaimer.
    await reloadUntilVisible(page, appUrl('/explore/'), (p) =>
      p.getByText(/\d+ likes?$/).first()
    )
    // Tripwire rather than a live assertion: the testid no longer exists in the
    // app, so this can only fail if an unproven trending fallback is reintroduced
    // without relabeling the proved surface.
    await expect(page.getByTestId('trending-activity-note')).toHaveCount(0)

    // The run tag's own proved ranking is asserted where the pin guarantees
    // inclusion regardless of other tags: the tag page's Top toggle (terminal
    // level of the same multi-at index, tag pinned) must rank the liked post.
    await reloadUntilVisible(page, appUrl(`/hashtag?tag=${hashtag}`), (p) =>
      p.getByTestId('hashtag-sort-top')
    )
    await page.getByTestId('hashtag-sort-top').click()
    await expect(page.getByTestId(`like-btn-${taggedPostId}`)).toBeVisible({ timeout: 30_000 })
  })

  test('the Creators tab renders the proved leaderboard', async ({ page }) => {
    test.setTimeout(180_000)

    // The leaderboard (byAuthorPost {at: [postAuthor, postId]}, grouped at
    // postAuthor) is an ALL-TIME top-10: on a populated network the run's bot
    // (a handful of likes received) cannot assert its own inclusion against
    // seeded creators carrying dozens. Assert the surface structurally: the
    // tab exists, and clicking it renders the ranked list — the
    // `explore-top-creators` container only mounts with at least one row (the
    // empty state carries a different testid), so visibility IS the non-empty
    // assertion. The tab is client-side state with no URL form, so the
    // reload-until-visible loop is inlined: a ranked query that hangs on one
    // page load leaves the spinner up forever, and only a fresh page (fresh
    // SDK connection) recovers.
    const attempts = 4
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await openReadyExplore(page)
      const creatorsTab = page.getByTestId('explore-creators-tab')
      await expect(creatorsTab).toBeVisible({ timeout: 30_000 })
      await creatorsTab.click()

      const rankedList = page.getByTestId('explore-top-creators')
      if (attempt === attempts) {
        await expect(rankedList).toBeVisible({ timeout: 30_000 })
        break
      }
      try {
        await rankedList.waitFor({ state: 'visible', timeout: 30_000 })
        break
      } catch {
        // Hung or transiently failed ranked query — reload and retry.
      }
    }
  })

  test('the profile Top tab still serves the terminal ranking of the same index', async ({ page, bot }) => {
    test.setTimeout(180_000)

    // The at-form covers [postAuthor, postId]: the leaderboard groups at the
    // prefix, the profile Top tab at the terminal. Both must answer.
    await page.goto(appUrl(`/user?id=${bot.identityId}`))
    const topFilter = page.getByTestId('profile-top-filter')
    await expect(topFilter).toBeVisible({ timeout: 60_000 })
    await topFilter.click()

    // .first(): a quote of the tagged post renders its text inside the embed,
    // so more than one card on the surface can contain the run tag.
    await expect(
      page.locator('[data-testid^="post-card-"]').filter({ hasText: runTag }).first()
    ).toBeVisible({ timeout: 60_000 })
  })
})

// DAILY-WINDOWED rankings. A like of a TAGGED post writes a `beat` companion
// as a second transition once the like lands, and every ranked surface gains a
// Today | All time switch. The assertions pin the run's own writes on the
// TODAY window. Tag/author pins guarantee inclusion for the run's own writes;
// global top-K assertions allow seeded posts and tags to outrank the CI bot.
test.describe('daily-windowed rankings on the devnet contract', () => {
  test.skip(!IS_DEVNET_RUN, NOT_DEVNET_REASON)
  test.skip(SPEC_TOPOLOGY !== DEVNET_TOPOLOGY, WRONG_TOPOLOGY_REASON)
  test.skip(!hasSeedPhrase, NO_SEED_REASON)

  let runTag = ''
  let hashtag = ''
  let taggedPostId = ''

  test.beforeAll(async ({ browser, bot }) => {
    test.setTimeout(420_000)
    runTag = uniqueTag(bot.index)
    hashtag = `win${runTag.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`.slice(0, 61)

    const context = await browser.newContext()
    try {
      await seedContext(context, bot)
      const page = await context.newPage()
      await page.goto(appUrl('/feed/'))
      await page.getByTestId('open-compose-btn').click()
      const composeDialog = page.getByRole('dialog', { name: 'Create a new post' })
      await expect(composeDialog).toBeVisible()
      await composeDialog.getByTestId('compose-textarea').first().fill(`${runTag} windowed ranking target #${hashtag}`)
      await composeDialog.getByTestId('compose-submit-btn').click()
      await expect(composeDialog).toBeHidden({ timeout: COMPOSE_TIMEOUT })
      const card = await reloadUntilVisible(page, appUrl(`/user?id=${bot.identityId}`), (p) =>
        p.locator('[data-testid^="post-card-"]').filter({ hasText: runTag })
      )
      taggedPostId = ((await card.getAttribute('data-testid')) ?? '').replace('post-card-', '')
      expect(taggedPostId).not.toBe('')

      // Like it: the client writes the like, then a beat in a second transition.
      await page.goto(appUrl(`/post?id=${taggedPostId}`))
      const likeButton = page.getByTestId(`like-btn-${taggedPostId}`)
      await expect(likeButton).toBeVisible({ timeout: 60_000 })
      await expect(likeButton).toHaveAttribute('aria-pressed', 'false')
      await likeButton.click()
      await expect(likeButton).toBeEnabled({ timeout: 60_000 })
      await reloadUntilVisible(page, appUrl(`/post?id=${taggedPostId}`), (p) =>
        p.getByTestId(`like-btn-${taggedPostId}`).and(p.locator('[aria-pressed="true"]'))
      )
    } finally {
      await context.close()
    }
  })

  test("the tag page's Top → Today lists the liked post (beat.byDayHashtagPost, tag + bucket pinned)", async ({ page }) => {
    test.setTimeout(180_000)
    await reloadUntilVisible(page, appUrl(`/hashtag?tag=${hashtag}`), (p) => p.getByTestId('hashtag-sort-top'))
    await page.getByTestId('hashtag-sort-top').click()
    const today = page.getByTestId('hashtag-top-today')
    await expect(today, 'the windowed-ranking toggle must render on the tag page').toBeVisible({ timeout: 30_000 })
    await today.click()
    await expect(page.getByTestId(`like-btn-${taggedPostId}`)).toBeVisible({ timeout: 60_000 })
  })

  test("the profile Top → Today lists the liked post (like.byDayAuthorPost, author + bucket pinned)", async ({ page, bot }) => {
    test.setTimeout(180_000)
    await page.goto(appUrl(`/user?id=${bot.identityId}`), { waitUntil: 'domcontentloaded' })
    const topFilter = page.getByTestId('profile-top-filter')
    await expect(topFilter).toBeVisible({ timeout: 60_000 })
    await topFilter.click()
    const today = page.getByTestId('profile-top-today')
    await expect(today).toBeVisible({ timeout: 30_000 })
    await today.click()
    await expect(
      page.locator('[data-testid^="post-card-"]').filter({ hasText: runTag }).first()
    ).toBeVisible({ timeout: 60_000 })
  })

  test("Explore's trending → Today renders the proved ranking (beat.byDayHashtagPost at hashtag)", async ({ page }) => {
    test.setTimeout(180_000)
    await openReadyExplore(page)
    const today = page.getByTestId('explore-trending-today')
    await expect(today).toBeVisible({ timeout: 60_000 })
    await today.click()
    await expect(today).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('Loading trending hashtags...', { exact: true })).toBeHidden({ timeout: 60_000 })
    // Seeded tags can outrank this run's one-like tag in the global top-12.
    // The pinned tag test above proves the run's exact beat membership.
    await expect(page.getByText(/\d+ likes?$/).first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('trending-activity-note')).toHaveCount(0)
  })

  test("Explore's Top → Today renders today's ranking (like.byDayPost)", async ({ page }) => {
    test.setTimeout(180_000)
    await openReadyExplore(page)
    const topTab = page.getByTestId('explore-top-tab')
    await expect(topTab).toBeVisible({ timeout: 60_000 })
    await topTab.click()
    const today = page.getByTestId('explore-top-today')
    await expect(today).toBeVisible({ timeout: 30_000 })
    await today.click()
    await expect(today).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('Loading top posts...', { exact: true })).toBeHidden({ timeout: 60_000 })
    // The seeded corpus also lands today; global top-20 need not include the
    // CI bot. Exact membership is checked on the pinned tag/profile surfaces.
    await expect(page.locator('[data-testid^="post-card-"]').first()).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('explore-top-empty')).toHaveCount(0)
  })
})
