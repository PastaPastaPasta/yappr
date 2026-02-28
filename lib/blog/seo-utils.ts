import type { Blog, BlogPost } from '@/lib/types'
import { extractText, truncate } from '@/lib/blog/content-utils'

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
