/**
 * Sensitive-content flow against the real testnet: compose with the toggle,
 * verify the opaque gate on the optimistic card and on chain read-back, and
 * exercise the three viewer modes.
 *
 * Mode-switching notes:
 * - Each test gets a fresh browser context, so a settings change never leaks
 *   between tests — every mode test drives the settings UI itself.
 * - The bot both authors and views the post. The gate is uniform (own posts
 *   gate too), which is what makes a single-identity spec possible; the one
 *   thing that CANNOT be asserted here is 'hide' filtering of someone else's
 *   post, because 'hide' deliberately never hides the viewer's own posts.
 */
import type { Page } from '@playwright/test'
import { appUrl } from '../fixtures/app'
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'
import { expectedSocialContractId, expectedTopology } from '../fixtures/contracts'
import { reloadUntilVisible } from '../fixtures/eventual'
import { uniqueTag } from '../fixtures/run-tag'

test.describe.configure({ mode: 'serial' })

/** Selects a sensitive-content mode through the Privacy settings UI. */
async function chooseSensitiveMode(page: Page, mode: 'blur' | 'show' | 'hide') {
  await page.goto(appUrl('/settings?section=privacy'))
  const option = page.locator(`label[for="sensitive-mode-${mode}"]`)
  await expect(option).toBeVisible({ timeout: 30_000 })
  await option.click()
  await expect(page.getByTestId(`sensitive-mode-${mode}`)).toHaveAttribute('data-state', 'checked')
}

test.describe('sensitive content on the real testnet', () => {
  test.skip(!hasSeedPhrase, NO_SEED_REASON)

  let runTag = ''
  let postContent = ''
  let postId = ''

  test('the build under test targets the test contracts', async ({ page }) => {
    const [expected, topology] = await Promise.all([expectedSocialContractId(), expectedTopology()])
    expect(expected, 'the env file must define NEXT_PUBLIC_YAPPR_CONTRACT_ID').not.toBe('')

    await page.goto(appUrl('/about/'))
    await expect(page.getByText(expected, { exact: true })).toBeVisible()
    await expect(page.getByTestId('about-topology')).toHaveText(topology)
  })

  test('a post composed with the sensitive toggle is gated, and Show reveals it', async ({ page, bot }) => {
    // Budget: the 120s broadcast wait plus navigation and feed assertions.
    test.setTimeout(180_000)

    runTag = uniqueTag(bot.index)
    postContent = `${runTag} automated sensitive post`

    await page.goto(appUrl('/feed/'))
    await page.getByTestId('open-compose-btn').click()

    const dialog = page.getByRole('dialog', { name: 'Create a new post' })
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('compose-textarea').first().fill(postContent)
    await dialog.getByTestId('sensitive-toggle').click()
    await dialog.getByTestId('compose-submit-btn').click()
    await expect(dialog).toBeHidden({ timeout: 120_000 })

    // The optimistic prepend must carry the flag: the newest card is covered by
    // the gate and its text is NOT in the DOM (the gate never mounts children).
    const feed = page.getByTestId('feed-post-list')
    const card = feed
      .locator('[data-testid^="post-card-"]', { has: page.locator('[data-testid="sensitive-gate"]') })
      .first()
    await expect(card).toBeVisible()
    await expect(feed.getByText(runTag)).toHaveCount(0)

    const testId = await card.getAttribute('data-testid')
    postId = (testId ?? '').replace('post-card-', '')
    expect(postId, 'the gated card should expose the document id').not.toBe('')

    // Per-post reveal. Re-address the card by its id: `card` selects on
    // *having* a sensitive-gate, and the reveal unmounts the gate — so the
    // filtered locator can no longer resolve the very card it just revealed.
    await card.getByTestId('sensitive-show-btn').click()
    await expect(feed.getByTestId(`post-card-${postId}`).getByText(runTag)).toBeVisible()
  })

  test('the flag survives the chain read-back', async ({ page, bot }) => {
    // Budget: up to 5 reload attempts of 15s each, plus navigation.
    test.setTimeout(180_000)

    const card = await reloadUntilVisible(page, appUrl(`/user?id=${bot.identityId}`), (p) =>
      p.getByTestId(`post-card-${postId}`)
    )

    // Fresh page load, so the session reveal set is empty again: gated, no text.
    await expect(card.getByTestId('sensitive-gate')).toBeVisible()
    await expect(card.getByText(runTag)).toHaveCount(0)

    await card.getByTestId('sensitive-show-btn').click()
    await expect(card.getByText(runTag)).toBeVisible()
  })

  test('the always-show preference disables the gate', async ({ page }) => {
    // Budget: settings navigation plus a 60s post-detail load.
    test.setTimeout(120_000)

    await chooseSensitiveMode(page, 'show')

    await page.goto(appUrl(`/post?id=${postId}`))
    const card = page.getByTestId(`post-card-${postId}`)
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card.getByText(runTag)).toBeVisible()
    await expect(card.getByTestId('sensitive-gate')).toHaveCount(0)
  })

  test('hide mode still gates the post detail instead of hiding it', async ({ page, bot }) => {
    // Budget: settings navigation plus a 60s post-detail load and a profile load.
    test.setTimeout(180_000)

    await chooseSensitiveMode(page, 'hide')

    // Detail is deliberate navigation: never a hole, always the gate.
    await page.goto(appUrl(`/post?id=${postId}`))
    const card = page.getByTestId(`post-card-${postId}`)
    await expect(card).toBeVisible({ timeout: 60_000 })
    await expect(card.getByTestId('sensitive-gate')).toBeVisible()
    await expect(card.getByText(runTag)).toHaveCount(0)

    // The viewer's own posts are exempt from hide-filtering on their profile.
    await page.goto(appUrl(`/user?id=${bot.identityId}`))
    await expect(page.getByTestId(`post-card-${postId}`)).toBeVisible({ timeout: 60_000 })
  })
})
