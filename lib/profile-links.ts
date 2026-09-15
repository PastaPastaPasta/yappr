/** Turn a social-link handle into an href, or null when it cannot be linked safely. */
export function getSocialLinkUrl(platform: string, handle: string): string | null {
  const trimmedHandle = handle.trim()
  if (!trimmedHandle) return null

  const cleanHandle = encodeURIComponent(trimmedHandle.replace(/^@/, ''))

  switch (platform) {
    case 'twitter':
      return `https://x.com/${cleanHandle}`
    case 'github':
      return `https://github.com/${cleanHandle}`
    case 'telegram':
      return `https://t.me/${cleanHandle}`
    case 'youtube':
      if (!cleanHandle) return null
      return `https://www.youtube.com/@${cleanHandle}`
    case 'twitch':
      return `https://twitch.tv/${cleanHandle}`
    case 'instagram':
      return `https://instagram.com/${cleanHandle}`
    case 'linkedin':
      return `https://linkedin.com/in/${cleanHandle}`
    case 'email': {
      const emailOnly = trimmedHandle.split('?')[0]
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailOnly)) return null
      return `mailto:${encodeURIComponent(emailOnly)}`
    }
    case 'mastodon': {
      const match = trimmedHandle.match(/^@?([^@]+)@([a-zA-Z0-9.-]+)$/)
      if (match) {
        return `https://${match[2]}/@${encodeURIComponent(match[1])}`
      }
      return null
    }
    case 'other':
      if (trimmedHandle.startsWith('http://') || trimmedHandle.startsWith('https://')) {
        try {
          const url = new URL(trimmedHandle)
          if (['http:', 'https:'].includes(url.protocol)) {
            return trimmedHandle
          }
        } catch {
          return null
        }
      }
      return null
    default:
      return null
  }
}

export function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol)
  } catch {
    return false
  }
}
