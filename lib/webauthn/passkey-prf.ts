'use client'

import {
  createPasskeyWithPrf as createPlatformPasskeyWithPrf,
  getDefaultRpId,
  getPasskeyAllowCredentialIds,
  getPrfAssertionForCredentials,
  selectDiscoverablePasskey,
  type DiscoverablePasskeySelectionResult,
  type EnrollPasskeyOptions,
  type PasskeyCredentialDescriptor,
  type PasskeyPrfAssertionResult,
} from 'platform-auth'

export type {
  DiscoverablePasskeySelectionResult,
  EnrollPasskeyOptions,
  PasskeyCredentialDescriptor,
  PasskeyPrfAssertionResult,
}

export { getDefaultRpId, getPasskeyAllowCredentialIds, getPrfAssertionForCredentials, selectDiscoverablePasskey }

export async function createPasskeyWithPrf(
  options: EnrollPasskeyOptions,
): Promise<PasskeyPrfAssertionResult & { label: string }> {
  return createPlatformPasskeyWithPrf({
    ...options,
    rpName: options.rpName ?? 'Yappr',
  })
}
