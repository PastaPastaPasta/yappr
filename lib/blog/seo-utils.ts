import type { Blog, BlogPost } from '@/lib/types'

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((item) => extractText(item)).filter(Boolean).join(' ')
  }
  if (content && typeof content === 'object') {
    return Object.values(content as Record<string, unknown>)
      .map((value) => extractText(value))
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 3)).trim()}...`
}

function resolveBaseUrl(): string {
  if (typeof window !== 'undefined') {
    return window.location?.origin || 'https://yappr.com'
  }
  return 'https://yappr.com'
}

interface BlogPostMeta {
  title: string
  description: string
  openGraph: {
    'og:title': string
    'og:description': string
    'og:image': string
    'og:type': 'article'
    'og:url': string
  }
  twitter: {
    'twitter:card': 'summary_large_image'
    'twitter:title': string
    'twitter:description': string
    'twitter:image': string
  }
}

export function generateBlogPostMeta(post: BlogPost, blog: Blog, username: string): BlogPostMeta {
  const baseUrl = resolveBaseUrl()
  const title = `${post.title} | ${blog.name}`
  const descriptionSource = post.subtitle?.trim() || extractText(post.content).trim()
  const description = truncate(descriptionSource || `${blog.name} by @${username}`, 160)
  const image = post.coverImage || blog.headerImage || blog.avatar || `${baseUrl}/og-default.png`
  const url = `${baseUrl}/blog?user=${encodeURIComponent(username)}&post=${encodeURIComponent(post.slug)}`

  return {
    title,
    description,
    openGraph: {
      'og:title': title,
      'og:description': description,
      'og:image': image,
      'og:type': 'article',
      'og:url': url,
    },
    twitter: {
      'twitter:card': 'summary_large_image',
      'twitter:title': title,
      'twitter:description': description,
      'twitter:image': image,
    },
  }
}

export function generateArticleJsonLd(post: BlogPost, blog: Blog, username: string): Record<string, unknown> {
  const baseUrl = resolveBaseUrl()
  const description = post.subtitle?.trim() || truncate(extractText(post.content).trim(), 160)
  const url = `${baseUrl}/blog?user=${encodeURIComponent(username)}&post=${encodeURIComponent(post.slug)}`
  const image = post.coverImage || blog.headerImage || blog.avatar

  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description,
    datePublished: post.createdAt.toISOString(),
    dateModified: (post.updatedAt || post.createdAt).toISOString(),
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': url,
    },
    author: {
      '@type': 'Person',
      name: `@${username}`,
    },
    publisher: {
      '@type': 'Organization',
      name: blog.name,
    },
    image: image ? [image] : undefined,
  }
}
