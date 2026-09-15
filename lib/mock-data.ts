/**
 * Default placeholder avatar generation (local DiceBear).
 */

import { generateAvatarDataUri } from './services/avatar-generator';

/**
 * Generate a default avatar data URI using local DiceBear.
 * Provides consistent placeholder avatars based on user ID.
 */
export function getDefaultAvatarUrl(userId: string): string {
  if (!userId) return '';
  return generateAvatarDataUri('thumbs', userId);
}
