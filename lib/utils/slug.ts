const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function generateSlug(title: string): string {
  const normalized = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')

  const truncated = normalized.slice(0, 128).replace(/-+$/g, '')
  return truncated || 'post'
}

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 128 && SLUG_REGEX.test(slug)
}
