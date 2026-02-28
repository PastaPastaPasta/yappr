'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  BLOG_FONT_OPTIONS,
  BLOG_THEME_CUSTOM_CSS_MAX_CHARS,
  BLOG_THEME_PRESETS,
  getDefaultBlogThemeConfig,
  normalizeBlogThemeConfig,
  parseBlogThemeConfig,
  stringifyBlogThemeConfig,
  type BlogHeaderStyle,
  type BlogLayoutMode,
  type BlogThemeConfig,
  type BlogThemeColors,
} from '@/lib/blog/theme-types'
import { BlogThemeProvider } from './theme-provider'
import { cn } from '@/lib/utils'

interface ThemeEditorProps {
  initialThemeConfig?: string
  blogName: string
  blogDescription?: string
  onSave: (themeConfig: string) => Promise<void> | void
}

const colorFields: Array<{ key: keyof BlogThemeColors; label: string }> = [
  { key: 'bg', label: 'Background' },
  { key: 'text', label: 'Text' },
  { key: 'accent', label: 'Accent' },
  { key: 'heading', label: 'Heading' },
  { key: 'link', label: 'Link' },
]

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="flex rounded-lg bg-white/[0.04] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'flex-1 rounded-md px-2 py-1.5 text-xs font-medium capitalize transition-all',
            value === option.value
              ? 'bg-white/[0.1] text-gray-100 shadow-sm'
              : 'text-gray-500 hover:text-gray-300'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function ThemeEditor({ initialThemeConfig, blogName, blogDescription, onSave }: ThemeEditorProps) {
  const [theme, setTheme] = useState<BlogThemeConfig>(() => parseBlogThemeConfig(initialThemeConfig))
  const [isSaving, setIsSaving] = useState(false)

  const previewThemeConfig = useMemo(() => stringifyBlogThemeConfig(theme), [theme])
  const cssChars = theme.customCSS.length

  const updateColor = (field: keyof BlogThemeColors, value: string) => {
    setTheme((current) => ({
      ...current,
      colors: {
        ...current.colors,
        [field]: value,
      },
    }))
  }

  const updateTheme = (partial: Partial<BlogThemeConfig>) => {
    setTheme((current) => normalizeBlogThemeConfig({ ...current, ...partial }))
  }

  const handlePresetApply = (presetId: string) => {
    const preset = BLOG_THEME_PRESETS.find((item) => item.id === presetId)
    if (!preset) return
    setTheme(normalizeBlogThemeConfig(preset.config))
  }

  const handleReset = () => {
    setTheme(getDefaultBlogThemeConfig())
  }

  const handleSave = async () => {
    const serialized = stringifyBlogThemeConfig(theme)
    setIsSaving(true)
    try {
      await onSave(serialized)
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex flex-col xl:flex-row gap-6">
      {/* Controls Panel */}
      <div className="xl:w-[380px] shrink-0 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-200">Customize Theme</h3>
          <button
            type="button"
            onClick={handleReset}
            className="text-[11px] text-gray-500 hover:text-gray-300 transition-colors"
          >
            Reset defaults
          </button>
        </div>

        {/* Presets */}
        <section>
          <h4 className="mb-2.5 text-[11px] font-semibold uppercase tracking-widest text-gray-500">Presets</h4>
          <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide -mx-1 px-1">
            {BLOG_THEME_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => handlePresetApply(preset.id)}
                className="group shrink-0 w-[120px] rounded-xl border border-white/[0.06] bg-white/[0.02] p-2.5 text-left transition-all hover:border-white/[0.15] hover:bg-white/[0.05]"
              >
                <div className="mb-2 flex h-5 overflow-hidden rounded-md ring-1 ring-white/[0.08]">
                  <div className="flex-1" style={{ backgroundColor: preset.config.colors.bg }} />
                  <div className="flex-1" style={{ backgroundColor: preset.config.colors.accent }} />
                  <div className="flex-1" style={{ backgroundColor: preset.config.colors.heading }} />
                </div>
                <p className="text-[11px] font-medium text-gray-300 group-hover:text-gray-100 transition-colors">{preset.name}</p>
                <p className="mt-0.5 text-[10px] leading-snug text-gray-600 line-clamp-2">{preset.description}</p>
              </button>
            ))}
          </div>
        </section>

        {/* Colors */}
        <section>
          <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-widest text-gray-500">Colors</h4>
          <div className="flex items-start justify-between">
            {colorFields.map((field) => (
              <label key={field.key} className="group flex flex-col items-center gap-1.5">
                <div className="relative">
                  <input
                    type="color"
                    value={theme.colors[field.key]}
                    onChange={(event) => updateColor(field.key, event.target.value)}
                    className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  />
                  <div
                    className="h-9 w-9 rounded-full border-2 border-white/10 shadow-lg transition-all group-hover:scale-110 group-hover:border-white/25"
                    style={{ backgroundColor: theme.colors[field.key] }}
                  />
                </div>
                <span className="text-[10px] text-gray-500">{field.label}</span>
                <input
                  type="text"
                  value={theme.colors[field.key]}
                  onChange={(event) => updateColor(field.key, event.target.value)}
                  className="w-[58px] rounded bg-transparent text-center text-[10px] text-gray-500 outline-none transition-colors focus:text-gray-200"
                />
              </label>
            ))}
          </div>
        </section>

        {/* Typography */}
        <section>
          <h4 className="mb-2.5 text-[11px] font-semibold uppercase tracking-widest text-gray-500">Typography</h4>
          <div className="grid grid-cols-2 gap-3">
            <label>
              <span className="mb-1 block text-[11px] text-gray-500">Body font</span>
              <select
                value={theme.fonts.body}
                onChange={(event) => updateTheme({ fonts: { ...theme.fonts, body: event.target.value } })}
                className="h-9 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 text-xs text-gray-200 outline-none transition-colors hover:border-white/[0.12] focus:border-white/[0.2]"
              >
                {BLOG_FONT_OPTIONS.map((font) => (
                  <option key={font.id} value={font.id}>{font.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="mb-1 block text-[11px] text-gray-500">Heading font</span>
              <select
                value={theme.fonts.heading}
                onChange={(event) => updateTheme({ fonts: { ...theme.fonts, heading: event.target.value } })}
                className="h-9 w-full rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 text-xs text-gray-200 outline-none transition-colors hover:border-white/[0.12] focus:border-white/[0.2]"
              >
                {BLOG_FONT_OPTIONS.map((font) => (
                  <option key={font.id} value={font.id}>{font.label}</option>
                ))}
              </select>
            </label>
          </div>
        </section>

        {/* Layout & Header Style */}
        <section className="space-y-3">
          <div>
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-gray-500">Layout</h4>
            <SegmentedControl<BlogLayoutMode>
              options={[
                { value: 'wide', label: 'Wide' },
                { value: 'narrow', label: 'Narrow' },
                { value: 'magazine', label: 'Magazine' },
              ]}
              value={theme.layout}
              onChange={(layout) => updateTheme({ layout })}
            />
          </div>
          <div>
            <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-gray-500">Header Style</h4>
            <SegmentedControl<BlogHeaderStyle>
              options={[
                { value: 'hero', label: 'Hero' },
                { value: 'minimal', label: 'Minimal' },
                { value: 'banner', label: 'Banner' },
              ]}
              value={theme.headerStyle}
              onChange={(headerStyle) => updateTheme({ headerStyle })}
            />
          </div>
        </section>

        {/* Custom CSS */}
        <section>
          <details className="group">
            <summary className="flex list-none cursor-pointer items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-gray-500 select-none transition-colors hover:text-gray-300 [&::-webkit-details-marker]:hidden">
              <svg className="h-3 w-3 transition-transform group-open:rotate-90" viewBox="0 0 12 12" fill="none">
                <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Custom CSS
              {cssChars > 0 && <span className="text-gray-600">{cssChars}</span>}
            </summary>
            <div className="mt-2">
              <Textarea
                value={theme.customCSS}
                onChange={(event) => {
                  const value = event.target.value.slice(0, BLOG_THEME_CUSTOM_CSS_MAX_CHARS)
                  updateTheme({ customCSS: value })
                }}
                rows={3}
                placeholder="line-height: 1.8; letter-spacing: 0.01em;"
                className="font-mono text-xs"
              />
              <p className="mt-1 text-right text-[10px] text-gray-600">{cssChars}/{BLOG_THEME_CUSTOM_CSS_MAX_CHARS}</p>
            </div>
          </details>
        </section>

        {/* Save */}
        <Button onClick={handleSave} disabled={isSaving} className="w-full">
          {isSaving ? 'Saving...' : 'Save theme'}
        </Button>
      </div>

      {/* Live Preview */}
      <div className="flex-1 min-w-0">
        <div className="xl:sticky xl:top-20">
          <h4 className="mb-2.5 text-[11px] font-semibold uppercase tracking-widest text-gray-500">Live Preview</h4>
          <div className="overflow-hidden rounded-xl ring-1 ring-white/[0.06] shadow-2xl shadow-black/30">
            {/* Mock browser chrome */}
            <div className="flex items-center gap-1.5 border-b border-white/[0.06] bg-white/[0.03] px-3 py-2">
              <div className="h-2 w-2 rounded-full bg-white/[0.15]" />
              <div className="h-2 w-2 rounded-full bg-white/[0.15]" />
              <div className="h-2 w-2 rounded-full bg-white/[0.15]" />
              <div className="ml-2 flex h-5 flex-1 items-center rounded-md bg-white/[0.04] px-2 text-[10px] text-gray-600">
                yappr.social/blog/preview
              </div>
            </div>
            {/* Preview content */}
            <div className={cn(
              "theme-editor-preview max-h-[calc(100vh-220px)] overflow-y-auto transition-all duration-300",
              theme.layout === 'narrow' && 'px-[12%]',
            )}>
              {theme.layout === 'magazine' && (
                <style>{`.theme-editor-preview .blog-theme-root > .grid { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }`}</style>
              )}
              <BlogThemeProvider
                themeConfig={previewThemeConfig}
                blogName={blogName}
                blogDescription={blogDescription}
                username="preview"
                title="Preview post title"
                subtitle="This subtitle demonstrates typography and spacing."
                labels="design, notes"
                meta={<span>Feb 28, 2026 &middot; 5 min read</span>}
              >
                <article className="space-y-3 rounded-xl border border-white/10 bg-black/20 p-4">
                  <h2 className="text-2xl font-semibold" style={{ color: 'var(--blog-heading)', fontFamily: 'var(--blog-heading-font)' }}>
                    Themed paragraph and link styles
                  </h2>
                  <p>
                    Theme preview text helps validate readability across palette choices.{' '}
                    <a href="#" style={{ color: 'var(--blog-link)' }}>This is a sample link</a>.
                  </p>
                  <div className="rounded-lg border border-white/10 p-3" style={{ backgroundColor: 'color-mix(in srgb, var(--blog-accent) 15%, transparent)' }}>
                    Accent panel with border for contrast checks.
                  </div>
                </article>
              </BlogThemeProvider>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
