export type BlogLayoutMode = 'wide' | 'narrow' | 'magazine'
export type BlogHeaderStyle = 'hero' | 'minimal' | 'banner'
export type BlogGradientType = 'solid' | 'linear' | 'radial'

export interface BlogGradientConfig {
  type: BlogGradientType
  angle: number       // 0-360
  from: string        // hex color
  to: string          // hex or 'transparent'
  opacity: number     // 0-100
}

export interface BlogThemeColors {
  bg: string
  text: string
  accent: string
  heading: string
  link: string
  surface: string
  border: string
}

export interface BlogThemeFonts {
  body: string
  heading: string
}

export interface BlogThemeConfig {
  colors: BlogThemeColors
  fonts: BlogThemeFonts
  layout: BlogLayoutMode
  headerStyle: BlogHeaderStyle
  customCSS: string
  gradient?: BlogGradientConfig
}

export interface BlogThemePreset {
  id: string
  name: string
  description: string
  config: BlogThemeConfig
}

export interface BlogFontOption {
  id: string
  label: string
  stack: string
  googleFamily: string
}

export const BLOG_FONT_OPTIONS: BlogFontOption[] = [
  { id: 'inter', label: 'Inter', stack: 'Inter, system-ui, sans-serif', googleFamily: 'Inter:wght@400;500;600;700;800' },
  { id: 'lora', label: 'Lora', stack: 'Lora, Georgia, serif', googleFamily: 'Lora:wght@400;500;600;700' },
  { id: 'merriweather', label: 'Merriweather', stack: 'Merriweather, Georgia, serif', googleFamily: 'Merriweather:wght@400;700;900' },
  { id: 'space-grotesk', label: 'Space Grotesk', stack: '"Space Grotesk", Inter, sans-serif', googleFamily: 'Space+Grotesk:wght@400;500;600;700' },
  { id: 'ibm-plex-sans', label: 'IBM Plex Sans', stack: '"IBM Plex Sans", Inter, sans-serif', googleFamily: 'IBM+Plex+Sans:wght@400;500;600;700' },
  { id: 'playfair', label: 'Playfair Display', stack: '"Playfair Display", Georgia, serif', googleFamily: 'Playfair+Display:wght@500;600;700;800' },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', stack: '"JetBrains Mono", "SFMono-Regular", monospace', googleFamily: 'JetBrains+Mono:wght@400;500;700' },
  { id: 'source-serif-4', label: 'Source Serif 4', stack: '"Source Serif 4", Georgia, serif', googleFamily: 'Source+Serif+4:wght@400;600;700' },
]

const defaultGradient: BlogGradientConfig = {
  type: 'linear',
  angle: 120,
  from: '#38bdf8',
  to: 'transparent',
  opacity: 100,
}

const defaultThemeConfig: BlogThemeConfig = {
  colors: {
    bg: '#0a0a0f',
    text: '#e5e7eb',
    accent: '#38bdf8',
    heading: '#f8fafc',
    link: '#7dd3fc',
    surface: '#1a1a2e',
    border: '#2a2a3e',
  },
  fonts: {
    body: 'inter',
    heading: 'inter',
  },
  layout: 'wide',
  headerStyle: 'hero',
  customCSS: '',
  gradient: { ...defaultGradient },
}

export const BLOG_THEME_PRESETS: BlogThemePreset[] = [
  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Clean white canvas with subtle accents.',
    config: {
      colors: { bg: '#ffffff', text: '#111827', accent: '#0f172a', heading: '#020617', link: '#1d4ed8', surface: '#f8fafc', border: '#e2e8f0' },
      fonts: { body: 'inter', heading: 'inter' },
      layout: 'narrow',
      headerStyle: 'minimal',
      customCSS: 'line-height: 1.75; letter-spacing: 0.01em;',
      gradient: { type: 'solid', angle: 0, from: '#0f172a', to: 'transparent', opacity: 100 },
    },
  },
  {
    id: 'dark-mode',
    name: 'Dark Mode',
    description: 'High contrast dark reading experience.',
    config: {
      colors: { bg: '#020617', text: '#cbd5e1', accent: '#22d3ee', heading: '#f8fafc', link: '#38bdf8', surface: '#0f172a', border: '#1e293b' },
      fonts: { body: 'ibm-plex-sans', heading: 'space-grotesk' },
      layout: 'wide',
      headerStyle: 'hero',
      customCSS: 'line-height: 1.8;',
      gradient: { type: 'linear', angle: 135, from: '#22d3ee', to: '#0f172a', opacity: 100 },
    },
  },
  {
    id: 'magazine',
    name: 'Magazine',
    description: 'Editorial serif-forward presentation.',
    config: {
      colors: { bg: '#f8fafc', text: '#1f2937', accent: '#b45309', heading: '#111827', link: '#92400e', surface: '#f1f5f9', border: '#cbd5e1' },
      fonts: { body: 'source-serif-4', heading: 'playfair' },
      layout: 'magazine',
      headerStyle: 'banner',
      customCSS: 'line-height: 1.8; text-align: left;',
      gradient: { type: 'linear', angle: 90, from: '#b45309', to: '#f59e0b', opacity: 80 },
    },
  },
  {
    id: 'tech',
    name: 'Tech',
    description: 'Monospace accents and crisp UI feel.',
    config: {
      colors: { bg: '#0b1220', text: '#d1d5db', accent: '#22c55e', heading: '#ecfeff', link: '#14b8a6', surface: '#111827', border: '#1e3a2f' },
      fonts: { body: 'ibm-plex-sans', heading: 'jetbrains-mono' },
      layout: 'wide',
      headerStyle: 'minimal',
      customCSS: 'letter-spacing: 0.01em;',
      gradient: { type: 'linear', angle: 160, from: '#22c55e', to: 'transparent', opacity: 90 },
    },
  },
  {
    id: 'creative',
    name: 'Creative',
    description: 'Bold color energy and expressive type.',
    config: {
      colors: { bg: '#fff7ed', text: '#3f3f46', accent: '#f43f5e', heading: '#9a3412', link: '#db2777', surface: '#fef3c7', border: '#fbbf24' },
      fonts: { body: 'space-grotesk', heading: 'playfair' },
      layout: 'wide',
      headerStyle: 'hero',
      customCSS: 'line-height: 1.7;',
      gradient: { type: 'radial', angle: 0, from: '#f43f5e', to: '#fb923c', opacity: 85 },
    },
  },
  {
    id: 'classic',
    name: 'Classic',
    description: 'Traditional long-form publishing style.',
    config: {
      colors: { bg: '#fefce8', text: '#292524', accent: '#7c2d12', heading: '#1c1917', link: '#9a3412', surface: '#fef9c3', border: '#d6d3d1' },
      fonts: { body: 'merriweather', heading: 'merriweather' },
      layout: 'narrow',
      headerStyle: 'banner',
      customCSS: 'line-height: 1.85; letter-spacing: 0.005em;',
      gradient: { type: 'linear', angle: 100, from: '#7c2d12', to: '#a16207', opacity: 90 },
    },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'Cool blues and greens with airy spacing.',
    config: {
      colors: { bg: '#ecfeff', text: '#0f172a', accent: '#0ea5e9', heading: '#155e75', link: '#0891b2', surface: '#cffafe', border: '#67e8f9' },
      fonts: { body: 'inter', heading: 'space-grotesk' },
      layout: 'wide',
      headerStyle: 'hero',
      customCSS: 'line-height: 1.8;',
      gradient: { type: 'linear', angle: 130, from: '#0ea5e9', to: '#06b6d4', opacity: 100 },
    },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Warm tones for personal essays and stories.',
    config: {
      colors: { bg: '#fff7ed', text: '#431407', accent: '#f97316', heading: '#9a3412', link: '#ea580c', surface: '#fed7aa', border: '#fb923c' },
      fonts: { body: 'lora', heading: 'playfair' },
      layout: 'narrow',
      headerStyle: 'banner',
      customCSS: 'line-height: 1.78;',
      gradient: { type: 'linear', angle: 110, from: '#f97316', to: '#f43f5e', opacity: 95 },
    },
  },
]

const SAFE_CSS_PROPERTIES = new Set([
  'background',
  'background-color',
  'color',
  'border',
  'border-color',
  'border-radius',
  'box-shadow',
  'opacity',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'max-width',
  'width',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-transform',
  'text-decoration',
])

export const FORBIDDEN_CSS_PATTERN = /(?:url\s*\(|expression\s*\(|@import|javascript\s*:|vbscript\s*:|data\s*:|behavior\s*:|binding\s*:)/i

const SAFE_CSS_COLOR = /^(#[0-9a-fA-F]{3,8}|transparent|[a-zA-Z]{3,20})$/

function normalizeColor(input: unknown, fallback: string): string {
  if (typeof input !== 'string') return fallback
  const value = input.trim()
  if (!value) return fallback
  if (!SAFE_CSS_COLOR.test(value)) return fallback
  return value
}

function normalizeFontId(input: unknown, fallback: string): string {
  if (typeof input !== 'string') return fallback
  const match = BLOG_FONT_OPTIONS.find((font) => font.id === input)
  return match ? match.id : fallback
}

function normalizeLayout(input: unknown, fallback: BlogLayoutMode): BlogLayoutMode {
  return input === 'wide' || input === 'narrow' || input === 'magazine' ? input : fallback
}

function normalizeHeaderStyle(input: unknown, fallback: BlogHeaderStyle): BlogHeaderStyle {
  return input === 'hero' || input === 'minimal' || input === 'banner' ? input : fallback
}

function normalizeGradientType(input: unknown): BlogGradientType {
  return input === 'solid' || input === 'linear' || input === 'radial' ? input : defaultGradient.type
}

function normalizeGradient(input: unknown): BlogGradientConfig {
  if (!input || typeof input !== 'object') return { ...defaultGradient }
  const g = input as Partial<BlogGradientConfig>
  return {
    type: normalizeGradientType(g.type),
    angle: typeof g.angle === 'number' ? Math.max(0, Math.min(360, g.angle)) : defaultGradient.angle,
    from: normalizeColor(g.from, defaultGradient.from),
    to: normalizeColor(g.to, defaultGradient.to),
    opacity: typeof g.opacity === 'number' ? Math.max(0, Math.min(100, g.opacity)) : defaultGradient.opacity,
  }
}

export function sanitizeCustomCSS(css: string | undefined | null): string {
  if (!css || typeof css !== 'string') return ''

  const stripped = css
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/[{}<>]/g, ' ')
    .trim()

  if (!stripped) return ''

  const declarations: string[] = []

  for (const raw of stripped.split(';')) {
    const declaration = raw.trim()
    if (!declaration) continue

    const separatorIndex = declaration.indexOf(':')
    if (separatorIndex <= 0) continue

    const property = declaration.slice(0, separatorIndex).trim().toLowerCase()
    const value = declaration.slice(separatorIndex + 1).trim()

    if (!property || !value) continue
    if (!SAFE_CSS_PROPERTIES.has(property)) continue
    if (FORBIDDEN_CSS_PATTERN.test(value)) continue

    declarations.push(`${property}: ${value}`)
  }

  return declarations.join('; ')
}

export function getBlogFontOption(fontId: string | undefined): BlogFontOption {
  return BLOG_FONT_OPTIONS.find((font) => font.id === fontId) || BLOG_FONT_OPTIONS[0]
}

export function getDefaultBlogThemeConfig(): BlogThemeConfig {
  return {
    colors: { ...defaultThemeConfig.colors },
    fonts: { ...defaultThemeConfig.fonts },
    layout: defaultThemeConfig.layout,
    headerStyle: defaultThemeConfig.headerStyle,
    customCSS: defaultThemeConfig.customCSS,
    gradient: { ...defaultGradient },
  }
}

export function getDefaultGradient(): BlogGradientConfig {
  return { ...defaultGradient }
}

export function normalizeBlogThemeConfig(value: Partial<BlogThemeConfig> | undefined): BlogThemeConfig {
  const defaults = getDefaultBlogThemeConfig()
  const colors = value?.colors || ({} as Partial<BlogThemeColors>)
  const fonts = value?.fonts || ({} as Partial<BlogThemeFonts>)

  return {
    colors: {
      bg: normalizeColor(colors.bg, defaults.colors.bg),
      text: normalizeColor(colors.text, defaults.colors.text),
      accent: normalizeColor(colors.accent, defaults.colors.accent),
      heading: normalizeColor(colors.heading, defaults.colors.heading),
      link: normalizeColor(colors.link, defaults.colors.link),
      surface: normalizeColor(colors.surface, defaults.colors.surface),
      border: normalizeColor(colors.border, defaults.colors.border),
    },
    fonts: {
      body: normalizeFontId(fonts.body, defaults.fonts.body),
      heading: normalizeFontId(fonts.heading, defaults.fonts.heading),
    },
    layout: normalizeLayout(value?.layout, defaults.layout),
    headerStyle: normalizeHeaderStyle(value?.headerStyle, defaults.headerStyle),
    customCSS: sanitizeCustomCSS(value?.customCSS),
    gradient: normalizeGradient(value?.gradient),
  }
}

function safeCSSColor(value: string, fallback: string): string {
  return SAFE_CSS_COLOR.test(value) ? value : fallback
}

export function buildGradientCSS(gradient: BlogGradientConfig): string {
  const from = safeCSSColor(gradient.from, '#38bdf8')
  const to = safeCSSColor(gradient.to, 'transparent')
  const angle = Math.max(0, Math.min(360, Math.round(gradient.angle)))
  const opacity = Math.max(0, Math.min(100, Math.round(gradient.opacity)))

  const fromColor = opacity < 100
    ? `color-mix(in srgb, ${from} ${opacity}%, transparent)`
    : from

  if (gradient.type === 'solid') {
    return fromColor
  }

  if (gradient.type === 'radial') {
    return `radial-gradient(circle, ${fromColor}, ${to})`
  }

  return `linear-gradient(${angle}deg, ${fromColor}, ${to})`
}
