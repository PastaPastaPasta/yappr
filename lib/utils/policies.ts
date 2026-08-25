import type { StorePolicy } from '@/lib/types'

const MAX_POLICIES_LENGTH = 2000

/**
 * Check if a string is structured JSON policies (starts with '[')
 */
export function isStructuredPolicies(raw: string): boolean {
  const trimmed = raw.trim()
  return trimmed.startsWith('[') && trimmed.endsWith(']')
}

/**
 * Convert legacy plain text policies to structured format
 */
export function migrateLegacyPolicies(text: string): StorePolicy[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  return [{ name: 'Store Policy', content: trimmed }]
}

/**
 * Parse policies string (JSON array or legacy text) into StorePolicy[]
 */
export function parseStorePolicies(raw: string | undefined): StorePolicy[] {
  if (!raw?.trim()) return []

  const trimmed = raw.trim()

  // Try to parse as JSON array
  if (isStructuredPolicies(trimmed)) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        // Validate each policy has name and content
        return parsed.filter(
          (p): p is StorePolicy =>
            typeof p === 'object' &&
            p !== null &&
            typeof p.name === 'string' &&
            typeof p.content === 'string'
        )
      }
    } catch {
      // Fall through to legacy migration
    }
  }

  // Legacy plain text - migrate to single policy
  return migrateLegacyPolicies(raw)
}

/**
 * Serialize StorePolicy[] to JSON string for storage
 */
export function serializeStorePolicies(policies: StorePolicy[]): string {
  if (policies.length === 0) return ''
  return JSON.stringify(policies)
}

/**
 * Calculate total character length of serialized policies
 */
export function calculatePoliciesLength(policies: StorePolicy[]): number {
  if (policies.length === 0) return 0
  return serializeStorePolicies(policies).length
}

/**
 * Check if policies are within the character limit
 */
export function isPoliciesWithinLimit(policies: StorePolicy[]): boolean {
  return calculatePoliciesLength(policies) <= MAX_POLICIES_LENGTH
}

/**
 * Suggested policy names for the dropdown
 */
export const SUGGESTED_POLICY_NAMES = [
  'Privacy Policy',
  'Return & Refund Policy',
  'Shipping Policy',
  'Terms of Sale',
  'Warranty Policy',
  'Payment Policy'
]

export { MAX_POLICIES_LENGTH }
