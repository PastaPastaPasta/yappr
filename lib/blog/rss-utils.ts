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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 3)).trim()}...`
}

export function generateBlogRSS(posts: BlogPost[], blog: Blog, username: string, baseUrl: string): string {
  const normalizedBase = baseUrl.replace(/\/$/, '')
  const blogUrl = `${normalizedBase}/blog?user=${encodeURIComponent(username)}`

  const items = posts
    .map((post) => {
      const link = `${blogUrl}&post=${encodeURIComponent(post.slug)}`
      const description = truncate(post.subtitle?.trim() || extractText(post.content), 280)
      return `\n<item>\n<title>${escapeXml(post.title)}</title>\n<link>${escapeXml(link)}</link>\n<description>${escapeXml(description)}</description>\n<pubDate>${(post.updatedAt || post.createdAt).toUTCString()}</pubDate>\n<guid>${escapeXml(link)}</guid>\n</item>`
    })
    .join('')

  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n<channel>\n<title>${escapeXml(blog.name)}</title>\n<link>${escapeXml(blogUrl)}</link>\n<description>${escapeXml(blog.description || `${blog.name} on Yappr`)}</description>\n<pubDate>${new Date().toUTCString()}</pubDate>${items}\n</channel>\n</rss>`
}

export function generateBlogAtom(posts: BlogPost[], blog: Blog, username: string, baseUrl: string): string {
  const normalizedBase = baseUrl.replace(/\/$/, '')
  const blogUrl = `${normalizedBase}/blog?user=${encodeURIComponent(username)}`
  const updatedAt = posts.length > 0
    ? new Date(Math.max(...posts.map((post) => (post.updatedAt || post.createdAt).getTime()))).toISOString()
    : new Date().toISOString()

  const entries = posts
    .map((post) => {
      const link = `${blogUrl}&post=${encodeURIComponent(post.slug)}`
      const summary = truncate(post.subtitle?.trim() || extractText(post.content), 280)
      return `\n<entry>\n<title>${escapeXml(post.title)}</title>\n<link href="${escapeXml(link)}" />\n<id>${escapeXml(link)}</id>\n<updated>${(post.updatedAt || post.createdAt).toISOString()}</updated>\n<summary>${escapeXml(summary)}</summary>\n</entry>`
    })
    .join('')

  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n<title>${escapeXml(blog.name)}</title>\n<link href="${escapeXml(blogUrl)}" />\n<updated>${updatedAt}</updated>\n<id>${escapeXml(blogUrl)}</id>${entries}\n</feed>`
}
