'use client'

import { type CSSProperties, type ReactNode, useEffect, useMemo } from 'react'
import { IpfsImage } from '@/components/ui/ipfs-image'
import { cn } from '@/lib/utils'
import {
  getBlogFontOption,
  parseBlogThemeConfig,
  sanitizeCustomCSS,
  type BlogThemeConfig,
} from '@/lib/blog/theme-types'

interface BlogThemeProviderProps {
  themeConfig?: string
  blogName: string
  blogDescription?: string
  username?: string
  headerImage?: string
  labels?: string
  title?: string
  subtitle?: string
  meta?: ReactNode
  children: ReactNode
}

function getLayoutClass(layout: BlogThemeConfig['layout']): string {
  if (layout === 'narrow') return 'mx-auto max-w-2xl'
  if (layout === 'magazine') return 'mx-auto max-w-6xl'
  return 'mx-auto max-w-6xl'
}

function getContainerStyle(theme: BlogThemeConfig): CSSProperties {
  const headingFont = getBlogFontOption(theme.fonts.heading)
  const bodyFont = getBlogFontOption(theme.fonts.body)

  return {
    '--blog-bg': theme.colors.bg,
    '--blog-text': theme.colors.text,
    '--blog-accent': theme.colors.accent,
    '--blog-heading': theme.colors.heading,
    '--blog-link': theme.colors.link,
    '--blog-heading-font': headingFont.stack,
    '--blog-body-font': bodyFont.stack,
    backgroundColor: 'var(--blog-bg)',
    color: 'var(--blog-text)',
  } as CSSProperties
}

function ThemeHeader({
  headerStyle,
  blogName,
  blogDescription,
  username,
  headerImage,
  title,
  subtitle,
  meta,
}: {
  headerStyle: BlogThemeConfig['headerStyle']
  blogName: string
  blogDescription?: string
  username?: string
  headerImage?: string
  title?: string
  subtitle?: string
  meta?: ReactNode
}) {
  const headline = title || blogName
  const subline = subtitle || blogDescription

  if (headerStyle === 'minimal') {
    return (
      <header className="mb-4 rounded-xl border border-white/10 bg-black/20 p-4">
        <p className="text-xs uppercase tracking-wider text-[var(--blog-accent)]">{username ? `@${username}` : 'Blog'}</p>
        <h1 className="mt-1 text-3xl font-semibold leading-tight text-[var(--blog-heading)]" style={{ fontFamily: 'var(--blog-heading-font)' }}>
          {headline}
        </h1>
        {subline && <p className="mt-2 text-sm text-[var(--blog-text)]/80">{subline}</p>}
        {meta && <div className="mt-3 text-sm text-[var(--blog-text)]/75">{meta}</div>}
      </header>
    )
  }

  if (headerStyle === 'banner') {
    return (
      <header className="mb-4 overflow-hidden rounded-xl border border-white/10">
        <div className="bg-[linear-gradient(120deg,var(--blog-accent),transparent)] p-4">
          <p className="text-xs uppercase tracking-wider text-[var(--blog-heading)]/85">{username ? `@${username}` : 'Blog'}</p>
          <h1 className="mt-1 text-2xl font-semibold text-[var(--blog-heading)]" style={{ fontFamily: 'var(--blog-heading-font)' }}>
            {headline}
          </h1>
          {subline && <p className="mt-1 text-sm text-[var(--blog-text)]/90">{subline}</p>}
        </div>
        {meta && <div className="border-t border-white/10 bg-black/20 px-4 py-2 text-sm text-[var(--blog-text)]/80">{meta}</div>}
      </header>
    )
  }

  return (
    <header className="mb-5 overflow-hidden rounded-2xl border border-white/10">
      {headerImage ? (
        <IpfsImage src={headerImage} alt={`${blogName} header`} className="h-56 w-full object-cover" />
      ) : (
        <div className="h-56 w-full bg-[linear-gradient(130deg,var(--blog-accent),transparent_70%)]" />
      )}
      <div className="bg-black/25 p-5">
        <p className="text-xs uppercase tracking-wider text-[var(--blog-accent)]">{username ? `@${username}` : 'Blog'}</p>
        <h1 className="mt-1 text-3xl font-semibold text-[var(--blog-heading)]" style={{ fontFamily: 'var(--blog-heading-font)' }}>
          {headline}
        </h1>
        {subline && <p className="mt-2 max-w-3xl text-sm text-[var(--blog-text)]/85">{subline}</p>}
        {meta && <div className="mt-3 text-sm text-[var(--blog-text)]/75">{meta}</div>}
      </div>
    </header>
  )
}

export function BlogThemeProvider({
  themeConfig,
  blogName,
  blogDescription,
  username,
  headerImage,
  labels,
  title,
  subtitle,
  meta,
  children,
}: BlogThemeProviderProps) {
  const theme = useMemo(() => parseBlogThemeConfig(themeConfig), [themeConfig])
  const headingFont = useMemo(() => getBlogFontOption(theme.fonts.heading), [theme.fonts.heading])
  const bodyFont = useMemo(() => getBlogFontOption(theme.fonts.body), [theme.fonts.body])
  const sanitizedCustomCSS = useMemo(() => sanitizeCustomCSS(theme.customCSS), [theme.customCSS])
  const customScopeClass = useMemo(() => `blog-theme-scope-${Math.random().toString(36).slice(2, 10)}`, [])

  useEffect(() => {
    const families = Array.from(new Set([headingFont.googleFamily, bodyFont.googleFamily]))
    if (families.length === 0) return

    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.id = `blog-theme-fonts-${families.join('-')}`
    link.href = `https://fonts.googleapis.com/css2?${families.map((family) => `family=${family}`).join('&')}&display=swap`

    const existing = document.getElementById(link.id)
    if (!existing) {
      document.head.appendChild(link)
    }

    return () => {
      if (!existing && link.parentNode) {
        link.parentNode.removeChild(link)
      }
    }
  }, [bodyFont.googleFamily, headingFont.googleFamily])

  return (
    <section
      className={cn(
        customScopeClass,
        'rounded-2xl border border-white/10 p-4 shadow-[0_1px_0_rgba(255,255,255,0.05)_inset] md:p-6'
      )}
      style={getContainerStyle(theme)}
    >
      {sanitizedCustomCSS && (
        <style>{`.${customScopeClass} .blog-theme-prose { ${sanitizedCustomCSS} }`}</style>
      )}

      <div className={cn(getLayoutClass(theme.layout), 'blog-theme-root')} style={{ fontFamily: 'var(--blog-body-font)' }}>
        <ThemeHeader
          headerStyle={theme.headerStyle}
          blogName={blogName}
          blogDescription={blogDescription}
          username={username}
          headerImage={headerImage}
          title={title}
          subtitle={subtitle}
          meta={meta}
        />

        {theme.layout === 'magazine' ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="blog-theme-prose min-w-0">{children}</div>
            <aside className="h-fit rounded-xl border border-white/10 bg-black/20 p-4 text-sm text-[var(--blog-text)]/85">
              <h3 className="text-base font-semibold text-[var(--blog-heading)]" style={{ fontFamily: 'var(--blog-heading-font)' }}>
                About this blog
              </h3>
              {blogDescription && <p className="mt-2">{blogDescription}</p>}
              {labels && (
                <div className="mt-3">
                  <p className="text-xs uppercase tracking-wider text-[var(--blog-accent)]">Topics</p>
                  <p className="mt-1">{labels}</p>
                </div>
              )}
            </aside>
          </div>
        ) : (
          <div className="blog-theme-prose">{children}</div>
        )}
      </div>
    </section>
  )
}
