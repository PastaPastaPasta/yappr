import { test, expect, type Page } from '@playwright/test'

/** The real BlockNote blog editor (tiptap + ProseMirror), so a dependency bump that breaks it fails here. */

const editor = (page: Page) => page.locator('[contenteditable="true"]').first()

async function paste(page: Page, html: string) {
  await editor(page).evaluate((element, markup) => {
    const data = new DataTransfer()
    data.setData('text/html', markup)
    data.setData('text/plain', 'pasted')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, html)
}

test('blog-editor: typing and a markdown shortcut become blocks', async ({ page }) => {
  await page.goto('/?fixture=blog-editor')
  await editor(page).click()
  await page.keyboard.type('# Title')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Body text')
  await expect.poll(() => page.evaluate(() => JSON.stringify(window.blogEditorBlocks))).toContain('Body text')
  const heading = await page.evaluate(() => (window.blogEditorBlocks as Array<{ type: string; content?: Array<{ text?: string }> }>)[0])
  expect(heading.type).toBe('heading')
  expect(heading.content?.[0]?.text).toBe('Title')
})

test('blog-editor: pasted HTML keeps its text and runs none of its script', async ({ page }) => {
  await page.goto('/?fixture=blog-editor')
  await editor(page).click()
  await paste(page, [
    '<div data-pm-slice=\'1 1 ["blockGroup",{"onclick":"window.pastedScriptRan=true"}]\'>',
    '<p>Safe words <a href="javascript:window.pastedScriptRan=true">a link</a></p>',
    '<img src="x" onerror="window.pastedScriptRan=true">',
    '<p onmouseover="window.pastedScriptRan=true">More words</p>',
    '</div>',
  ].join(''))
  await expect.poll(() => page.evaluate(() => JSON.stringify(window.blogEditorBlocks))).toContain('More words')
  await page.getByText('More words').hover()
  expect(await page.evaluate(() => window.pastedScriptRan)).toBeUndefined()
  const unsafe = await editor(page).evaluate((root) => [...root.querySelectorAll('*')].flatMap((element) =>
    [...element.attributes]
      .filter((attribute) => /^on/i.test(attribute.name) || /^\s*javascript:/i.test(attribute.value))
      .map((attribute) => `${element.tagName}[${attribute.name}=${attribute.value}]`)))
  expect(unsafe).toEqual([])
})
