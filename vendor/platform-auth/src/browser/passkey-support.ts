'use client'

export type PasskeyPlatformHint = 'apple' | 'android' | 'windows' | 'desktop-other' | 'unknown'

export interface PasskeyPrfSupport {
  webauthnAvailable: boolean
  conditionalUiAvailable: boolean
  likelyPrfCapable: boolean
  platformHint: PasskeyPlatformHint
  blockedReason?: string
}

function getPlatformHint(): PasskeyPlatformHint {
  if (typeof navigator === 'undefined') return 'unknown'

  const userAgent = navigator.userAgent.toLowerCase()
  const platform = navigator.platform?.toLowerCase() ?? ''

  if (/iphone|ipad|ipod|mac os|macintosh/.test(userAgent) || /iphone|ipad|mac/.test(platform)) {
    return 'apple'
  }
  if (/android/.test(userAgent)) {
    return 'android'
  }
  if (/windows/.test(userAgent) || /win/.test(platform)) {
    return 'windows'
  }
  if (userAgent) {
    return 'desktop-other'
  }

  return 'unknown'
}

export async function getPasskeyPrfSupport(): Promise<PasskeyPrfSupport> {
  if (typeof window === 'undefined') {
    return {
      webauthnAvailable: false,
      conditionalUiAvailable: false,
      likelyPrfCapable: false,
      platformHint: 'unknown',
      blockedReason: 'Passkeys are only available in a browser context.',
    }
  }

  if (!window.isSecureContext) {
    return {
      webauthnAvailable: false,
      conditionalUiAvailable: false,
      likelyPrfCapable: false,
      platformHint: getPlatformHint(),
      blockedReason: 'Passkey enrollment requires a secure browser context.',
    }
  }

  const publicKeyCredential = window.PublicKeyCredential
  if (!publicKeyCredential) {
    return {
      webauthnAvailable: false,
      conditionalUiAvailable: false,
      likelyPrfCapable: false,
      platformHint: getPlatformHint(),
      blockedReason: 'This browser does not support WebAuthn passkeys.',
    }
  }

  const conditionalUiAvailable = typeof publicKeyCredential.isConditionalMediationAvailable === 'function'
    ? await publicKeyCredential.isConditionalMediationAvailable().catch(() => false)
    : false

  const platformAuthenticatorAvailable = typeof publicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === 'function'
    ? await publicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false)
    : false

  return {
    webauthnAvailable: true,
    conditionalUiAvailable,
    likelyPrfCapable: platformAuthenticatorAvailable || conditionalUiAvailable,
    platformHint: getPlatformHint(),
    blockedReason: platformAuthenticatorAvailable || conditionalUiAvailable
      ? undefined
      : 'This browser can use passkeys, but PRF capability still needs to be confirmed by an actual passkey assertion.',
  }
}
