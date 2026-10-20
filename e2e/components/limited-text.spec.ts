import { expect, test } from '@playwright/test'

test('pasted emoji stop at the UTF-8 cap and counters count complete code points', async ({ page }) => {
  await page.goto('/limited-text.html')
  const name = page.getByRole('textbox', { name: 'Blog name' })
  await name.fill('😀'.repeat(64))
  await expect(name).toHaveValue('😀'.repeat(48))
  await expect(page.getByText('48/64 characters')).toBeVisible()
  await expect(page.getByText('Text was shortened to fit. Some characters take more space.')).toBeVisible()
  await page.getByRole('textbox', { name: 'Report details' }).fill('😀'.repeat(500))
  await expect(page.getByRole('textbox', { name: 'Report details' })).toHaveValue('😀'.repeat(375))
  await expect(page.getByText('375/500 characters')).toBeVisible()
})
test('the character cap binds for ASCII and the byte cap binds for non-ASCII URLs', async ({ page }) => {
  await page.goto('/limited-text.html')
  await page.getByRole('textbox', { name: 'Blog name' }).fill('a'.repeat(80))
  await expect(page.getByRole('textbox', { name: 'Blog name' })).toHaveValue('a'.repeat(64))
  await page.getByRole('textbox', { name: 'Cover image' }).fill('https://a/' + 'é'.repeat(200))
  await expect(page.getByRole('textbox', { name: 'Cover image' })).toHaveValue('https://a/' + 'é'.repeat(123))
})

test('inserting in the middle of a full field preserves its ending', async ({ page }) => {
  await page.goto('/limited-text.html')
  const name = page.getByRole('textbox', { name: 'Blog name' })
  const full = 'a'.repeat(60) + 'TAIL'
  await name.fill(full)
  await name.evaluate((input: HTMLInputElement) => { input.focus(); input.setSelectionRange(30, 30) })
  await page.keyboard.insertText('XYZ😀')
  await expect(name).toHaveValue(full)
  const note = page.getByRole('textbox', { name: 'Report details' })
  const fullNote = '😀'.repeat(374) + 'TAIL'
  await note.fill(fullNote)
  await note.evaluate((input: HTMLTextAreaElement) => { input.focus(); input.setSelectionRange(4, 4) })
  await page.keyboard.insertText('😀')
  await expect(note).toHaveValue(fullNote)
})

test('counters stay hidden until the text nears its limit', async ({ page }) => {
  await page.goto('/limited-text.html')
  const name = page.getByRole('textbox', { name: 'Blog name' })
  await name.fill('a'.repeat(50))
  await expect(page.getByText(/\/64 characters/)).toHaveCount(0)
  await name.fill('a'.repeat(52))
  await expect(page.getByText('52/64 characters')).toBeVisible()
})
