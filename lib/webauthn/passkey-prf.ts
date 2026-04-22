'use client'

import { sha256 } from '@noble/hashes/sha2.js'
import { generatePrfInput } from '@/lib/crypto/auth-vault'

type PrfEvalDescriptor = {
  first: Uint8Array
  second?: Uint8Array
}

type PrfCredentialMap = Record<string, PrfEvalDescriptor>

type BrowserPrfResult = {
  enabled?: boolean
  results?: {
    first?: ArrayBuffer
    second?: ArrayBuffer
  }
}

interface PublicKeyCredentialWithExtensions extends PublicKeyCredential {
  getClientExtensionResults(): AuthenticationExtensionsClientOutputs & {
    prf?: BrowserPrfResult
  }
}

interface PublicKeyCredentialWithAssertionResponse extends PublicKeyCredential {
  response: AuthenticatorAssertionResponse
}

export interface PasskeyCredentialDescriptor {
  credentialId: Uint8Array
  prfInput: Uint8Array
  rpId: string
}

export interface PasskeyPrfAssertionResult {
  credentialId: Uint8Array
  credentialIdHash: Uint8Array
  prfInput: Uint8Array
  prfOutput: Uint8Array
  rpId: string
}

export interface DiscoverablePasskeySelectionResult {
  credentialId: Uint8Array
  credentialIdHash: Uint8Array
  userHandle?: string
  rpId: string
}

export interface EnrollPasskeyOptions {
  identityId: string
  username: string
  displayName: string
  label: string
  rpId?: string
}

export function getDefaultRpId(): string {
  if (typeof window === 'undefined') {
    throw new Error('Passkeys require a browser environment')
  }

  return window.location.hostname
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function extractPrfFirst(result: BrowserPrfResult | undefined): Uint8Array | null {
  if (!result?.results?.first) return null
  return new Uint8Array(result.results.first)
}

function decodeUserHandle(userHandle: ArrayBuffer | null | undefined): string | undefined {
  if (!userHandle) return undefined

  const decoded = new TextDecoder().decode(new Uint8Array(userHandle)).trim()
  return decoded || undefined
}

function ensureBrowserPasskeys(): void {
  if (typeof window === 'undefined' || !window.isSecureContext || !window.PublicKeyCredential) {
    throw new Error('Passkey enrollment requires a secure browser with WebAuthn support.')
  }
}

export async function createPasskeyWithPrf(options: EnrollPasskeyOptions): Promise<PasskeyPrfAssertionResult & { label: string }> {
  ensureBrowserPasskeys()

  const rpId = options.rpId ?? getDefaultRpId()
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const userId = new TextEncoder().encode(options.identityId).slice(0, 64)

  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: {
        id: rpId,
        name: 'Yappr',
      },
      user: {
        id: userId,
        name: options.username,
        displayName: options.displayName,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -8 },
        { type: 'public-key', alg: -257 },
      ],
      timeout: 60000,
      attestation: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
      extensions: {
        prf: {},
      } as AuthenticationExtensionsClientInputs,
    },
  })

  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error('Failed to create passkey credential')
  }

  const createExtensions = (credential as PublicKeyCredentialWithExtensions).getClientExtensionResults()
  if (createExtensions.prf?.enabled === false) {
    throw new Error('This passkey/provider did not enable PRF during registration.')
  }

  const credentialId = new Uint8Array(credential.rawId)
  const prfInput = generatePrfInput()
  const assertion = await getPrfAssertionForCredentials([{ credentialId, prfInput, rpId }])

  return {
    ...assertion,
    label: options.label,
  }
}

export async function getPrfAssertionForCredentials(credentials: PasskeyCredentialDescriptor[]): Promise<PasskeyPrfAssertionResult> {
  ensureBrowserPasskeys()

  if (credentials.length === 0) {
    throw new Error('No passkey credentials available')
  }

  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const rpId = credentials[0].rpId
  const allowCredentials = credentials.map((entry) => ({
    id: toArrayBuffer(entry.credentialId),
    type: 'public-key' as const,
  }))

  const evalByCredential = credentials.reduce<PrfCredentialMap>((accumulator, entry) => {
    accumulator[base64UrlEncode(entry.credentialId)] = { first: entry.prfInput }
    return accumulator
  }, {})

  const credential = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId,
      timeout: 60000,
      userVerification: 'required',
      allowCredentials,
      extensions: {
        prf: {
          evalByCredential,
        },
      } as AuthenticationExtensionsClientInputs,
    },
  })

  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error('Passkey assertion failed')
  }

  const typedCredential = credential as PublicKeyCredentialWithExtensions
  const prfOutput = extractPrfFirst(typedCredential.getClientExtensionResults().prf)
  if (!prfOutput) {
    throw new Error('This passkey/provider did not return PRF output.')
  }

  const credentialId = new Uint8Array(credential.rawId)
  const descriptor = credentials.find((entry) => base64UrlEncode(entry.credentialId) === base64UrlEncode(credentialId))
  if (!descriptor) {
    throw new Error('Selected passkey is not registered for this identity.')
  }

  return {
    credentialId,
    credentialIdHash: sha256(credentialId),
    prfInput: descriptor.prfInput,
    prfOutput,
    rpId: descriptor.rpId,
  }
}

export async function selectDiscoverablePasskey(rpId = getDefaultRpId()): Promise<DiscoverablePasskeySelectionResult> {
  ensureBrowserPasskeys()

  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId,
      timeout: 60000,
      userVerification: 'required',
    },
  })

  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error('Passkey assertion failed')
  }

  const assertionCredential = credential as PublicKeyCredentialWithAssertionResponse
  const credentialId = new Uint8Array(credential.rawId)

  return {
    credentialId,
    credentialIdHash: sha256(credentialId),
    userHandle: decodeUserHandle(assertionCredential.response.userHandle),
    rpId,
  }
}

export function getPasskeyAllowCredentialIds(credentials: PasskeyCredentialDescriptor[]): Uint8Array[] {
  return credentials.map((entry) => new Uint8Array(toArrayBuffer(entry.credentialId)))
}
