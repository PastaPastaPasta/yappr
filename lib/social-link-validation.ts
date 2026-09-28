import type { SocialLink } from '@/types/user'
import { LIST_LIMITS, socialLinkToString, utf8ByteLength } from '@/lib/typed-array-codecs'

/**
 * Why `link` cannot join `existing`, or null when it can. Profile v2 stores
 * each link as ONE "platform:handle" string of at most 256 UTF-8 bytes, the
 * prefix included, and refuses duplicates, so both are checked before saving.
 * `platformLabel` names the platform in the message.
 */
export function socialLinkAddProblem(existing: readonly SocialLink[], link: SocialLink, platformLabel: string): string | null {
  const stored = socialLinkToString(link)
  const { maxBytes } = LIST_LIMITS.profileSocialLinks
  if (utf8ByteLength(stored) > maxBytes) {
    return `That handle is too long (at most ${maxBytes - link.platform.length - 1} bytes for ${platformLabel}; accented letters and emoji count as more than one)`
  }
  if (existing.some((other) => socialLinkToString(other) === stored)) return 'This link is already added'
  return null
}

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
