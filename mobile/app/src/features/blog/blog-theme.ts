import type { BlogFontKind, BlogThemeDTO } from '@engine/api';
import { Platform, type TextStyle } from 'react-native';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { syncStorage } from '~/state/storage';

/**
 * A blog's look on a phone: its colors and font families (web's
 * `theme-provider.tsx`, without custom CSS), and the reader's own "Aa"
 * choices (`lib/blog/reader-preferences.ts`): a reading mode that replaces
 * the author's colors, and a text size.
 */

export type ReadingMode = 'author' | 'light' | 'dark' | 'sepia';
export type FontSizeLevel = 'small' | 'medium' | 'large' | 'xlarge';

export interface BlogPalette {
  bg: string;
  text: string;
  heading: string;
  accent: string;
  link: string;
  surface: string;
  border: string;
  /** Secondary text (web's `--blog-muted`). */
  muted: string;
  /** The status bar and controls over `bg`. */
  dark: boolean;
}

/** `READING_MODE_PALETTES` in `lib/blog/reader-preferences.ts`. */
const READING_MODES: Record<Exclude<ReadingMode, 'author'>, Omit<BlogPalette, 'muted' | 'dark'>> = {
  light: { bg: '#ffffff', text: '#1a1a1a', heading: '#111111', accent: '#2563eb', link: '#2563eb', surface: '#f5f5f5', border: '#e5e5e5' },
  dark: { bg: '#121212', text: '#d4d4d4', heading: '#f5f5f5', accent: '#60a5fa', link: '#60a5fa', surface: '#1e1e1e', border: '#2a2a2a' },
  sepia: { bg: '#faf4e8', text: '#5c4033', heading: '#3e2723', accent: '#b8860b', link: '#b8860b', surface: '#f0e6d2', border: '#d7cbb8' },
};

/** `FONT_SIZE_MAP`: the body size's scale. */
export const FONT_SCALES: Record<FontSizeLevel, number> = { small: 0.875, medium: 1, large: 1.125, xlarge: 1.25 };

export const READING_MODE_OPTIONS: { value: ReadingMode; label: string }[] = [
  { value: 'author', label: 'Author' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'sepia', label: 'Sepia' },
];

export const FONT_SIZE_OPTIONS: { value: FontSizeLevel; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'Largest' },
];

/** `color` without its `#`, with a short `#rgb`/`#rgba` form expanded to `rrggbb`. */
function expandHex(color: string): string {
  const hex = color.replace('#', '');
  return hex.length === 3 || hex.length === 4 ? hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2] : hex;
}

/** Relative luminance (sRGB approximation) of a `#rgb`/`#rrggbb` color; 0 for anything else. */
function luminance(color: string): number {
  const hex = expandHex(color);
  if (hex.length !== 6 && hex.length !== 8) return 0;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16));
  if ([r, g, b].some(Number.isNaN)) return 0;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** Only plain hex colors reach a style: the stored theme is author input. */
const safe = (color: string, fallback: string) => (HEX.test(color) ? color : fallback);

/** `color` at `alpha` (0–1), for muted text. */
function withAlpha(color: string, alpha: number): string {
  return `#${expandHex(color).slice(0, 6)}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}

/** The palette a reader sees: the author's colors, or the reading mode's. */
export function blogPalette(theme: BlogThemeDTO, mode: ReadingMode = 'author'): BlogPalette {
  const source = mode === 'author' ? theme.colors : READING_MODES[mode];
  const bg = safe(source.bg, '#ffffff');
  const dark = mode === 'author' ? luminance(bg) <= 0.5 : mode === 'dark';
  const text = safe(source.text, dark ? '#e5e7eb' : '#111827');
  return {
    bg,
    text,
    heading: safe(source.heading, text),
    accent: safe(source.accent, '#0ea5e9'),
    link: safe(source.link, '#0ea5e9'),
    surface: safe(source.surface, bg),
    border: safe(source.border, dark ? '#2a2a3e' : '#e2e8f0'),
    muted: withAlpha(text, 0.7),
    dark,
  };
}

/** Readable text over a solid `color` (a button in the blog's link color). */
export const onColor = (color: string) => (luminance(color) > 0.6 ? '#111827' : '#ffffff');

const FAMILIES: Record<BlogFontKind, string | undefined> = {
  sans: undefined,
  serif: Platform.select({ ios: 'Georgia', default: 'serif' }),
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }),
};

const SERIF_IDS = new Set(['lora', 'merriweather', 'playfair', 'source-serif-4']);
/** The system family standing in for a blog font id (the app ships no web fonts). */
function fontKindOf(id: string): BlogFontKind {
  return id === 'jetbrains-mono' ? 'mono' : SERIF_IDS.has(id) ? 'serif' : 'sans';
}

export function fontStyle(id: string): TextStyle {
  const family = FAMILIES[fontKindOf(id)];
  return family ? { fontFamily: family } : {};
}

/** The reader's "Aa" choices, remembered on the device (web keeps them in its store). */
export const useReaderPrefs = create<{ mode: ReadingMode; size: FontSizeLevel }>()(
  persist(() => ({ mode: 'author' as ReadingMode, size: 'medium' as FontSizeLevel }), {
    name: 'yappr.blog.reader',
    storage: createJSONStorage(() => syncStorage),
    merge: (persisted, current) => {
      const value = (persisted ?? {}) as { mode?: unknown; size?: unknown };
      return {
        ...current,
        mode: READING_MODE_OPTIONS.some((o) => o.value === value.mode) ? (value.mode as ReadingMode) : current.mode,
        size: FONT_SIZE_OPTIONS.some((o) => o.value === value.size) ? (value.size as FontSizeLevel) : current.size,
      };
    },
  }),
);
