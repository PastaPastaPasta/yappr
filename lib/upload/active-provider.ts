/**
 * The identity's upload provider (Storacha, then Pinata): the one already
 * connected, else the first whose stored credentials still connect.
 */

import { getStorachaProvider } from './providers/storacha/storacha-provider'
import { getPinataProvider } from './providers/pinata/pinata-provider'
import type { UploadProvider } from './types'

/**
 * Get connected provider (Storacha or Pinata) for the given identity
 */
function getConnectedProvider(identityId: string): UploadProvider | null {
  // Check Storacha first
  const storacha = getStorachaProvider()
  storacha.setIdentityId(identityId)
  if (storacha.isConnected()) {
    return storacha
  }

  // Check Pinata
  const pinata = getPinataProvider()
  pinata.setIdentityId(identityId)
  if (pinata.isConnected()) {
    return pinata
  }

  return null
}

/**
 * Try to connect a provider using stored credentials
 */
async function tryConnectProvider(identityId: string): Promise<UploadProvider | null> {
  // Try Storacha
  const storacha = getStorachaProvider()
  storacha.setIdentityId(identityId)
  if (storacha.hasStoredCredentials()) {
    try {
      await storacha.connect()
      return storacha
    } catch {
      // Credentials invalid or expired
    }
  }

  // Try Pinata
  const pinata = getPinataProvider()
  pinata.setIdentityId(identityId)
  if (pinata.hasStoredCredentials()) {
    try {
      await pinata.connect()
      return pinata
    } catch {
      // Credentials invalid or expired
    }
  }

  return null
}

/** The connected provider, connecting one from stored credentials if needed. */
export async function getUploadProvider(identityId: string): Promise<UploadProvider | null> {
  return getConnectedProvider(identityId) ?? tryConnectProvider(identityId)
}
