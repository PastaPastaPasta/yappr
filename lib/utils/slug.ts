const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function generateSlug(title: string): string {
  const normalized = title
    .normalize('NFD')                    // decompose accented chars
    .replace(/[\u0300-\u036f]/g, '')     // strip combining marks
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')

  const truncated = normalized.slice(0, 63).replace(/-+$/g, '')
  // If nothing remains (e.g. CJK/emoji-only), use a timestamp-based slug
  return truncated || `post-${Date.now().toString(36)}`
}

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 63 && SLUG_REGEX.test(slug)
}
