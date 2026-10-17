/**
 * Settings > Developer > Build details is the only surface that renders
 * `NEXT_PUBLIC_GIT_COMMIT_HASH` in full, and it is auth-gated (`withAuth(SettingsPage)`),
 * so this check lives in the write project even though it writes nothing.
 * It cross-checks the rendered value against the build id the smoke project
 * asserts — both come from `git rev-parse --short HEAD` in next.config.js.
 */
import { openBuildDetails } from '../fixtures/app'
import { readBuildId } from '../fixtures/build-stamp'
import { expect, hasSeedPhrase, NO_SEED_REASON, test } from '../fixtures/auth'

test.describe('build stamp', () => {
  test.skip(!hasSeedPhrase, NO_SEED_REASON)

  test('settings reports the commit the app was built from', async ({ page, request }) => {
    await openBuildDetails(page)

    const rendered = (await page.getByTestId('build-commit').innerText()).trim()

    expect(rendered).not.toBe('')
    expect(rendered).not.toBe('dev')
    expect(rendered).toBe(await readBuildId(request))
  })
})
