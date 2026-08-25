import type { CSSProperties } from 'react'

export type ReadingMode = 'author' | 'light' | 'dark' | 'sepia'
export type FontSizeLevel = 'small' | 'medium' | 'large' | 'xlarge'

const READING_MODE_PALETTES: Record<Exclude<ReadingMode, 'author'>, Record<string, string>> = {
  light: {
    '--blog-bg': '#ffffff',
    '--blog-text': '#1a1a1a',
    '--blog-heading': '#111111',
    '--blog-accent': '#2563eb',
    '--blog-link': '#2563eb',
    '--blog-surface': '#f5f5f5',
    '--blog-border': '#e5e5e5',
  },
  dark: {
    '--blog-bg': '#121212',
    '--blog-text': '#d4d4d4',
    '--blog-heading': '#f5f5f5',
    '--blog-accent': '#60a5fa',
    '--blog-link': '#60a5fa',
    '--blog-surface': '#1e1e1e',
    '--blog-border': '#2a2a2a',
  },
  sepia: {
    '--blog-bg': '#faf4e8',
    '--blog-text': '#5c4033',
    '--blog-heading': '#3e2723',
    '--blog-accent': '#b8860b',
    '--blog-link': '#b8860b',
    '--blog-surface': '#f0e6d2',
    '--blog-border': '#d7cbb8',
  },
}

const FONT_SIZE_MAP: Record<FontSizeLevel, string> = {
  small: '0.875em',
  medium: '1em',
  large: '1.125em',
  xlarge: '1.25em',
}

export function getReaderOverrideStyle(mode: ReadingMode): CSSProperties | undefined {
  if (mode === 'author') return undefined
  const palette = READING_MODE_PALETTES[mode]
  return {
    ...palette,
    backgroundColor: 'var(--blog-bg)',
    color: 'var(--blog-text)',
  } as CSSProperties
}

export function getReaderFontSize(level: FontSizeLevel): string | undefined {
  if (level === 'medium') return undefined
  return FONT_SIZE_MAP[level]
}

/**
 * Determine the app-level theme ('light' | 'dark') that best matches the
 * reading mode.  For 'author' mode we check the blog's background colour
 * luminance so the nav / comments / buttons feel consistent with the blog
 * theme.
 */
export function getAppThemeForReadingMode(
  mode: ReadingMode,
  authorBg?: string,
): 'light' | 'dark' {
  if (mode === 'light' || mode === 'sepia') return 'light'
  if (mode === 'dark') return 'dark'

  // 'author' — detect from the blog bg colour
  if (authorBg) {
    let hex = authorBg.replace('#', '')
    // Normalize shorthand: #RGB → RRGGBB, #RGBA → RRGGBB
    if (hex.length === 3 || hex.length === 4) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
    }
    // For 8-char (RRGGBBAA), use first 6 chars only
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      // Relative luminance (sRGB approximation)
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
      return luminance > 0.5 ? 'light' : 'dark'
    }
  }

  return 'dark'
}
