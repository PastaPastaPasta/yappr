/**
 * Insight API Service for Dash transaction detection
 * Polls Insight API for UTXOs at a specified address
 */

import { DEFAULT_NETWORK, INSIGHT_API_URLS, INSIGHT_API_CONFIG } from '@/lib/constants'

export interface Utxo {
  txid: string
  vout: number
  satoshis: number
  confirmations: number
  scriptPubKey: string
  address: string
}

export interface WaitForUtxoOptions {
  pollIntervalMs?: number
  timeoutMs?: number
  onProgress?: (elapsed: number, remaining: number) => void
  signal?: AbortSignal
  network?: 'testnet' | 'mainnet'
}

export interface WaitForUtxoResult {
  success: boolean
  utxo?: Utxo
  timedOut: boolean
  error?: string
}

/**
 * Fetch UTXOs for a given address from the Insight API
 */
async function fetchUtxos(address: string, network: 'testnet' | 'mainnet'): Promise<Utxo[]> {
  const baseUrl = INSIGHT_API_URLS[network]
  const response = await fetch(`${baseUrl}/addr/${address}/utxo`)

  if (!response.ok) {
    throw new Error(`Insight API error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()
  return Array.isArray(data) ? data : []
}

/**
 * Wait for a UTXO to appear at the specified address
 * Polls the Insight API at regular intervals until a UTXO is detected or timeout
 */
export async function waitForUtxo(
  address: string,
  options: WaitForUtxoOptions = {}
): Promise<WaitForUtxoResult> {
  const {
    pollIntervalMs = INSIGHT_API_CONFIG.pollIntervalMs,
    timeoutMs = INSIGHT_API_CONFIG.timeoutMs,
    onProgress,
    signal,
    network = DEFAULT_NETWORK as 'testnet' | 'mainnet'
  } = options

  const startTime = Date.now()

  // Get initial UTXOs to establish baseline
  let existingTxids: Set<string>
  try {
    const initialUtxos = await fetchUtxos(address, network)
    existingTxids = new Set(initialUtxos.map(u => u.txid))
  } catch (error) {
    // If we can't fetch initial state, start with empty set
    existingTxids = new Set()
  }

  return new Promise((resolve) => {
    const poll = async () => {
      // Check if aborted
      if (signal?.aborted) {
        resolve({ success: false, timedOut: false, error: 'Cancelled' })
        return
      }

      const elapsed = Date.now() - startTime
      const remaining = Math.max(0, timeoutMs - elapsed)

      // Check timeout
      if (elapsed >= timeoutMs) {
        resolve({ success: false, timedOut: true })
        return
      }

      // Report progress
      onProgress?.(elapsed, remaining)

      try {
        const utxos = await fetchUtxos(address, network)

        // Find new UTXOs that weren't in the initial set
        const newUtxo = utxos.find(u => !existingTxids.has(u.txid))

        if (newUtxo) {
          resolve({ success: true, utxo: newUtxo, timedOut: false })
          return
        }
      } catch (error) {
        // Continue polling on network errors
        console.warn('Insight API poll error:', error)
      }

      // Schedule next poll
      setTimeout(poll, pollIntervalMs)
    }

    // Start polling
    poll().catch((error) => {
      console.error('Unexpected error in UTXO polling:', error)
      resolve({ success: false, timedOut: false, error: 'Polling failed unexpectedly' })
    })
  })
}

/**
 * Check if a scheme is a Dash payment scheme
 */
export function isDashScheme(scheme: string): boolean {
  const normalizedScheme = scheme.toLowerCase()
  return normalizedScheme === 'dash:' || normalizedScheme === 'tdash:'
}

/**
 * Get the network for a Dash payment scheme
 */
export function getNetworkFromScheme(scheme: string): 'testnet' | 'mainnet' {
  return scheme.toLowerCase() === 'tdash:' ? 'testnet' : 'mainnet'
}

/**
 * Convert satoshis to DASH
 */
export function satoshisToDash(satoshis: number): number {
  return satoshis / 100000000
}

export const insightApiService = {
  fetchUtxos,
  waitForUtxo,
  isDashScheme,
  getNetworkFromScheme,
  satoshisToDash
}
