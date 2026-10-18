import { expect, type Locator } from '@playwright/test'

/** For transparent links or inset outlines, check the nearest opaque background. */
export async function expectFocusContrast(locator: Locator) {
  await expect(locator).toBeFocused()
  const indicator = await locator.evaluate((element) => {
    const style = getComputedStyle(element)
    const channels = (color: string) => color.match(/[\d.]+/g)!.map(Number)
    let backdrop: Element | null = element
    let background = [255, 255, 255]
    while (backdrop) {
      const color = channels(getComputedStyle(backdrop).backgroundColor)
      if (color.length === 3 || color[3] === 1) {
        background = color
        break
      }
      backdrop = backdrop.parentElement
    }
    const luminance = (rgb: number[]) => rgb.slice(0, 3).reduce((sum, value, index) => {
      const channel = value / 255
      return sum + (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) * [0.2126, 0.7152, 0.0722][index]
    }, 0)
    const outlineChannels = channels(style.outlineColor)
    const outline = luminance(outlineChannels)
    const surface = luminance(background)
    return {
      style: style.outlineStyle,
      alpha: outlineChannels[3] ?? 1,
      width: parseFloat(style.outlineWidth),
      contrast: (Math.max(outline, surface) + 0.05) / (Math.min(outline, surface) + 0.05),
    }
  })
  expect(indicator.style).not.toBe('none')
  expect(indicator.alpha).toBe(1)
  expect(indicator.width).toBeGreaterThanOrEqual(2)
  expect(indicator.contrast).toBeGreaterThanOrEqual(3)
}
