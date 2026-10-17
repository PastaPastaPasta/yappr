import type { PasskeyErrorCode } from '@/lib/auth/passkey-vault'
import { PasskeyVaultError } from '@/lib/auth/passkey-vault'

/** What to tell the user when adding a passkey stopped; null says nothing (they closed the sheet). */
const ENROL_COPY: Record<PasskeyErrorCode, string | null> = {
  cancelled: null,
  'no-prf': 'This passkey can\'t be used to sign in to Yappr. Try a passkey saved to iCloud Keychain or Google Password Manager, or keep signing in the way you do now.',
  exists: 'You already have a Yappr passkey in this passwords app.',
  limit: 'You can have up to 10 passkeys. Remove one to add another.',
  'not-yappr': 'Something went wrong. Please try again.',
  'not-set-up': 'Something went wrong. Please try again.',
  stale: 'Something went wrong. Please try again.',
  'not-eligible': 'To add a passkey, sign in with your Dash wallet or your everyday sign-in key.',
  'renew-first': 'Renew Yappr in your Dash wallet first, then add your passkey.',
  untrusted: 'Passkeys are paused right now. Please try again later.',
  failed: 'Your passkey couldn\'t be saved. Please try again.',
}

/** What to tell the user when signing in with a passkey stopped. */
const SIGN_IN_COPY: Record<PasskeyErrorCode, string | null> = {
  cancelled: null,
  'no-prf': 'This passkey can\'t sign you in on this browser. Try another browser or device, or sign in another way.',
  exists: null,
  limit: null,
  'not-yappr': 'This passkey isn\'t for Yappr.',
  'not-set-up': 'This passkey isn\'t set up for Yappr here. Sign in another way, then add it in Settings.',
  stale: 'This passkey needs updating. Sign in another way once, and Yappr will offer to update it.',
  'not-eligible': 'This passkey can\'t sign you in any more. Sign in another way, then add a new one.',
  'renew-first': null,
  untrusted: 'Passkey sign-in is paused right now. Please try again later.',
  failed: 'That didn\'t work. Please try again.',
}

function codeOf(error: unknown): PasskeyErrorCode {
  return error instanceof PasskeyVaultError ? error.code : 'failed'
}

export function enrolErrorCopy(error: unknown): string | null {
  return ENROL_COPY[codeOf(error)]
}

export function signInErrorCopy(error: unknown): string | null {
  const code = codeOf(error)
  return code === 'cancelled' ? null : SIGN_IN_COPY[code] ?? SIGN_IN_COPY.failed
}

export const RENEW_COPY = {
  expired: 'Your Dash wallet\'s sign-in for Yappr has run out. Approve Yappr in your wallet to keep going.',
  revoked: 'This passkey\'s wallet sign-in was turned off. Approve Yappr in your Dash wallet to sign in again.',
} as const

export function formatPasskeyDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** The heading of a passkey row: its local name, or when it was added. */
export function passkeyLabel(entry: { name: string | null; addedAt: number }): string {
  return entry.name ?? `Passkey added ${formatPasskeyDate(entry.addedAt)}`
}
