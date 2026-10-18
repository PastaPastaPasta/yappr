import { PasskeyVaultError, type PasskeyErrorCode, type PasskeyRenewal } from '@/lib/auth/passkey-vault'

const TRY_AGAIN = 'Something went wrong. Please try again.'
const NOT_ELIGIBLE = 'To add a passkey, sign in with your Dash wallet or your everyday sign-in key.'

/** What to tell the user when adding a passkey stopped; null says nothing (they closed the sheet). */
const ENROL_COPY: Record<PasskeyErrorCode, string | null> = {
  cancelled: null,
  'no-prf': 'This passkey can\'t be used to sign in to Yappr. Try a passkey saved to iCloud Keychain or Google Password Manager, or keep signing in the way you do now.',
  exists: 'You already have a Yappr passkey in this passwords app.',
  limit: 'You can have up to 10 passkeys. Remove one to add another.',
  'not-yappr': TRY_AGAIN,
  'not-set-up': TRY_AGAIN,
  stale: TRY_AGAIN,
  'not-eligible': NOT_ELIGIBLE,
  'renew-first': 'Renew Yappr in your Dash wallet first, then add your passkey.',
  untrusted: 'Passkeys are paused right now. Please try again later.',
  pending: 'Your passkey is still being saved. Check Settings in a minute; there\'s no need to add another.',
  failed: 'Your passkey couldn\'t be saved. Please try again.',
}

/**
 * What to tell the user when signing in with a passkey stopped. Only a closed
 * sheet is silent; codes a sign-in never raises still get the generic line.
 */
const SIGN_IN_COPY: Record<PasskeyErrorCode, string | null> = {
  cancelled: null,
  'no-prf': 'This passkey can\'t sign you in on this browser. Try another browser or device, or sign in another way.',
  exists: TRY_AGAIN,
  limit: TRY_AGAIN,
  'not-yappr': 'This passkey isn\'t for Yappr.',
  'not-set-up': 'This passkey isn\'t set up for Yappr here. Sign in another way, then add it in Settings.',
  stale: 'This passkey needs updating. Sign in another way once, and Yappr will offer to update it.',
  'not-eligible': 'This passkey can\'t sign you in any more. Sign in another way, then add a new one.',
  'renew-first': TRY_AGAIN,
  untrusted: 'Passkey sign-in is paused right now. Please try again later.',
  pending: TRY_AGAIN,
  failed: 'That didn\'t work. Please try again.',
}

/** Why Settings offers no "Add a passkey" for this session. */
export const NOT_ELIGIBLE_COPY: Partial<Record<PasskeyErrorCode, string>> = {
  'not-eligible': NOT_ELIGIBLE,
  'renew-first': 'Renew Yappr in your Dash wallet to add or update passkeys.',
}

function codeOf(error: unknown): PasskeyErrorCode {
  return error instanceof PasskeyVaultError ? error.code : 'failed'
}

export function enrolErrorCopy(error: unknown): string | null {
  return ENROL_COPY[codeOf(error)]
}

export function signInErrorCopy(error: unknown): string | null {
  return SIGN_IN_COPY[codeOf(error)]
}

export const RENEW_COPY: Record<PasskeyRenewal['reason'], string> = {
  expired: 'Your Dash wallet\'s sign-in for Yappr has run out. Approve Yappr in your wallet to keep going.',
  revoked: 'This passkey\'s wallet sign-in was turned off. Approve Yappr in your Dash wallet to sign in again.',
}

/**
 * The honest part of removing passkeys: removal stops them signing in, but
 * copies sealed earlier stay on the network until the keys inside are turned
 * off, the messaging key among them (on a key sign-in it is usually made from
 * the sign-in key, so changing that key alone leaves it readable).
 */
export function lockOutCopy(wallet: boolean): string {
  return wallet
    ? 'If you think someone else has your passkey, also turn off Yappr in your Dash wallet and change your messaging key there: copies saved earlier stay on the network until you do, and they can read your private messages. Then remove, don\'t update, any passkey you don\'t recognise.'
    : 'If you think someone else has your passkey or key, also change your key and your messaging key in your Dash wallet (your messaging key is usually made from your key): copies saved earlier stay on the network until you do, and they can read your private messages. Then remove, don\'t update, any passkey you don\'t recognise.'
}

export function formatPasskeyDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** The heading of a passkey row: its local name, or when it was added. */
export function passkeyLabel(entry: { name: string | null; addedAt: number }): string {
  return entry.name ?? `Passkey added ${formatPasskeyDate(entry.addedAt)}`
}

/** The details under a row's heading: when it was added (if named), where, and whether it needs updating. */
export function passkeyDetails(entry: { name: string | null; addedAt: number; thisDevice: boolean; needsUpdate: boolean }): string {
  return [
    entry.name ? `Added ${formatPasskeyDate(entry.addedAt)}` : null,
    entry.thisDevice ? 'This device' : 'Another device',
    entry.needsUpdate ? 'Needs update' : null,
  ].filter(Boolean).join(' · ')
}
