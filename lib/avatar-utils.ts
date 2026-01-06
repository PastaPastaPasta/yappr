/**
 * Avatar utilities for DiceBear avatars
 * Generated deterministically from seeds
 *
 * Note: When using these URLs in <img> tags, add crossOrigin="anonymous"
 * to work with COEP headers.
 */

// All available DiceBear styles
export const DICEBEAR_STYLES = [
  'adventurer',
  'adventurer-neutral',
  'avataaars',
  'avataaars-neutral',
  'big-ears',
  'big-ears-neutral',
  'big-smile',
  'bottts',
  'bottts-neutral',
  'croodles',
  'croodles-neutral',
  'fun-emoji',
  'icons',
  'identicon',
  'initials',
  'lorelei',
  'lorelei-neutral',
  'micah',
  'miniavs',
  'notionists',
  'notionists-neutral',
  'open-peeps',
  'personas',
  'pixel-art',
  'pixel-art-neutral',
  'rings',
  'shapes',
  'thumbs',
] as const

export type DiceBearStyle = typeof DICEBEAR_STYLES[number]

// Human-readable labels for styles
export const DICEBEAR_STYLE_LABELS: Record<DiceBearStyle, string> = {
  'adventurer': 'Adventurer',
  'adventurer-neutral': 'Adventurer Neutral',
  'avataaars': 'Avataaars',
  'avataaars-neutral': 'Avataaars Neutral',
  'big-ears': 'Big Ears',
  'big-ears-neutral': 'Big Ears Neutral',
  'big-smile': 'Big Smile',
  'bottts': 'Bottts',
  'bottts-neutral': 'Bottts Neutral',
  'croodles': 'Croodles',
  'croodles-neutral': 'Croodles Neutral',
  'fun-emoji': 'Fun Emoji',
  'icons': 'Icons',
  'identicon': 'Identicon',
  'initials': 'Initials',
  'lorelei': 'Lorelei',
  'lorelei-neutral': 'Lorelei Neutral',
  'micah': 'Micah',
  'miniavs': 'Miniavs',
  'notionists': 'Notionists',
  'notionists-neutral': 'Notionists Neutral',
  'open-peeps': 'Open Peeps',
  'personas': 'Personas',
  'pixel-art': 'Pixel Art',
  'pixel-art-neutral': 'Pixel Art Neutral',
  'rings': 'Rings',
  'shapes': 'Shapes',
  'thumbs': 'Thumbs',
}

export const DEFAULT_STYLE: DiceBearStyle = 'thumbs'

export interface AvatarConfig {
  style: DiceBearStyle
  seed: string
}

export interface AvatarData {
  seed: string
  style: DiceBearStyle
}

/**
 * Generate avatar URL from config
 */
export function getAvatarUrl(config: AvatarConfig): string {
  // Guard against empty seed to prevent seed= URLs
  if (!config.seed) {
    console.warn('avatar-utils: getAvatarUrl called with empty seed')
    return ''
  }
  return `https://api.dicebear.com/7.x/${config.style}/svg?seed=${encodeURIComponent(config.seed)}`
}

/**
 * Get default avatar URL using user ID as seed (backwards compatible)
 */
export function getDefaultAvatarUrl(userId: string): string {
  // Guard against empty userId
  if (!userId) {
    console.warn('avatar-utils: getDefaultAvatarUrl called with empty userId')
    return ''
  }
  return getAvatarUrl({ style: DEFAULT_STYLE, seed: userId })
}

/**
 * Parse avatar data from stored JSON string
 */
export function parseAvatarData(data: string): AvatarData {
  try {
    const parsed = JSON.parse(data)
    return {
      seed: parsed.seed || '',
      style: DICEBEAR_STYLES.includes(parsed.style) ? parsed.style : DEFAULT_STYLE,
    }
  } catch {
    // Legacy format or invalid - treat as seed only
    return { seed: data, style: DEFAULT_STYLE }
  }
}

/**
 * Encode avatar config to JSON string for storage
 * Must be 16-128 chars per contract constraint
 */
export function encodeAvatarData(seed: string, style: DiceBearStyle): string {
  const data = JSON.stringify({ seed, style })
  // Ensure minimum length of 16 chars
  if (data.length < 16) {
    // Pad seed if needed
    const paddedSeed = seed.padEnd(16 - `{"seed":"","style":"${style}"}`.length + seed.length, '_')
    return JSON.stringify({ seed: paddedSeed, style })
  }
  // Truncate seed if data exceeds 128 chars
  if (data.length > 128) {
    const maxSeedLength = 128 - `{"seed":"","style":"${style}"}`.length
    return JSON.stringify({ seed: seed.slice(0, maxSeedLength), style })
  }
  return data
}

/**
 * Generate a random seed string
 */
export function generateRandomSeed(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
}
