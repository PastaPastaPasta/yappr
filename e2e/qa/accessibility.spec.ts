import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { expectFocusContrast } from '../fixtures/focus-contrast'

for (const width of [390, 1440]) {
  test(`Create Blog fields, close control, focus and AA checks at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/?scenario=create')
    const trigger = page.getByRole('button', { name: 'New blog' })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Create Blog' })
    await expect(dialog.getByRole('textbox', { name: 'Blog name', exact: true })).toBeVisible()
    await expect(dialog.getByRole('textbox', { name: 'Description', exact: true })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
    await expect(dialog).not.toContainText('bytes')
    expect((await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
  })
}

test('published rich text has document semantics without editor ARIA or a textbox tab stop', async ({ page }) => {
  await page.goto('/?scenario=reader')
  const prose = page.getByRole('document', { name: 'Blog post' })
  await expect(prose).toContainText('Published prose remains a document.')
  await prose.click()
  await page.getByRole('button', { name: 'Toggle reader theme' }).click()
  await expect(page.locator('html')).toHaveClass('dark')
  await expect(page.getByRole('textbox')).toHaveCount(0)
  for (const name of ['aria-autocomplete', 'aria-haspopup', 'aria-expanded', 'tabindex']) await expect(prose).not.toHaveAttribute(name)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
})

test('mobile switch retains its full width and contains its enabled thumb', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const track = page.getByRole('switch', { name: 'Show query inspector' })
  const bounds = await track.boundingBox()
  const thumb = await track.locator('span').boundingBox()
  expect(bounds?.width).toBe(44)
  expect(thumb!.x + thumb!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width)
})

test('confirmed passkey removal immediately updates Settings and survives a stale reread', async ({ page }) => {
  await page.goto('/?scenario=passkeys')
  await expect(page.getByTestId('passkey-row')).toBeVisible()
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await page.getByTestId('passkey-remove-confirm').click()
  await expect(page.getByTestId('passkey-row')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Update passkeys' })).toHaveCount(0)
  await expect(page.getByText("You haven't added a passkey yet.")).toBeVisible()
})

test('Register More intent shows wallet instructions even when the identity already has a username', async ({ page }) => {
  await page.goto('/?scenario=wallet')
  await expect(page.getByText('Register another username in your Dash wallet.', { exact: false })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh usernames' })).toBeVisible()
  await expect(page.getByText(/all set/)).toHaveCount(0)
})

test('key visibility toggle is keyboard reachable without entering any key', async ({ page }) => {
  await page.goto('/?scenario=key')
  const key = page.getByPlaceholder(/private key/i)
  await key.focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Show key', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Hide key', exact: true })).toBeFocused()
})

for (const contract of ['social', 'blog', 'storefront']) {
  test(`mobile ${contract} election identifiers and results fit the viewport`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/?scenario=election-${contract}`)
    await expect(page.getByTestId('election-seated-team')).toContainText('Hga7gpqFN123hqkNueaeKvV6GVJgvJWpyYuuCXpe6J4m')
    await expect(page.getByTestId('election-contest')).toContainText('123456')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    expect(await page.getByTestId('election-status').evaluate((panel) => panel.scrollWidth <= panel.clientWidth)).toBe(true)
  })
}

test('confirmed blog deletion disappears from mounted discovery and stays excluded after remount and a lagging read', async ({ page }) => {
  await page.goto('/?scenario=discovery')
  await expect(page.getByText('Stale discovery blog')).toBeVisible()
  await page.getByRole('button', { name: 'Confirm deletion' }).click()
  await expect(page.getByText('Stale discovery blog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Remount discovery', exact: true }).click()
  await expect(page.getByText('Stale discovery blog')).toHaveCount(0)
})

test('a keyless second tab cannot erase a CRITICAL session; logout closes account controls in other tabs', async ({ page, context }) => {
  await page.goto('/?scenario=session')
  await page.getByRole('button', { name: 'Restore fixture session' }).click()
  await expect(page.getByRole('heading', { name: 'Signed in', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Signed in', exact: true })).toBeVisible()
  const other = await context.newPage()
  await other.goto('/?scenario=session')
  await expect(other.getByRole('heading', { name: 'Signed out', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Signed in', exact: true })).toBeVisible()
  await other.getByRole('button', { name: 'Restore fixture session' }).click()
  await other.getByRole('button', { name: 'Account controls' }).click()
  await expect(other.getByRole('dialog', { name: 'Account settings' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(other.getByRole('heading', { name: 'Signed out', exact: true })).toBeVisible()
  await expect(other.getByRole('dialog', { name: 'Account settings' })).toHaveCount(0)
  await expect(other.getByRole('button', { name: 'Account controls' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Restore fixture session' }).click()
  await other.reload()
  await expect(other.getByRole('heading', { name: 'Signed out', exact: true })).toBeVisible()
})

for (const theme of ['light', 'dark']) {
  test(`Explore rows support Tab, Enter and AA contrast in ${theme} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript((value) => localStorage.setItem('theme', value), theme)
    await page.goto('/?scenario=trends')
    if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/)
    else await expect(page.locator('html')).not.toHaveClass(/dark/)
    const topic = page.getByRole('link', { name: /#yappr/ })
    await page.getByRole('button', { name: 'All time', exact: true }).focus()
    await page.keyboard.press('Tab')
    await expectFocusContrast(topic)
    await expect(topic.locator('..')).toHaveCSS('opacity', '1')
    await expect(page.getByRole('link', { name: /\$DASH/ }).locator('..')).toHaveCSS('opacity', '1')
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/hashtag\?tag=yappr/)
  })
}

test('wallet moderation explains how to sign in and disables writes before submission', async ({ page }) => {
  await page.goto('/?scenario=pot&authorization=wallet')
  const notice = page.getByTestId('moderation-key-notice')
  await expect(notice).toContainText("Moderation actions need your account's CRITICAL key.")
  await expect(notice).toContainText('sign in with that key or a passkey that holds it')
  await expect(page.getByRole('button', { name: 'Ban', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Unban', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Suspend', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Unsuspend', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Claim for the team' })).toBeDisabled()
})

for (const contract of ['blog', 'storefront']) {
  test(`wallet ${contract} moderator menu ignores pointer clicks on disabled actions`, async ({ page }) => {
    await page.goto(`/?scenario=moderator-menu&contract=${contract}&authorization=wallet`)
    const initialUrl = page.url()
    await page.getByRole('button', { name: 'Moderate this item' }).click()
    await expect(page.getByTestId('moderation-key-notice')).toBeVisible()
    const remove = page.getByTestId('moderator-remove-offline-menu-item')
    const author = page.getByTestId('moderator-author-offline-menu-item')
    await expect(remove).toHaveAttribute('aria-disabled', 'true')
    await expect(author).toHaveAttribute('aria-disabled', 'true')
    // Real pointers still reach a disabled Radix div's custom onClick handler.
    await remove.click({ force: true })
    await expect(page.getByTestId('removal-target')).toHaveText('none')
    const navigation = page.waitForRequest(request => request.isNavigationRequest(), { timeout: 500 })
      .then(() => true, () => false)
    await author.click({ force: true })
    expect(await navigation).toBe(false)
    await expect(page).toHaveURL(initialUrl)
    await expect(page.getByTestId('removal-target')).toHaveText('none')
  })
}

test('confirmed storefront payout never re-enables a stale pot, then reconciles claim history', async ({ page }) => {
  await page.goto('/?scenario=pot')
  const claim = page.getByRole('button', { name: 'Claim for the team' })
  await expect(page.getByText('Never claimed', { exact: true })).toBeVisible()
  await expect(claim).toBeEnabled()
  await claim.click()
  await expect(page.getByText('Updating payout status…', { exact: true })).toBeVisible()
  await expect(page.getByText('0.000000 DASH', { exact: true })).toBeVisible()
  await expect(claim).toBeDisabled()
  // Exhaust the bounded reconciliation on a replica that still says Never claimed.
  await page.waitForTimeout(5000)
  await expect(claim).toBeDisabled()
  await expect(page.getByText('Never claimed', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Replica advances before payout' }).click()
  await page.getByRole('button', { name: 'Remount payout' }).click()
  await expect(page.getByText('0.000000 DASH', { exact: true })).toBeVisible()
  await expect(claim).toBeDisabled()
  await expect(page.getByText('Updating payout status…', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Replica catches up' }).click()
  await page.getByRole('button', { name: 'Refresh payout', exact: true }).click()
  await expect(page.getByText(/Last claimed in epoch 123/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Refresh payout', exact: true })).toHaveCount(0)
  await expect(claim).toBeDisabled()
})

test('blog settings and poll authoring use consumer copy', async ({ page }) => {
  await page.goto('/?scenario=copy')
  await expect(page.getByText('Organize your posts with labels.')).toBeVisible()
  await expect(page.locator('main')).not.toContainText(/taxonomy|Pollr contract|bytes/)
})

test('connection names and handles expose valid link and popup semantics', async ({ page }) => {
  await page.goto('/?scenario=connection')
  const name = page.getByRole('link', { name: 'Alice', exact: true })
  const handle = page.getByRole('link', { name: '@alice', exact: true })
  await expect(name).toBeVisible()
  await name.focus()
  await page.keyboard.press('Tab')
  await expect(handle).toBeFocused()
  await expect(page.locator('p[aria-expanded], h3[aria-expanded]')).toHaveCount(0)
  expect((await new AxeBuilder({ page }).withRules(['aria-allowed-attr']).analyze()).violations).toEqual([])
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/\/user\?id=offline-person/)
})

test('blog comments show one character counter, only near the limit, and enforce the text limit', async ({ page }) => {
  await page.goto('/?scenario=comments')
  await expect(page.getByText(/\/500 characters/)).toHaveCount(0)
  await expect(page.locator('main')).not.toContainText('bytes')
  const comment = page.getByPlaceholder(/comment/i)
  await comment.fill('a'.repeat(501))
  await expect(comment).toHaveValue('a'.repeat(500))
  await expect(page.getByText(/^500\/500 characters/)).toHaveCount(1)
})

for (const theme of ['light', 'dark']) {
  test(`shared text tokens retain AA contrast and distinct hover colours in ${theme}`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('theme', value), theme)
    await page.goto('/?scenario=tokens')
    for (const name of ['Primary action', 'Muted action']) {
      const action = page.getByRole('button', { name, exact: true })
      const normal = await action.evaluate((node) => getComputedStyle(node).color)
      expect((await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()).violations).toEqual([])
      await action.hover()
      await expect.poll(() => action.evaluate((node) => getComputedStyle(node).color)).not.toBe(normal)
      expect((await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()).violations).toEqual([])
      await page.mouse.move(1000, 800)
    }
  })
}
