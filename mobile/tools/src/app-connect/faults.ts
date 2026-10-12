/**
 * Fault flags: deliberate wallet misbehaviour, so app-side tests can check
 * that every bad answer is refused. Without a flag the responder behaves like
 * an honest wallet that follows docs/APP_CONNECT_PROFILE.md. The README lists
 * what each flag does and what the app should report.
 */

export interface AppConnectFaults {
  /** Seal the payload for another `$ownerId` (AAD), publish it under the persona. */
  wrongOwner: boolean
  /** After the honest answer, the other persona republishes the same payload under its own id. */
  copyResponse: boolean
  /** Send the primary binding's key without registering it. */
  unregisteredKey: boolean
  /** Register the primary binding's key without contract bounds. */
  unboundKey: boolean
  /** Register the first non-group auth key at CRITICAL. */
  critical: boolean
  /** Bind the contractGroup key to this other (existing) group. */
  foreignGroup?: string
  /** Every auth key expires a minute after registration. */
  expired: boolean
  /** Every auth key gets this budget (credits). */
  budget?: bigint
  /** Every auth key expires this many seconds from now. */
  expiresInSeconds?: number
  /** Flip a bit of the AES-GCM tag. */
  badTag: boolean
  /** Append a slot holding a key that is on no identity. */
  extraSlot: boolean
  /** Before answering, this many other personas publish junk responses to the request. */
  spam?: number
  /** After the honest answer, the other persona answers too, with its own keys. */
  secondIdentity: boolean
  /** Decline the encryption bindings. */
  omitEnc: boolean
  /** Decline the documentType bindings (the DashPay profile). */
  omitProfile: boolean
}

const FLAGS = {
  'wrong-owner': 'wrongOwner',
  'copy-response': 'copyResponse',
  'unregistered-key': 'unregisteredKey',
  'unbound-key': 'unboundKey',
  critical: 'critical',
  expired: 'expired',
  'bad-tag': 'badTag',
  'extra-slot': 'extraSlot',
  'second-identity': 'secondIdentity',
  'omit-enc': 'omitEnc',
  'omit-profile': 'omitProfile',
} as const satisfies Record<string, keyof AppConnectFaults>

const VALUED = ['budget', 'expires-in', 'spam', 'foreign-group'] as const

export const FAULT_NAMES: readonly string[] = [...Object.keys(FLAGS), ...VALUED.map((name) => `${name}=<…>`)]

/** At most this many junk responses per request. */
const MAX_SPAM = 50
/** Budgets are u64 credits on chain. */
const MAX_U64 = (1n << 64n) - 1n
const BASE58_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export function noFaults(): AppConnectFaults {
  return {
    wrongOwner: false,
    copyResponse: false,
    unregisteredKey: false,
    unboundKey: false,
    critical: false,
    expired: false,
    badTag: false,
    extraSlot: false,
    secondIdentity: false,
    omitEnc: false,
    omitProfile: false,
  }
}

/** Parses `["budget=1000", "omit-enc", …]`; unknown, repeated or malformed flags are errors. */
export function parseFaults(list: readonly string[]): AppConnectFaults {
  const faults = noFaults()
  const seen = new Set<string>()
  for (const raw of list) {
    const separator = raw.indexOf('=')
    const name = separator === -1 ? raw : raw.slice(0, separator)
    const value = separator === -1 ? undefined : raw.slice(separator + 1)
    if (seen.has(name)) throw new Error(`fault ${name} is repeated`)
    seen.add(name)

    if (Object.hasOwn(FLAGS, name)) {
      if (value !== undefined) throw new Error(`fault ${name} takes no value`)
      faults[FLAGS[name as keyof typeof FLAGS]] = true
      continue
    }
    if (!(VALUED as readonly string[]).includes(name)) throw new Error(`unknown fault ${name}; known: ${FAULT_NAMES.join(', ')}`)
    if (value === undefined || value === '') throw new Error(`fault ${name} needs a value (${name}=<…>)`)
    switch (name) {
      case 'budget': {
        const budget = /^\d+$/.test(value) ? BigInt(value) : 0n
        if (budget <= 0n || budget > MAX_U64) throw new Error('budget=<credits> must be between 1 and 2^64-1')
        faults.budget = budget
        break
      }
      case 'expires-in':
        faults.expiresInSeconds = positiveInteger(value, 'expires-in=<seconds>')
        break
      case 'spam':
        faults.spam = positiveInteger(value, 'spam=<n>')
        if (faults.spam > MAX_SPAM) throw new Error(`spam=<n> is at most ${MAX_SPAM}`)
        break
      case 'foreign-group':
        if (!BASE58_ID.test(value)) throw new Error('foreign-group=<group id> needs a base58 group id')
        faults.foreignGroup = value
        break
    }
  }
  if (faults.expired && faults.expiresInSeconds !== undefined) throw new Error('expired and expires-in exclude each other')
  if (faults.unboundKey && faults.unregisteredKey) throw new Error('unbound-key and unregistered-key exclude each other')
  return faults
}

/** The flags set, as they were given (for the result line). */
export function describeFaults(faults: AppConnectFaults): string[] {
  const names: string[] = Object.entries(FLAGS).filter(([, key]) => faults[key]).map(([name]) => name)
  if (faults.budget !== undefined) names.push(`budget=${faults.budget}`)
  if (faults.expiresInSeconds !== undefined) names.push(`expires-in=${faults.expiresInSeconds}`)
  if (faults.spam !== undefined) names.push(`spam=${faults.spam}`)
  if (faults.foreignGroup !== undefined) names.push(`foreign-group=${faults.foreignGroup}`)
  return names
}

/** The faults that act through a second persona. */
export function needsOtherPersona(faults: AppConnectFaults): boolean {
  return faults.copyResponse || faults.secondIdentity
}

function positiveInteger(value: string, label: string): number {
  const number = /^\d+$/.test(value) ? Number(value) : NaN
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`)
  return number
}
