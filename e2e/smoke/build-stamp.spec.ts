/**
 * Guards against testing a stale or mis-built artifact.
 *
 * next.config.js derives BOTH `NEXT_PUBLIC_GIT_COMMIT_HASH` and `generateBuildId`
 * from `git rev-parse --short HEAD`, so the build id embedded in every served
 * page is the same value the settings page prints under "Build Information".
 * The settings page itself is auth-gated (`withAuth(SettingsPage)`), so the
 * identity-free smoke project asserts the build id here and the write project
 * cross-checks the rendered settings value against it.
 *
 * Strict equality with the local HEAD is deliberately not asserted: CI checks
 * out a merge commit, and `E2E_BASE_URL` can point at an already-deployed site.
 */
import { expect, test } from '@playwright/test'
import { readBuildId } from '../fixtures/build-stamp'

test('the served build carries a real build stamp', async ({ request }) => {
  const buildId = await readBuildId(request)

  expect(buildId, 'the served HTML should embed a Next.js build id').toBeTruthy()
  // next.config.js falls back to these when git metadata is unavailable.
  expect(buildId).not.toBe('unknown')
  expect(buildId).not.toBe('dev')
})
