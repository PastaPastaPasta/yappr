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
  type BlogThemeConfig,
  type BlogThemeColors,
} from '@/lib/blog/theme-types'
import { BlogThemeProvider } from './theme-provider'

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
    <section className="space-y-4 rounded-xl border border-gray-800 bg-neutral-950 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold">Theme Customizer</h3>
          <p className="text-xs text-gray-400">Style your blog layout, fonts, colors, and custom CSS.</p>
        </div>
        <Button variant="outline" onClick={handleReset}>Reset defaults</Button>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium text-gray-200">Presets</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {BLOG_THEME_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => handlePresetApply(preset.id)}
              className="rounded-lg border border-gray-700 bg-gray-900/70 p-3 text-left transition hover:border-gray-500"
            >
              <div className="mb-2 flex items-center gap-1">
                <span className="h-4 w-4 rounded-full" style={{ backgroundColor: preset.config.colors.bg }} />
                <span className="h-4 w-4 rounded-full" style={{ backgroundColor: preset.config.colors.accent }} />
                <span className="h-4 w-4 rounded-full" style={{ backgroundColor: preset.config.colors.heading }} />
              </div>
              <p className="text-sm font-medium text-gray-100">{preset.name}</p>
              <p className="mt-1 text-xs text-gray-400">{preset.description}</p>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium text-gray-200">Colors</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {colorFields.map((field) => (
                <label key={field.key} className="rounded-lg border border-gray-800 bg-black/30 p-3">
                  <span className="mb-2 block text-xs text-gray-300">{field.label}</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={theme.colors[field.key]}
                      onChange={(event) => updateColor(field.key, event.target.value)}
                      className="h-8 w-10 cursor-pointer rounded border border-gray-700 bg-transparent"
                    />
                    <input
                      type="text"
                      value={theme.colors[field.key]}
                      onChange={(event) => updateColor(field.key, event.target.value)}
                      className="h-8 flex-1 rounded border border-gray-700 bg-gray-900 px-2 text-xs text-gray-100 outline-none focus:border-yappr-400"
                    />
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="rounded-lg border border-gray-800 bg-black/30 p-3">
              <span className="mb-2 block text-xs text-gray-300">Body font</span>
              <select
                value={theme.fonts.body}
                onChange={(event) => updateTheme({ fonts: { ...theme.fonts, body: event.target.value } })}
                className="h-9 w-full rounded border border-gray-700 bg-gray-900 px-2 text-sm text-gray-100 outline-none focus:border-yappr-400"
              >
                {BLOG_FONT_OPTIONS.map((font) => (
                  <option key={font.id} value={font.id}>{font.label}</option>
                ))}
              </select>
            </label>

            <label className="rounded-lg border border-gray-800 bg-black/30 p-3">
              <span className="mb-2 block text-xs text-gray-300">Heading font</span>
              <select
                value={theme.fonts.heading}
                onChange={(event) => updateTheme({ fonts: { ...theme.fonts, heading: event.target.value } })}
                className="h-9 w-full rounded border border-gray-700 bg-gray-900 px-2 text-sm text-gray-100 outline-none focus:border-yappr-400"
              >
                {BLOG_FONT_OPTIONS.map((font) => (
                  <option key={font.id} value={font.id}>{font.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <fieldset className="rounded-lg border border-gray-800 bg-black/30 p-3">
              <legend className="px-1 text-xs text-gray-300">Layout</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {(['wide', 'narrow', 'magazine'] as const).map((layout) => (
                  <label key={layout} className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-gray-700 px-2 py-1 text-xs text-gray-200">
                    <input
                      type="radio"
                      name="layout"
                      value={layout}
                      checked={theme.layout === layout}
                      onChange={() => updateTheme({ layout })}
                    />
                    {layout}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="rounded-lg border border-gray-800 bg-black/30 p-3">
              <legend className="px-1 text-xs text-gray-300">Header style</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {(['hero', 'minimal', 'banner'] as const).map((headerStyle) => (
                  <label key={headerStyle} className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-gray-700 px-2 py-1 text-xs text-gray-200">
                    <input
                      type="radio"
                      name="headerStyle"
                      value={headerStyle}
                      checked={theme.headerStyle === headerStyle}
                      onChange={() => updateTheme({ headerStyle })}
                    />
                    {headerStyle}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-gray-200">Custom CSS</label>
            <Textarea
              value={theme.customCSS}
              onChange={(event) => {
                const value = event.target.value.slice(0, BLOG_THEME_CUSTOM_CSS_MAX_CHARS)
                updateTheme({ customCSS: value })
              }}
              rows={4}
              placeholder="line-height: 1.8; letter-spacing: 0.01em;"
              className="font-mono text-xs"
            />
            <p className="mt-1 text-right text-xs text-gray-400">{cssChars}/{BLOG_THEME_CUSTOM_CSS_MAX_CHARS}</p>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-gray-200">Live preview</p>
          <BlogThemeProvider
            themeConfig={previewThemeConfig}
            blogName={blogName}
            blogDescription={blogDescription}
            username="preview"
            title="Preview post title"
            subtitle="This subtitle demonstrates typography and spacing."
            labels="design, notes"
            meta={<span>Feb 28, 2026 • 5 min read</span>}
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

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving}>{isSaving ? 'Saving...' : 'Save theme'}</Button>
      </div>
    </section>
  )
}
