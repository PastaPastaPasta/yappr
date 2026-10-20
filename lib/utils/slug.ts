const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The address a title gives a post, or '' when nothing of it survives (CJK/emoji-only titles). */
export function titleSlug(title: string): string {
  const normalized = title
    .normalize('NFD')                    // decompose accented chars
    .replace(/[\u0300-\u036f]/g, '')     // strip combining marks
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized.slice(0, 63).replace(/-+$/g, '')
}

export function generateSlug(title: string): string {
  // If nothing remains (e.g. CJK/emoji-only), use a timestamp-based slug
  return titleSlug(title) || `post-${Date.now().toString(36)}`
}

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 63 && SLUG_REGEX.test(slug)
}
