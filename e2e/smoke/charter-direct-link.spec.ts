import { expect, test, type Page } from '@playwright/test'
import { appUrl } from '../fixtures/app'

/**
 * A moderation charter opened by its link in a fresh browser must show, not
 * "could not be found" (WUX-4). A read made on mount can run before
 * SdkProvider's bootstrap (React runs a child's effects before its parent's),
 * so no read may depend on anything having initialized the SDK first, and a
 * read that fails must never be shown as "not found".
 *
 * `E2E_CHARTER_PROPOSAL` names a proposal filed on this deployment's charters
 * contract as `<contract>:<id>` (`social`, `blog` or `store`), e.g.
 * `social:68NCs21F49sF3rTsqXccAyxanQ4EBv8XpcZX9Rycq4mj` on yap.pr/staging.
 */
const [contract, proposalId] = (process.env.E2E_CHARTER_PROPOSAL ?? '').split(':')
/** A well-formed identifier no proposal has. */
const UNFILED = '11111111111111111111111111111111'

function collectSdkErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => { if (message.text().includes('SDK not configured')) errors.push(message.text()) })
  return errors
}

test('a charter opened by its link in a fresh browser shows the proposal', async ({ page }) => {
  test.skip(!proposalId, 'E2E_CHARTER_PROPOSAL must name a proposal on this deployment as <contract>:<id>')
  const sdkErrors = collectSdkErrors(page)
  await page.goto(appUrl(`/moderation-teams/?contract=${contract}&proposal=${proposalId}`))
  await expect(page.getByTestId('proposal-view')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('heading', { name: /^Charter led by/ })).toBeVisible()
  expect(sdkErrors).toEqual([])
})

test('a link to a proposal nobody filed reads the chain and says so', async ({ page }) => {
  const sdkErrors = collectSdkErrors(page)
  await page.goto(appUrl(`/moderation-teams/?proposal=${UNFILED}`))
  const answer = page.getByText(/This proposal could not be found\.|No contract on this site elects its moderators\.|The proposal couldn.t be read\./)
  await expect(answer).toBeVisible({ timeout: 60_000 })
  test.skip(await page.getByText('No contract on this site elects its moderators.').isVisible(), 'This deployment elects no moderators')
  await expect(page.getByText('This proposal could not be found.')).toBeVisible()
  expect(sdkErrors).toEqual([])
})
