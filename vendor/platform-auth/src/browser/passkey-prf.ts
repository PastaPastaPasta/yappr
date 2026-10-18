'use client'

/**
 * WebAuthn ceremonies with the PRF extension, for a passkey whose PRF output
 * an app uses as key material (Yappr's passkey vault). Free of app types: the
 * caller supplies the relying party, the user handle and the PRF input.
 *
 * PRF support is only ever known from an actual output. Browsers report what
 * they would forward (`getClientCapabilities`), not what a provider returns,
 * so every function here hands back `prfOutput: null` rather than guessing.
 */

export interface PasskeyRelyingParty {
  id: string
  name: string
}

export interface CreatePasskeyOptions {
  rp: PasskeyRelyingParty
  /** The user handle (up to 64 bytes); a discoverable sign-in returns it. */
  userId: Uint8Array
  /** Shown in the passkey picker. */
  userName: string
  displayName: string
  /** PRF `first` input, evaluated during creation where the authenticator can. */
  prfInput: Uint8Array
  /** Passkeys this user already has here: the browser refuses to make another in the same provider. */
  excludeCredentialIds?: Uint8Array[]
  timeoutMs?: number
}

export interface CreatedPasskey {
  credentialId: Uint8Array
  /** The PRF output at creation, when the authenticator evaluated it then (many only do at sign-in). */
  prfOutput: Uint8Array | null
  /** What the browser said about PRF at creation: false means the passkey will never give one. */
  prfEnabled: boolean | undefined
}

export interface GetPasskeyPrfOptions {
  rpId: string
  prfInput: Uint8Array
  /** Restrict to these passkeys (enrolment's confirmation); omit for a discoverable sign-in. */
  allowCredentialIds?: Uint8Array[]
  timeoutMs?: number
}

export interface PasskeyPrfAssertion {
  credentialId: Uint8Array
  /** The user handle the passkey was created with, or null when the authenticator gave none. */
  userHandle: Uint8Array | null
  prfOutput: Uint8Array | null
}

/** The user closed the passkey sheet, or it timed out: nothing to report. */
export class PasskeyCancelledError extends Error {
  constructor() {
    super('The passkey request was cancelled')
    this.name = 'PasskeyCancelledError'
  }
}

/** Creation refused because the user already has one of the excluded passkeys in this provider. */
export class PasskeyExistsError extends Error {
  constructor() {
    super('A passkey for this account already exists here')
    this.name = 'PasskeyExistsError'
  }
}

interface PrfClientOutput {
  enabled?: boolean
  results?: { first?: BufferSource }
}

type ExtensionOutputs = AuthenticationExtensionsClientOutputs & { prf?: PrfClientOutput }

const DEFAULT_TIMEOUT_MS = 60_000

/** Whether this page can run WebAuthn at all (a secure context with the API). PRF is only known from an output. */
export function passkeysAvailable(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true && typeof window.PublicKeyCredential === 'function'
}

function requirePasskeys(): void {
  if (!passkeysAvailable()) throw new Error('Passkeys need a secure browser page with WebAuthn support')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function toBytes(source: BufferSource | null | undefined): Uint8Array | null {
  if (!source) return null
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0))
  return new Uint8Array(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength))
}

function prfFirst(credential: PublicKeyCredential): { output: Uint8Array | null; enabled: boolean | undefined } {
  const prf = (credential.getClientExtensionResults() as ExtensionOutputs).prf
  return { output: toBytes(prf?.results?.first), enabled: prf?.enabled }
}

function translateCeremonyError(error: unknown): unknown {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') return new PasskeyCancelledError()
    if (error.name === 'InvalidStateError') return new PasskeyExistsError()
  }
  return error
}

function descriptors(ids: Uint8Array[] | undefined): PublicKeyCredentialDescriptor[] | undefined {
  return ids?.map((id) => ({ id: toArrayBuffer(id), type: 'public-key' as const }))
}

/**
 * Creates a discoverable, user-verified passkey and asks for its PRF output
 * at once (CTAP2.0 keys enable hmac-secret only when asked at creation).
 */
export async function createPasskeyWithPrf(options: CreatePasskeyOptions): Promise<CreatedPasskey> {
  requirePasskeys()
  let credential: Credential | null
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: options.rp,
        user: { id: toArrayBuffer(options.userId), name: options.userName, displayName: options.displayName },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -8 },
          { type: 'public-key', alg: -257 },
        ],
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        excludeCredentials: descriptors(options.excludeCredentialIds),
        extensions: {
          credProps: true,
          prf: { eval: { first: toArrayBuffer(options.prfInput) } },
        } as AuthenticationExtensionsClientInputs,
      },
    })
  } catch (error) {
    throw translateCeremonyError(error)
  }
  if (!(credential instanceof PublicKeyCredential)) throw new PasskeyCancelledError()
  const { output, enabled } = prfFirst(credential)
  return { credentialId: new Uint8Array(credential.rawId), prfOutput: output, prfEnabled: enabled }
}

/**
 * A user-verified assertion that evaluates the PRF with `prfInput`. Without
 * `allowCredentialIds` it is discoverable: the user picks any passkey this
 * relying party has, and the user handle says whose it is.
 */
export async function getPasskeyPrf(options: GetPasskeyPrfOptions): Promise<PasskeyPrfAssertion> {
  requirePasskeys()
  let credential: Credential | null
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: options.rpId,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        userVerification: 'required',
        allowCredentials: descriptors(options.allowCredentialIds),
        extensions: { prf: { eval: { first: toArrayBuffer(options.prfInput) } } } as AuthenticationExtensionsClientInputs,
      },
    })
  } catch (error) {
    throw translateCeremonyError(error)
  }
  if (!(credential instanceof PublicKeyCredential)) throw new PasskeyCancelledError()
  const response = credential.response as AuthenticatorAssertionResponse
  return {
    credentialId: new Uint8Array(credential.rawId),
    userHandle: toBytes(response.userHandle),
    prfOutput: prfFirst(credential).output,
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

interface CredentialSignals {
  signalUnknownCredential?: (options: { rpId: string; credentialId: string }) => Promise<void>
  signalAllAcceptedCredentials?: (options: { rpId: string; userId: string; allAcceptedCredentialIds: string[] }) => Promise<void>
}

function signals(): CredentialSignals | null {
  return passkeysAvailable() ? (window.PublicKeyCredential as unknown as CredentialSignals) : null
}

/**
 * Tells the passkey provider this relying party no longer accepts the
 * passkey, so it can hide or drop it (Chrome 132+, Safari 26). Best effort:
 * resolves whether or not the browser supports the signal.
 */
export async function signalUnknownPasskey(rpId: string, credentialId: Uint8Array): Promise<void> {
  try {
    await signals()?.signalUnknownCredential?.({ rpId, credentialId: base64Url(credentialId) })
  } catch {
    // An unsupported or refused signal changes nothing for the app.
  }
}

/** Tells the provider which of this user's passkeys still work here, so it hides the others. Best effort. */
export async function signalAcceptedPasskeys(rpId: string, userId: Uint8Array, credentialIds: Uint8Array[]): Promise<void> {
  try {
    await signals()?.signalAllAcceptedCredentials?.({ rpId, userId: base64Url(userId), allAcceptedCredentialIds: credentialIds.map(base64Url) })
  } catch {
    // As above.
  }
}
