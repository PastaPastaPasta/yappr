import { createAvatar, Style } from '@dicebear/core';
import * as collection from '@dicebear/collection';

// Cache for generated avatar data URIs
// Key: `${style}:${seed}`, Value: data URI string
const avatarCache = new Map<string, string>();
const MAX_CACHE_SIZE = 500; // Limit cache to prevent memory bloat

// Map of style names to their DiceBear collection modules. Every style is a
// Style<SomeOptions>; only the seed is passed, so the common shape suffices.
const styleMap: Record<string, Style<object>> = {
  'adventurer': collection.adventurer,
  'adventurer-neutral': collection.adventurerNeutral,
  'avataaars': collection.avataaars,
  'avataaars-neutral': collection.avataaarsNeutral,
  'big-ears': collection.bigEars,
  'big-ears-neutral': collection.bigEarsNeutral,
  'big-smile': collection.bigSmile,
  'bottts': collection.bottts,
  'bottts-neutral': collection.botttsNeutral,
  'croodles': collection.croodles,
  'croodles-neutral': collection.croodlesNeutral,
  'fun-emoji': collection.funEmoji,
  'icons': collection.icons,
  'identicon': collection.identicon,
  'initials': collection.initials,
  'lorelei': collection.lorelei,
  'lorelei-neutral': collection.loreleiNeutral,
  'micah': collection.micah,
  'miniavs': collection.miniavs,
  'notionists': collection.notionists,
  'notionists-neutral': collection.notionistsNeutral,
  'open-peeps': collection.openPeeps,
  'personas': collection.personas,
  'pixel-art': collection.pixelArt,
  'pixel-art-neutral': collection.pixelArtNeutral,
  'rings': collection.rings,
  'shapes': collection.shapes,
  'thumbs': collection.thumbs,
};

/**
 * Generate an avatar SVG string locally using DiceBear
 * @param style - The DiceBear style name
 * @param seed - The seed string for deterministic generation
 * @returns SVG string
 */
export function generateAvatarSvg(style: string, seed: string): string {
  const styleModule = styleMap[style] || collection.thumbs;
  const avatar = createAvatar(styleModule, { seed });
  return avatar.toString();
}

/**
 * Generate an avatar as a data URI for use in img src.
 * Results are cached to avoid regenerating the same avatars.
 * @param style - The DiceBear style name
 * @param seed - The seed string for deterministic generation
 * @returns Data URI string (data:image/svg+xml;base64,...)
 */
export function generateAvatarDataUri(style: string, seed: string): string {
  const cacheKey = `${style}:${seed}`;

  // Check cache first
  const cached = avatarCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Generate new avatar
  const svg = generateAvatarSvg(style, seed);
  // Encode to base64 for data URI
  const base64 = typeof btoa !== 'undefined'
    ? btoa(unescape(encodeURIComponent(svg)))
    : Buffer.from(svg).toString('base64');
  const dataUri = `data:image/svg+xml;base64,${base64}`;

  // Evict oldest entry if cache is full (simple FIFO eviction)
  if (avatarCache.size >= MAX_CACHE_SIZE) {
    const firstKey = avatarCache.keys().next().value;
    if (firstKey) avatarCache.delete(firstKey);
  }

  // Store in cache
  avatarCache.set(cacheKey, dataUri);

  return dataUri;
}

/**
 * Check if a style is valid/supported
 */
export function isValidStyle(style: string): boolean {
  return style in styleMap;
}

/**
 * Get all available style names
 */
export function getAvailableStyles(): string[] {
  return Object.keys(styleMap);
}
