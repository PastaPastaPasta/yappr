export function validateSocialHandle(platform: string, handle: string): string | null {
  const trimmed = handle.trim()

  switch (platform) {
    case 'twitter':
    case 'twitch':
    case 'telegram':
      if (!/^@?[\w]+$/.test(trimmed)) {
        return 'Only letters, numbers, and underscores allowed'
      }
      break
    case 'github':
      if (!/^@?[a-zA-Z0-9]+(?:-[a-zA-Z0-9]+)*$/.test(trimmed)) {
        return 'Use letters, numbers, and single hyphens between words'
      }
      break
    case 'instagram':
      if (!/^@?[\w.]+$/.test(trimmed)) {
        return 'Only letters, numbers, underscores, and periods allowed'
      }
      break
    case 'youtube':
      if (!/^@?[\w.-]+$/.test(trimmed)) {
        return 'Invalid YouTube handle'
      }
      break
    case 'linkedin':
      if (!/^[\w-]+$/.test(trimmed)) {
        return 'Only letters, numbers, and hyphens allowed'
      }
      break
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return 'Invalid email address'
      }
      break
    case 'mastodon':
      if (!/^@?[\w]+@[a-zA-Z0-9.-]+$/.test(trimmed)) {
        return 'Use format @user@instance.social'
      }
      break
    case 'discord':
      if (!/^[\w.]+(?:#\d{4})?$/.test(trimmed)) {
        return 'Invalid Discord username (e.g., username or username#1234)'
      }
      break
    case 'nostr':
      if (!/^npub1[a-z0-9]{58}$/.test(trimmed)) {
        return 'Invalid npub format'
      }
      break
    case 'other':
      if (/^https?:\/\//i.test(trimmed)) {
        try {
          const url = new URL(trimmed)
          if (!['http:', 'https:'].includes(url.protocol)) {
            return 'Only http/https URLs allowed'
          }
        } catch {
          return 'Invalid URL'
        }
      }
      break
  }
  return null
}
