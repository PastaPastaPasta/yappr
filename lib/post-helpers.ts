/**
 * Helper functions for creating and managing posts on Dash Platform
 */

/**
 * Extract hashtags from post content
 * Max 63 chars to match Dash Platform indexed property constraint
 */
export function extractHashtags(content: string): string[] {
  const regex = /#[a-zA-Z0-9_]{1,63}/g
  const matches = content.match(regex) || []
  return Array.from(new Set(matches.map(tag => tag.slice(1).toLowerCase()))) // Remove # prefix, lowercase, dedupe
}
