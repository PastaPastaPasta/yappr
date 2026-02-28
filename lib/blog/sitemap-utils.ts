import type { Blog, BlogPost } from '@/lib/types'
import { escapeXml } from '@/lib/blog/content-utils'

export function generateBlogSitemap(
  posts: BlogPost[],
  blog: Blog,
  username: string,
  baseUrl: string
): string {
  const normalizedBase = baseUrl.replace(/\/$/, '')
  const blogUrl = `${normalizedBase}/blog?user=${encodeURIComponent(username)}&blog=${encodeURIComponent(blog.id)}`
  const latestPostDate = posts.length > 0
    ? new Date(Math.max(...posts.map((p) => (p.updatedAt || p.createdAt).getTime()))).toISOString()
    : new Date().toISOString()

  const urls = [
    {
      loc: blogUrl,
      lastmod: latestPostDate,
      changefreq: 'daily',
      priority: '0.8',
    },
    ...posts.map((post) => ({
      loc: `${blogUrl}&post=${encodeURIComponent(post.slug)}`,
      lastmod: (post.updatedAt || post.createdAt).toISOString(),
      changefreq: 'weekly',
      priority: '0.7',
    })),
  ]

  const entries = urls
    .map(
      (entry) =>
        `<url><loc>${escapeXml(entry.loc)}</loc><lastmod>${escapeXml(entry.lastmod)}</lastmod><changefreq>${entry.changefreq}</changefreq><priority>${entry.priority}</priority></url>`
    )
    .join('')

  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`
}
