/**
 * Canonical primary-username selection for identities with multiple DPNS names.
 *
 * Ordering: contested names first, then shortest, then alphabetically.
 * Contested status is a pure function of the label (WasmSdk static check),
 * so selection is synchronous and must be identical everywhere a "primary"
 * username is shown.
 */

import { WasmSdk } from '@dashevo/wasm-sdk'

/**
 * Check whether a username's label is contested (premium).
 * Accepts a bare label or a full name like "alice.dash".
 * Returns false if the WASM module is not initialized yet.
 */
export function isUsernameContested(username: string): boolean {
  try {
    return WasmSdk.dpnsIsContestedUsername(username.split('.')[0])
  } catch {
    return false
  }
}

/**
 * Canonical comparator: contested first, then shortest, then alphabetically.
 */
export function compareUsernames(a: string, b: string): number {
  const aContested = isUsernameContested(a)
  const bContested = isUsernameContested(b)
  if (aContested !== bContested) return aContested ? -1 : 1
  if (a.length !== b.length) return a.length - b.length
  return a.localeCompare(b)
}

/**
 * Sort usernames by the canonical ordering (returns a new array).
 */
export function sortUsernames(usernames: string[]): string[] {
  return [...usernames].sort(compareUsernames)
}

/**
 * Pick the primary username from a list using the canonical ordering.
 */
export function getPrimaryUsername(usernames: string[]): string | null {
  if (usernames.length === 0) return null
  return usernames.reduce((best, u) => (compareUsernames(u, best) < 0 ? u : best))
}
