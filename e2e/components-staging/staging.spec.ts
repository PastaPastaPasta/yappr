import { expect, test, type Page } from '@playwright/test'

const POSTING_CLOSED = 'Posting opens when the first community moderators are elected.'
const LEADER = 'CcgaYFrJW44g1ANN9CzG37LnS76YxWnWa1iB4Qn98uYB'
const MEMBERS = ['31Q7gwikN11NcaTaeTDfLdeJVALajvKvAJxcnd8cACTM', 'EJ4ngg7CQ4ryovsw5Fwetprx9im1eno7GocBLiHoU8i', '8DteaK5n267ss12hdkMaEftwyWgoMBzvQRggTNDy4rPq']

test.beforeEach(async ({ page }) => {
  // Offline: every chain read is a mock, so nothing may leave the page.
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort())
})

type Results = Array<{ label: string; success: boolean; isContested: boolean }>

async function sendBatch(page: Page) {
  await page.goto('/dpns/register?fixture=dpns&next=%2Fsettings')
  await page.getByRole('button', { name: /^Register 1 Username/ }).click()
  await expect(page.getByRole('heading', { name: 'Registering Usernames' })).toBeVisible()
}

const settle = (page: Page, results: Results) =>
  page.evaluate((r) => window.fixture.settleRegistration(r), results).then((settled) => expect(settled).toBe(true))

test.describe('DPNS registration on the username detour', () => {
  test('a name that only joined its vote never becomes the username, and Continue goes on as Skip does', async ({ page }) => {
    await sendBatch(page)
    await settle(page, [{ label: 'contested-name', success: true, isContested: true }])
    await expect(page.getByText('Your name is waiting for the community vote.')).toBeVisible()
    await expect(page.getByText('Waiting for the community vote', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    expect(await page.evaluate(() => window.fixture.pushed)).toEqual(['/settings'])
    expect(await page.evaluate(() => window.fixture.auth.granted())).toEqual([])
    expect(await page.evaluate(() => window.fixture.hasSkippedUsername('fixture-alice'))).toBe(true)
  })

  test('a contested name the sender already won is granted as the username', async ({ page }) => {
    await sendBatch(page)
    await settle(page, [{ label: 'contested-name', success: true, isContested: false }])
    await expect(page.getByText('Username registered successfully!')).toBeVisible()
    await expect(page.getByText('Waiting for the community vote', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    expect(await page.evaluate(() => window.fixture.pushed)).toEqual(['/settings'])
    expect(await page.evaluate(() => window.fixture.auth.granted())).toEqual([{ identityId: 'fixture-alice', name: 'contested-name' }])
    expect(await page.evaluate(() => window.fixture.hasSkippedUsername('fixture-alice'))).toBe(false)
  })

  const endings = [
    ['a sign-out', () => window.fixture.auth.signOut()],
    ['an account switch', () => window.fixture.auth.switchTo('fixture-bob')],
  ] as const
  const outcomes = [['joined its vote', true], ['was granted', false]] as const
  for (const [ending, end] of endings) {
    for (const [outcome, isContested] of outcomes) {
      test(`a name that ${outcome} after ${ending} records nothing for either session`, async ({ page }) => {
        await sendBatch(page)
        await page.evaluate(end)
        await settle(page, [{ label: 'contested-name', success: true, isContested }])
        // Nothing appears to wait on: give the late batch time to (wrongly) land before checking it didn't.
        await page.waitForTimeout(250)
        await expect(page.getByRole('heading', { name: 'Registering Usernames' })).toBeVisible()
        await expect(page.getByText(/waiting for the community vote|registered successfully/)).toHaveCount(0)
        expect(await page.evaluate(() => window.fixture.auth.granted())).toEqual([])
        expect(await page.evaluate(() => ['fixture-alice', 'fixture-bob'].map(window.fixture.hasSkippedUsername))).toEqual([false, false])
      })
    }
  }
})

test.describe('posting on social v20 under a notYetUsable interim', () => {
  test('with no team seated the composer stays closed with the posting-closed notice', async ({ page }) => {
    await page.goto('/?fixture=compose&seated=0')
    await page.getByTestId('compose-textarea').first().fill('Hello from the fixture')
    await expect(page.getByTestId('posting-closed')).toContainText(POSTING_CLOSED)
    await expect(page.getByTestId('compose-submit-btn')).toBeDisabled()
  })

  test('with a team seated the notice is gone and a signed-in user can post', async ({ page }) => {
    await page.goto('/?fixture=compose&seated=1')
    const submit = page.getByTestId('compose-submit-btn')
    await expect(submit).toBeDisabled()
    await page.getByTestId('compose-textarea').first().fill('Hello from the fixture')
    await expect(submit).toBeEnabled()
    await expect(page.getByTestId('posting-closed')).toHaveCount(0)
  })
})

test('the moderation-teams page shows the seated social team, its leader and members', async ({ page }) => {
  await page.goto('/moderation-teams?contract=social&seated=1')
  const seated = page.getByTestId('seated-team')
  await expect(seated).toBeVisible()
  await expect(seated.locator(`a[title="${LEADER}"]`)).toHaveCount(1)
  for (const member of MEMBERS) await expect(seated.locator(`a[title="${member}"]`)).toHaveCount(1)
  await expect(page.getByText('This contract has its moderation team.')).toBeVisible()
  await expect(page.getByRole('link', { name: /Start a team/ })).toHaveCount(0)
})

test('the moderation-teams page shows no seated team while none is seated', async ({ page }) => {
  await page.goto('/moderation-teams?contract=social&seated=0')
  await expect(page.getByTestId('election-overview')).toBeVisible()
  await expect(page.getByTestId('seated-team')).toHaveCount(0)
})
