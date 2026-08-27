/**
 * The real write path: a bot identity from the e2e pool signs actual state
 * transitions against the dedicated test contracts on Dash testnet
 * (`NEXT_PUBLIC_YAPPR_CONTRACT_ID` / `NEXT_PUBLIC_YAPPR_PROFILE_CONTRACT_ID` in
 * `.env.testing`). Nothing is mocked and nothing touches the production
 * contracts.
 *
 * Ordering matters — later steps operate on the post the earlier ones created —
 * so the whole file runs serially and aborts the rest on the first failure.
 *
 * Assertion strategy: assert optimistically right after each action (the app
 * updates the UI as soon as the transition is broadcast, because DAPI's
 * confirmation wait times out routinely), and use reloading polls for anything
 * that has to come back out of a chain query.
 */
import { appUrl } from '../fixtures/app'
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'
import { expectedSocialContractId, expectedTopology } from '../fixtures/contracts'
import { reloadUntilVisible } from '../fixtures/eventual'
import { uniqueTag } from '../fixtures/run-tag'

test.describe.configure({ mode: 'serial' })

test.describe('post lifecycle on the real testnet', () => {
  test.skip(!hasSeedPhrase, NO_SEED_REASON)

  let runTag = ''
  let postContent = ''
  let replyContent = ''
  let postId = ''

  test('the build under test targets the test contracts', async ({ page }) => {
    const [expected, topology] = await Promise.all([expectedSocialContractId(), expectedTopology()])
    expect(expected, 'the env file must define NEXT_PUBLIC_YAPPR_CONTRACT_ID').not.toBe('')

    // /about prints the contract id and the interaction topology the bundle was
    // compiled with. A plain `npm run build` would print the production contract
    // here, and every write below would land on it — so this gates the whole
    // serial group. The topology assertion catches the other half of the same
    // mistake: a client compiled for the wrong contract SHAPE queries doctypes
    // and fields that do not exist on the contract it is pointed at.
    await page.goto(appUrl('/about/'))
    await expect(page.getByText(expected, { exact: true })).toBeVisible()
    await expect(page.getByTestId('about-topology')).toHaveText(topology)
  })

  test('the seeded session is restored', async ({ page }) => {
    await page.goto(appUrl('/feed/'))

    await expect(page.getByTestId('user-menu-trigger')).toBeVisible()
    await expect(page.getByTestId('open-compose-btn')).toBeVisible()
    // Every write action calls requireAuth(), which opens this modal when the
    // session did not survive — its absence is the real proof of login.
    await expect(page.locator('#loginIdentityInput')).toHaveCount(0)
  })

  test('the bot identity has a profile', async ({ page, bot }) => {
    // Budget: the two polls below (90s + 90s) plus navigation, with headroom —
    // a test-level timeout firing mid-poll would report a misleading failure and
    // cost a full serial-group retry.
    test.setTimeout(240_000)

    // The page self-redirects to /user?id=... when a profile already exists, so
    // this is idempotent: create on the first ever run, pass on every later one.
    await page.goto(appUrl('/profile/create/'))

    const submit = page.getByRole('button', { name: 'Create Profile' })
    await expect
      .poll(
        async () => {
          if (!page.url().includes('/profile/create')) return 'redirected'
          if ((await submit.count()) > 0) return 'form'
          return 'checking'
        },
        { timeout: 90_000, intervals: [1_000] }
      )
      .not.toBe('checking')

    if (page.url().includes('/profile/create')) {
      await page.locator('#displayName').fill(`yappr-e2e-${bot.index}`)
      await page.locator('#bio').fill('Automated end-to-end test identity for the /testing deployment.')
      await submit.click()

      await expect
        .poll(() => page.url(), { timeout: 90_000, intervals: [2_000] })
        .not.toContain('/profile/create')
    }

    // Landing anywhere else (notably /login, if the session was dropped) would
    // make this test pass without a profile ever existing.
    expect(page.url()).toMatch(/\/(feed|user)\b/)
  })

  test('a post carrying the run tag is composed', async ({ page, bot }) => {
    // Budget: the 120s broadcast wait below plus navigation and the feed assertion.
    test.setTimeout(180_000)

    runTag = uniqueTag(bot.index)
    postContent = `${runTag} automated end-to-end post`

    await page.goto(appUrl('/feed/'))
    await page.getByTestId('open-compose-btn').click()

    const dialog = page.getByRole('dialog', { name: 'Create a new post' })
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('compose-textarea').first().fill(postContent)
    await dialog.getByTestId('compose-submit-btn').click()

    // The modal only closes once the transition was broadcast successfully; on
    // failure or timeout it stays open with a retry affordance.
    await expect(dialog).toBeHidden({ timeout: 120_000 })

    // The app prepends the new post to the feed via a `post-created` event.
    await expect(page.getByTestId('feed-post-list').getByText(runTag)).toBeVisible()
  })

  test('the post is readable back from the chain', async ({ page, bot }) => {
    // Budget: up to 5 reload attempts of 15s each, plus the navigations between them.
    test.setTimeout(180_000)

    const card = await reloadUntilVisible(
      page,
      appUrl(`/user?id=${bot.identityId}`),
      (p) => p.locator('[data-testid^="post-card-"]').filter({ hasText: runTag })
    )

    const testId = await card.getAttribute('data-testid')
    postId = (testId ?? '').replace('post-card-', '')
    expect(postId, 'the post card should expose the document id').not.toBe('')
  })

  test('the post can be liked and unliked', async ({ page }) => {
    // Budget: 60s to load the post plus two 60s write settles, with headroom.
    test.setTimeout(240_000)

    await page.goto(appUrl(`/post?id=${postId}`))

    const likeButton = page.getByTestId(`like-btn-${postId}`)
    await expect(likeButton).toBeVisible({ timeout: 60_000 })
    await expect(likeButton).toHaveAttribute('aria-pressed', 'false')

    await likeButton.click()
    // Optimistic toggle, then the button re-enables when the write settles.
    await expect(likeButton).toHaveAttribute('aria-pressed', 'true')
    await expect(likeButton).toBeEnabled({ timeout: 60_000 })
    await expect(likeButton).toHaveAttribute('aria-pressed', 'true')

    await likeButton.click()
    await expect(likeButton).toHaveAttribute('aria-pressed', 'false')
    await expect(likeButton).toBeEnabled({ timeout: 60_000 })
    await expect(likeButton).toHaveAttribute('aria-pressed', 'false')
  })

  test('a reply to the post renders', async ({ page }) => {
    // Budget: 60s to load the post, a 120s broadcast wait, then up to 5x15s of
    // reloading read-back polls.
    test.setTimeout(360_000)

    replyContent = `${runTag} automated end-to-end reply`

    await page.goto(appUrl(`/post?id=${postId}`))
    await expect(page.getByTestId(`post-card-${postId}`)).toBeVisible({ timeout: 60_000 })

    await page.getByRole('button', { name: 'Post your reply' }).click()

    const dialog = page.getByRole('dialog', { name: 'Reply to post' })
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('compose-textarea').first().fill(replyContent)
    await dialog.getByTestId('compose-submit-btn').click()
    await expect(dialog).toBeHidden({ timeout: 120_000 })

    await reloadUntilVisible(page, appUrl(`/post?id=${postId}`), (p) =>
      p.locator('[data-testid^="post-card-"]').filter({ hasText: replyContent })
    )
  })
})
