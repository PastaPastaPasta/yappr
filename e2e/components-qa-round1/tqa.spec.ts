import AxeBuilder from '@axe-core/playwright'
import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page, baseURL }) => {
  await page.route('**/*', async route => {
    if (new URL(route.request().url()).origin === baseURL) await route.continue()
    else await route.abort()
  })
})
test('T-AUTH-01: invalid formats never enter availability review on immediate submission', async ({ page }) => {
  await page.goto('/tqa.html?fixture=username')
  await page.getByRole('button', { name: 'Register usernames' }).click()
  for (const label of ['invalid!', 'race_name']) {
    await page.getByPlaceholder('username').fill(label)
    await expect(page.getByRole('button', { name: 'Check Availability' })).toBeDisabled()
    await expect(page.getByText('Username can only contain letters, numbers, and hyphens')).toBeVisible()
  }
  await page.getByPlaceholder('username').fill('valid-name')
  await page.getByRole('button', { name: 'Check Availability' }).click()
  await expect(page.getByText('Available', { exact: true })).toBeVisible()
})
test('T-AUTH-02: named username dialog contains and restores keyboard focus', async ({ page }) => {
  await page.goto('/tqa.html?fixture=username')
  const trigger = page.getByRole('button', { name: 'Register usernames' })
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Add a username' })
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  for (let tab = 0; tab < 14; tab++) {
    await page.keyboard.press(tab < 7 ? 'Tab' : 'Shift+Tab')
    await expect.poll(() => dialog.evaluate(el => el.contains(document.activeElement))).toBe(true)
  }
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').withRules(['aria-dialog-name', 'label', 'button-name']).analyze()).violations).toEqual([])
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})
test('T-BP-01: Blog Settings names its fields and default switch', async ({ page }) => {
  await page.goto('/tqa.html?fixture=blog-settings')
  await page.getByLabel('Blog name', { exact: true }).fill('Renamed blog')
  await page.getByLabel('Description', { exact: true }).fill('Description')
  const toggle = page.getByRole('switch', { name: 'Comments enabled by default' })
  await toggle.focus()
  await page.keyboard.press('Space')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  expect((await new AxeBuilder({ page }).withRules(['label', 'button-name', 'aria-toggle-field-name']).analyze()).violations).toEqual([])
})
test('T-DM-001: new-group helper explains privacy without key-distribution details', async ({ page }) => {
  await page.goto('/tqa.html?fixture=new-group')
  await expect(page.getByRole('dialog')).toContainText('Nobody outside the group can see who is in it.')
  await expect(page.getByRole('dialog')).not.toContainText('group key')
})
for (const width of [390, 1440]) {
  test(`T-STORE-01/03: named product actions and a fitting toolbar (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/tqa.html?fixture=manage')
    const edit = page.getByRole('button', { name: 'Edit Euro variants', exact: true })
    await expect(edit).toBeVisible()
    await expect(page.getByRole('button', { name: 'Delete Euro variants', exact: true })).toBeVisible()
    await edit.focus()
    await expect(edit).toBeFocused()
    await expect(page.getByRole('button', { name: 'Add Product' })).toBeInViewport()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    expect((await new AxeBuilder({ page }).withRules(['button-name']).analyze()).violations).toEqual([])
  })
  test(`T-UX-02: guide legends meet contrast (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto('/tqa.html?fixture=guide')
    await expect(page.getByText('(CAN derive older)', { exact: true })).toBeVisible()
    await expect.poll(() => page.locator('.shadow-lg.overflow-hidden').evaluate(el => getComputedStyle(el).opacity)).toBe('1')
    expect((await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()).violations).toEqual([])
  })
}
test('T-STORE-02: a quick first click selects a star and keeps the SVG stable on hover', async ({ page }) => {
  await page.goto('/tqa.html?fixture=stars')
  const radio = page.getByRole('radio', { name: '4 stars' })
  await radio.locator('svg').evaluate(el => el.setAttribute('data-original', 'true'))
  await radio.click({ position: { x: 3, y: 3 } })
  await expect(radio).toBeChecked()
  await expect(radio.locator('svg')).toHaveAttribute('data-original', 'true')
  await expect(page.getByRole('button', { name: 'Submit review' })).toBeEnabled()
  await page.getByRole('radio', { name: '3 stars' }).focus()
  await page.keyboard.press('Space')
  await expect(page.getByRole('radio', { name: '3 stars' })).toBeChecked()
})
test('T-STORE-02: the first touch selects a rating', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  await page.goto(`${baseURL}/tqa.html?fixture=stars`)
  await page.getByRole('radio', { name: '4 stars' }).tap()
  await expect(page.getByRole('radio', { name: '4 stars' })).toBeChecked()
  await expect(page.getByRole('button', { name: 'Submit review' })).toBeEnabled()
  await context.close()
})
test('T-SOC-01: accepted nested replies survive a failed refresh and reconcile without duplicates', async ({ page }) => {
  await page.goto('/tqa.html?fixture=thread')
  await expect(page.getByText('Continuation', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Publish accepted reply' }).click()
  await expect(page.getByText('Accepted nested reply', { exact: true })).toBeVisible()
  await expect(page.locator('article').first()).toContainText('Accepted nested reply')
  await expect.poll(async () => Number(await page.getByRole('status', { name: 'Thread reads' }).textContent())).toBeGreaterThanOrEqual(3)
  await expect(page.getByText('Accepted nested reply', { exact: true })).toHaveCount(1)
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByText('Accepted nested reply', { exact: true })).toHaveCount(1)
})
test('T-SOC-01: exhausted reconciliation keeps the accepted reply and offers recovery', async ({ page }) => {
  await page.clock.install()
  await page.goto('/tqa.html?fixture=thread&scenario=outage')
  await expect(page.getByText('Continuation', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Publish accepted reply' }).click()
  await expect(page.getByText('Accepted nested reply', { exact: true })).toBeVisible()
  for (const delay of [1000, 3000, 8000]) await page.clock.runFor(delay + 100)
  await expect(page.getByRole('alert')).toContainText('Your reply is posted.')
  await expect(page.getByText('Accepted nested reply', { exact: true })).toHaveCount(1)
})
test('T-SOC-02: unavailable bookmarks remain in the list and can be removed individually', async ({ page }) => {
  await page.goto('/tqa.html?fixture=bookmarks')
  await expect(page.getByText('1 saved post', { exact: true })).toBeVisible()
  await expect(page.getByText('This post is no longer available.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Remove bookmark', exact: true }).click()
  await expect(page.getByText('0 saved posts', { exact: true })).toBeVisible()
  await expect(page.getByText('Save posts for later', { exact: true })).toBeVisible()
})
for (const mode of ['light', 'dark', 'sepia']) {
  test(`T-UX-02: blog metadata and BlockNote quotes retain reading contrast (${mode})`, async ({ page }) => {
    await page.goto(`/tqa.html?fixture=blog-reader&mode=${mode}`)
    await expect(page.getByRole('document', { name: 'Blog post' })).toBeVisible()
    await expect(page.locator('blockquote')).toHaveText('A readable quotation.')
    expect((await new AxeBuilder({ page }).withRules(['color-contrast']).analyze()).violations).toEqual([])
  })
}

test('T-STORE-01: inventory actions identify their product for keyboard and assistive technology', async ({ page }) => {
  await page.goto('/tqa.html?fixture=inventory')
  const edit = page.getByRole('button', { name: 'Edit Euro variants', exact: true })
  await edit.focus()
  await expect(edit).toBeFocused()
  await expect(page.getByRole('button', { name: 'Delete Euro variants', exact: true })).toBeVisible()
  expect((await new AxeBuilder({ page }).withRules(['button-name']).analyze()).violations).toEqual([])
})
test('T-UX-02: actual item stock text meets contrast', async ({ page }) => {
  await page.goto('/tqa.html?fixture=item')
  await expect(page.getByText('42 in stock', { exact: true })).toBeVisible()
  expect((await new AxeBuilder({ page }).include('.text-success').withRules(['color-contrast']).analyze()).violations).toEqual([])
})
for (const mode of ['light', 'dark', 'sepia']) {
  test(`T-UX-02: actual article metadata meets contrast (${mode})`, async ({ page }) => {
    await page.goto(`/tqa.html?fixture=article&mode=${mode}`)
    await expect(page.getByRole('heading', { name: 'Readable article', exact: true })).toBeVisible()
    await expect(page.locator('blockquote')).toHaveText('A readable quotation.')
    expect((await new AxeBuilder({ page }).include('.blog-theme-scope').withRules(['color-contrast']).analyze()).violations).toEqual([])
  })
}

for (const scenario of ['paged', 'indexing']) {
  test(`T-SOC-01: confirms accepted replies beyond page one (${scenario})`, async ({ page }) => {
    await page.clock.install()
    await page.goto(`/tqa.html?fixture=thread&scenario=${scenario}`)
    await expect(page.getByText('Continuation', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Publish accepted reply' }).click()
    await expect(page.getByText('Accepted nested reply', { exact: true })).toBeVisible()
    for (const delay of [1000, 3000, 8000]) await page.clock.runFor(delay + 100)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByText('Accepted nested reply', { exact: true })).toHaveCount(1)
    await expect(page.locator('article').first()).toContainText('Accepted nested reply')
  })
}
test('T-SOC-02: a transient hydration error offers Retry without claiming posts are gone', async ({ page }) => {
  await page.goto('/tqa.html?fixture=bookmarks&scenario=bookmark-outage')
  await expect(page.getByRole('alert')).toContainText('could not')
  await expect(page.getByText('This post is no longer available.', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove bookmark', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByText('1 saved post', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText('This post is no longer available.', { exact: true })).toHaveCount(0)
})

test('T-SOC-01: a fetched child retains its previously visible parent outside page one', async ({ page }) => {
  test.skip(process.env.TQA_SOCIAL_TOPOLOGY === 'v2', 'Modern grouped pagination')
  await page.goto('/tqa.html?fixture=thread&scenario=child-page')
  await expect(page.getByText('Continuation', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Publish accepted reply' }).click()
  await expect.poll(async () => Number(await page.getByRole('status', { name: 'Thread reads' }).textContent())).toBeGreaterThanOrEqual(3)
  await expect(page.getByText('Accepted nested reply', { exact: true })).toHaveCount(1)
  await expect(page.locator('article[data-reply-id="continuation"]')).toContainText('Accepted nested reply')
  await expect(page.getByRole('alert')).toHaveCount(0)
})
test('T-SOC-01: visible v2 descendants accept and retain answers', async ({ page }) => {
  test.skip(process.env.TQA_SOCIAL_TOPOLOGY !== 'v2', 'Legacy v2 fixture')
  await page.goto('/tqa.html?fixture=thread&scenario=v2-descendant')
  await expect(page.getByText('Rendered nested child', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Publish accepted reply' }).click()
  await expect(page.getByText('Accepted nested reply', { exact: true })).toBeVisible()
  await expect.poll(async () => Number(await page.getByRole('status', { name: 'Thread reads' }).textContent())).toBeGreaterThanOrEqual(3)
  await expect(page.locator('article[data-reply-id="descendant"]')).toContainText('Accepted nested reply')
})
test('T-SOC-01: the actual post page keeps accepted replies mounted during a slow refresh', async ({ page }) => {
  await page.goto('/tqa.html?fixture=thread-page&scenario=slow')
  await expect(page.getByText('Continuation', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Publish accepted reply' }).click()
  const accepted = page.locator('article[data-reply-id="accepted"]')
  await expect(accepted).toBeVisible()
  await accepted.evaluate(el => el.setAttribute('data-retained', 'true'))
  await expect(page.getByText('Loading replies...', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Finish thread read' }).click()
  await expect(accepted).toHaveAttribute('data-retained', 'true')
  await expect(accepted).toHaveCount(1)
})

test('T-SOC-01: the actual page retains accepted replies across a main-post transport failure', async ({ page }) => {
  await page.clock.install()
  await page.goto('/tqa.html?fixture=thread-page&scenario=post-outage')
  await expect(page.getByText('Continuation', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Publish accepted reply' }).click()
  await expect(page.locator('article[data-reply-id="accepted"]')).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Couldn’t refresh this thread.')
  await expect(page.getByText('Post not found', { exact: true })).toHaveCount(0)
  await page.clock.runFor(1100)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('article[data-reply-id="accepted"]')).toHaveCount(1)
})

for (const scenario of ['live', 'outage', 'deleted']) {
  test(`T-SOC-02: legacy reply bookmarks distinguish ${scenario} targets`, async ({ page }) => {
    test.skip(process.env.TQA_SOCIAL_TOPOLOGY !== 'v2', 'Only legacy contracts support reply bookmarks')
    await page.goto(`/tqa.html?fixture=bookmarks&scenario=reply-bookmark-${scenario}`)
    if (scenario === 'outage') {
      await expect(page.getByRole('alert')).toContainText('Bookmarks could not be loaded.')
      await expect(page.getByText('This post is no longer available.', { exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'Retry', exact: true }).click()
    }
    await expect(page.getByText('1 saved post', { exact: true })).toBeVisible()
    if (scenario === 'deleted') {
      await expect(page.getByText('This post is no longer available.', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: 'Remove bookmark', exact: true }).click()
      await expect(page.getByText('0 saved posts', { exact: true })).toBeVisible()
    } else {
      await expect(page.locator('article[data-target-kind="reply"]')).toContainText('Continuation')
      await expect(page.getByText('This post is no longer available.', { exact: true })).toHaveCount(0)
    }
  })
}

test('T-SOC-02: modern bookmarks do not query unsupported reply targets', async ({ page }) => {
  test.skip(process.env.TQA_SOCIAL_TOPOLOGY === 'v2', 'Modern contracts forbid reply bookmarks')
  await page.goto('/tqa.html?fixture=bookmarks&scenario=reply-bookmark-live')
  await expect(page.getByText('1 saved post', { exact: true })).toBeVisible()
  await expect(page.getByText('This post is no longer available.', { exact: true })).toBeVisible()
  await expect(page.locator('article[data-target-kind="reply"]')).toHaveCount(0)
})

for (const change of ['removed', 'tombstone', 'outage', 'proof-outage']) {
  test(`T-SOC-01: retained ancestry reflects ${change} after pagination reconciliation`, async ({ page }) => {
    test.skip(process.env.TQA_SOCIAL_TOPOLOGY === 'v2', 'Flat contracts preserve children of removed ancestors')
    await page.goto(`/tqa.html?fixture=thread&scenario=ancestor-${change}`)
    await expect(page.getByText('Continuation', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Publish accepted reply' }).click()
    await expect(page.getByText('Settled', { exact: true })).toBeVisible()
    await expect(page.locator('article[data-reply-id="accepted"]')).toHaveCount(1)
    const parent = page.locator('article[data-reply-id="continuation"]')
    await expect(parent).toContainText('Continuation')
    await page.getByRole('button', { name: 'Change ancestor', exact: true }).click()
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    if (change.includes('outage')) {
      await expect(page.getByRole('alert')).toContainText('Replies could not be refreshed.')
      await expect(parent).toContainText('Continuation')
      await expect(page.locator('article[data-reply-id="accepted"]')).toHaveCount(1)
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    }
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(parent).not.toContainText('Continuation')
    await expect(parent).toHaveAttribute(change === 'removed' || change === 'proof-outage' ? 'data-deleted-stub' : 'data-deleted', 'true')
    await expect(parent.locator('article[data-reply-id="accepted"]')).toHaveCount(1)
  })
}

for (const change of ['removed', 'tombstone', 'outage', 'pagination']) {
  test(`T-SOC-01: confirmed beyond-page-one reply reflects ${change} without navigation`, async ({ page }) => {
    test.skip(change === 'pagination' && process.env.TQA_SOCIAL_TOPOLOGY === 'v2', 'Only flat contracts paginate the thread')
    await page.clock.install()
    await page.goto(`/tqa.html?fixture=thread&scenario=confirmed-${change}`)
    await expect(page.getByText('Continuation', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Publish accepted reply' }).click()
    // The first read fails; the bounded retry confirms the off-page reply.
    await expect(page.getByRole('alert')).toContainText('Replies could not be refreshed.')
    await page.clock.runFor(1100)
    await expect(page.getByRole('alert')).toHaveCount(0)
    const reply = page.locator('article[data-reply-id="accepted"]')
    await expect(reply).toHaveText('Accepted nested reply')
    if (change === 'pagination') {
      await page.getByRole('button', { name: 'Load more', exact: true }).click()
      await page.getByRole('button', { name: 'Change accepted reply', exact: true }).click()
    } else {
      await page.getByRole('button', { name: 'Change accepted reply', exact: true }).click()
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    }
    if (change === 'outage') {
      await expect(page.getByRole('alert')).toContainText('Replies could not be refreshed.')
      await expect(reply).toHaveText('Accepted nested reply')
      await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    }
    await expect(page.getByRole('alert')).toHaveCount(0)
    // Flat trees prune leaf tombstones; v2 renders the returned tombstone.
    if (change === 'removed' || process.env.TQA_SOCIAL_TOPOLOGY !== 'v2') await expect(reply).toHaveCount(0)
    else {
      await expect(reply).toHaveAttribute('data-deleted', 'true')
      await expect(reply).toHaveText('')
    }
    // A later refresh must not restore the old accepted-write snapshot.
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect(page.getByText('Settled', { exact: true })).toBeVisible()
    await expect(page.getByText('Accepted nested reply', { exact: true })).toHaveCount(0)
  })
}
