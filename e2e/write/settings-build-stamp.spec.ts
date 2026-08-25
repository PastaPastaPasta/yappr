/**
 * The settings page is the only surface that renders
 * `NEXT_PUBLIC_GIT_COMMIT_HASH`, and it is auth-gated (`withAuth(SettingsPage)`),
 * so this check lives in the write project even though it writes nothing.
 * It cross-checks the rendered value against the build id the smoke project
 * asserts — both come from `git rev-parse --short HEAD` in next.config.js.
 */
import { appUrl } from '../fixtures/app'
import { readBuildId } from '../fixtures/build-stamp'
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'

test.describe('build stamp', () => {
  test.skip(!hasSeedPhrase, NO_SEED_REASON)

  test('settings reports the commit the app was built from', async ({ page, request }) => {
    await page.goto(appUrl('/settings/?section=about'))

    await expect(page.getByText('Build Information')).toBeVisible({ timeout: 60_000 })

    const commit = page.getByText('Commit:', { exact: true }).locator('xpath=following-sibling::span[1]')
    const rendered = (await commit.innerText()).trim()

    expect(rendered).not.toBe('')
    expect(rendered).not.toBe('dev')
    expect(rendered).toBe(await readBuildId(request))
  })
})
