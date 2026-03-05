/**
 * State Transition URI Module
 *
 * Generates `dash-st:` URIs for signing state transitions via wallet.
 * These URIs allow the wallet to sign an unsigned state transition
 * (e.g., IdentityUpdateTransition for adding keys).
 *
 * URI Format: dash-st:<base58-encoded-transition>?n=<network>&v=<version>&t=<type>
 *
 * Spec: YAPPR_DET_SIGNER_SPEC.md Section 11.5
 */

import bs58 from 'bs58'
import { NETWORK_IDS, type NetworkType } from './key-exchange-uri'

// Protocol version for state transition URIs
export const STATE_TRANSITION_VERSION = 1

// State transition type identifiers
export const TRANSITION_TYPES = {
  identityUpdate: 'iu'  // Identity Update Transition
} as const

export type TransitionType = keyof typeof TRANSITION_TYPES

/**
 * Build a dash-st: URI for a state transition signing request.
 *
 * @param transitionBytes - The serialized unsigned state transition
 * @param transitionType - The type of state transition (e.g., 'identityUpdate')
 * @param network - The network (mainnet, testnet, devnet)
 * @returns Complete dash-st: URI string
 */
export function buildStateTransitionUri(
  transitionBytes: Uint8Array,
  transitionType: TransitionType,
  network: NetworkType = 'testnet'
): string {
  // Base58 encode the transition bytes
  const transitionData = bs58.encode(transitionBytes)

  // Get network identifier
  const networkId = NETWORK_IDS[network]

  // Get transition type identifier
  const typeId = TRANSITION_TYPES[transitionType]

  // Build URI with query parameters
  return `dash-st:${transitionData}?n=${networkId}&v=${STATE_TRANSITION_VERSION}&t=${typeId}`
}

/**
 * Parse a dash-st: URI back to transition data.
 *
 * @param uri - The dash-st: URI to parse
 * @returns Parsed transition data or null if invalid
 */
export function parseStateTransitionUri(uri: string): {
  transitionBytes: Uint8Array
  transitionType: TransitionType
  network: NetworkType
  version: number
} | null {
  try {
    // Check scheme
    if (!uri.startsWith('dash-st:')) {
      return null
    }

    // Split data and query
    const uriWithoutScheme = uri.slice(8) // Remove 'dash-st:'
    const queryStart = uriWithoutScheme.indexOf('?')
    if (queryStart === -1) {
      return null
    }

    const transitionData = uriWithoutScheme.slice(0, queryStart)
    const queryString = uriWithoutScheme.slice(queryStart + 1)

    // Parse query parameters
    const params = new URLSearchParams(queryString)
    const networkId = params.get('n')
    const versionStr = params.get('v')
    const typeId = params.get('t')

    if (!networkId || !versionStr || !typeId) {
      return null
    }

    const version = parseInt(versionStr, 10)
    if (version !== STATE_TRANSITION_VERSION) {
      return null
    }

    // Map network ID back to network type
    let network: NetworkType
    switch (networkId) {
      case 'm': network = 'mainnet'; break
      case 't': network = 'testnet'; break
      case 'd': network = 'devnet'; break
      default: return null
    }

    // Map type ID back to transition type
    let transitionType: TransitionType
    switch (typeId) {
      case 'iu': transitionType = 'identityUpdate'; break
      default: return null
    }

    // Decode Base58 data
    const transitionBytes = bs58.decode(transitionData)

    return {
      transitionBytes,
      transitionType,
      network,
      version
    }
  } catch {
    return null
  }
}
