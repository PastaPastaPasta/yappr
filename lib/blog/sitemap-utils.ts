import type { Blog, BlogPost } from '@/lib/types'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

export function generateBlogSitemap(
  posts: BlogPost[],
  _blog: Blog,
  username: string,
  baseUrl: string
): string {
  const normalizedBase = baseUrl.replace(/\/$/, '')
  const blogUrl = `${normalizedBase}/blog?user=${encodeURIComponent(username)}`

  const urls = [
    {
      loc: blogUrl,
      lastmod: new Date().toISOString(),
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
