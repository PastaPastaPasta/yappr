/**
 * Shared JSON parsing utilities for document services
 */

/**
 * Parse a JSON field that may be an array, a JSON string, or already parsed.
 * Handles Dash Platform documents where JSON fields may arrive as strings.
 */
export function parseJsonArray<T>(value: unknown, fieldName: string): T[] | undefined {
  if (!value) return undefined
  if (Array.isArray(value)) return value as T[]
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T[]
    } catch {
      console.error(`Failed to parse ${fieldName}:`, value)
    }
  }
  return undefined
}

/**
 * Parse a JSON field that may be an object, a JSON string, or already parsed.
 * Handles Dash Platform documents where JSON fields may arrive as strings.
 */
export function parseJsonObject<T>(value: unknown, fieldName: string): T | undefined {
  if (!value) return undefined
  if (typeof value === 'object' && !Array.isArray(value)) return value as T
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      console.error(`Failed to parse ${fieldName}:`, value)
    }
  }
  return undefined
}
