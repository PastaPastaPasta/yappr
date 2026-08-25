import { expect, type Locator, type Page } from '@playwright/test'

/**
 * Reads something back from Dash Platform.
 *
 * Writes are eventually consistent and DAPI routinely 504s on
 * `wait_for_state_transition_result` even when the transition landed — the app
 * assumes success, updates optimistically and caches the signed transition for
 * retry. So a freshly written document may take several blocks (and several
 * client-side cache windows) to show up in a query. Reloading beats waiting on
 * one page, because the app caches query results per page load.
 */
export async function reloadUntilVisible(
  page: Page,
  url: string,
  locator: (page: Page) => Locator,
  options: { attempts?: number; perAttemptMs?: number } = {}
): Promise<Locator> {
  const attempts = options.attempts ?? 5
  const perAttemptMs = options.perAttemptMs ?? 15_000

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.goto(url)
    const target = locator(page).first()
    if (attempt === attempts) {
      // Last attempt asserts, so a failure reports the real locator and screenshot.
      await expect(target).toBeVisible({ timeout: perAttemptMs })
      return target
    }
    try {
      await target.waitFor({ state: 'visible', timeout: perAttemptMs })
      return target
    } catch {
      // Not indexed yet — reload and look again.
    }
  }

  throw new Error('unreachable')
}
