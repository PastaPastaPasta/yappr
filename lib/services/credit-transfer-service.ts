import bs58 from 'bs58'
import * as EvoSdkModule from '@dashevo/evo-sdk'
import {
  IdentityCreditTransfer,
  PrivateKey,
  StateTransition,
} from '@dashevo/evo-sdk'
import type { IdentityPublicKey as WasmIdentityPublicKey } from '@dashevo/wasm-sdk/compressed'

import { logger } from '@/lib/logger'
import { extractErrorMessage, isAlreadyExistsError, isNonFatalWaitError, isTimeoutError } from '@/lib/error-utils'
import type {
  CreditTransferReceiptReferenceType,
  CreditTransferReceiptVerification,
} from '@/lib/types'
import { findMatchingKeyIndex, type IdentityPublicKeyInfo } from '@/lib/crypto/keys'
import { getEvoSdk } from './evo-sdk-service'
import { identityService } from './identity-service'
import { KeyPurpose } from './signer-service'
import { creditTransferReceiptService } from './credit-transfer-receipt-service'

export interface CreditTransferOptions {
  senderId: string
  recipientId: string
  amountCredits: bigint
  transferKeyWif: string
  keyId?: number
  referenceType?: CreditTransferReceiptReferenceType
  referenceId?: string
}

export interface CreditTransferVerificationOptions {
  expectedSenderId?: string
  expectedRecipientId?: string
  expectedAmountCredits?: string
  expectedReferenceType?: CreditTransferReceiptReferenceType
  expectedReferenceId?: string
}

export interface CreditTransferResult {
  success: boolean
  transitionHash?: string
  receiptId?: string
  receiptConfirmed?: boolean
  verificationStatus?: 'verified' | 'pending'
  senderBalance?: bigint
  recipientBalance?: bigint
  error?: string
}

interface PendingCreditTransferEntry {
  receiptId: string
  transitionHash: string
  senderId: string
  recipientId: string
  amountCredits: string
  transitionBytes: string
  referenceType?: string
  referenceId?: string
  cachedAt: number
}

interface IdentityCreditTransferTransitionFactory {
  fromObject(obj: {
    amount: bigint
    senderId: Uint8Array
    recipientId: Uint8Array
    nonce: bigint
    userFeeIncrease: number
    signature?: Uint8Array
    signaturePublicKeyId?: number
  }): IdentityCreditTransfer
}

interface VerifiedBalanceTransferLike {
  __type: 'VerifiedBalanceTransfer'
  sender: {
    id: { toString(): string }
    balance?: bigint
  }
  recipient: {
    id: { toString(): string }
    balance?: bigint
  }
}

const identityCreditTransferTransitionFactory = (
  EvoSdkModule as unknown as {
    IdentityCreditTransferTransition: IdentityCreditTransferTransitionFactory
  }
).IdentityCreditTransferTransition

function isVerifiedBalanceTransfer(result: unknown): result is VerifiedBalanceTransferLike {
  if (!result || typeof result !== 'object') {
    return false
  }

  const candidate = result as {
    __type?: unknown
    sender?: unknown
    recipient?: unknown
  }

  return (
    candidate.__type === 'VerifiedBalanceTransfer' &&
    candidate.sender !== undefined &&
    candidate.recipient !== undefined
  )
}

const PENDING_TRANSFER_PREFIX = 'yappr:pending-credit-transfer:'
const PENDING_TRANSFER_MAX_AGE_MS = 24 * 60 * 60 * 1000
const PENDING_TRANSFER_MAX_ENTRIES = 50

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digestInput = Uint8Array.from(bytes).buffer
  const digest = await crypto.subtle.digest('SHA-256', digestInput)
  return new Uint8Array(digest)
}

function pendingTransferKey(transitionHash: string): string {
  return `${PENDING_TRANSFER_PREFIX}${transitionHash}`
}

function savePendingTransfer(entry: PendingCreditTransferEntry): void {
  if (typeof window === 'undefined') return

  try {
    localStorage.setItem(pendingTransferKey(entry.transitionHash), JSON.stringify(entry))
  } catch (error) {
    logger.warn('Failed to cache pending credit transfer', error)
  }
}

function clearPendingTransfer(transitionHash: string): void {
  if (typeof window === 'undefined') return

  try {
    localStorage.removeItem(pendingTransferKey(transitionHash))
  } catch {
    // Ignore cache cleanup errors.
  }
}

function cleanupPendingTransfers(): void {
  if (typeof window === 'undefined') return

  try {
    const now = Date.now()
    const keys: string[] = []
    const entries: Array<{ key: string; cachedAt: number }> = []

    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key?.startsWith(PENDING_TRANSFER_PREFIX)) {
        keys.push(key)
      }
    }

    for (const key of keys) {
      const raw = localStorage.getItem(key)
      if (!raw) continue

      try {
        const parsed = JSON.parse(raw) as PendingCreditTransferEntry
        if (!parsed.cachedAt || now - parsed.cachedAt > PENDING_TRANSFER_MAX_AGE_MS) {
          localStorage.removeItem(key)
          continue
        }
        entries.push({ key, cachedAt: parsed.cachedAt })
      } catch {
        localStorage.removeItem(key)
      }
    }

    if (entries.length > PENDING_TRANSFER_MAX_ENTRIES) {
      entries.sort((a, b) => a.cachedAt - b.cachedAt)
      for (let index = 0; index < entries.length - PENDING_TRANSFER_MAX_ENTRIES; index += 1) {
        localStorage.removeItem(entries[index].key)
      }
    }
  } catch {
    // Ignore cleanup errors.
  }
}

function listPendingTransfers(senderId?: string): PendingCreditTransferEntry[] {
  if (typeof window === 'undefined') return []

  cleanupPendingTransfers()

  const results: PendingCreditTransferEntry[] = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (!key?.startsWith(PENDING_TRANSFER_PREFIX)) continue

    const raw = localStorage.getItem(key)
    if (!raw) continue

    try {
      const parsed = JSON.parse(raw) as PendingCreditTransferEntry
      if (!senderId || parsed.senderId === senderId) {
        results.push(parsed)
      }
    } catch {
      localStorage.removeItem(key)
    }
  }

  return results
}

function updatePendingTransfer(entry: PendingCreditTransferEntry): void {
  savePendingTransfer(entry)
}

class CreditTransferService {
  private verificationCache = new Map<string, Promise<CreditTransferReceiptVerification>>()

  private findMatchingTransferKey(
    privateKeyWif: string,
    wasmPublicKeys: WasmIdentityPublicKey[],
    specificKeyId?: number
  ): WasmIdentityPublicKey | null {
    const network = (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet'
    const activeKeys = wasmPublicKeys.filter((key) => !key.disabledAt)
    const transferKeys = activeKeys.filter((key) => key.purposeNumber === KeyPurpose.TRANSFER)

    if (transferKeys.length === 0) {
      return null
    }

    const keyInfos: IdentityPublicKeyInfo[] = transferKeys.map((key) => {
      const dataHex = key.data
      const data = new Uint8Array(dataHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) || [])

      return {
        id: key.keyId,
        type: key.keyTypeNumber,
        purpose: key.purposeNumber,
        securityLevel: key.securityLevelNumber,
        data,
      }
    })

    const match = findMatchingKeyIndex(privateKeyWif, keyInfos, network)
    if (!match) {
      return null
    }

    if (specificKeyId !== undefined && match.keyId !== specificKeyId) {
      return null
    }

    return transferKeys.find((key) => key.keyId === match.keyId) || null
  }

  private async deriveReceiptId(transitionBytes: Uint8Array): Promise<string> {
    const digest = await sha256(transitionBytes)
    return bs58.encode(digest)
  }

  private async buildSignedTransfer(options: CreditTransferOptions): Promise<{
    stateTransition: StateTransition
    transitionHash: string
    transitionBytes: Uint8Array
    receiptId: string
  }> {
    const sdk = await getEvoSdk()
    const identity = await sdk.identities.fetch(options.senderId)

    if (!identity) {
      throw new Error('Sender identity not found')
    }

    const transferKey = this.findMatchingTransferKey(
      options.transferKeyWif.trim(),
      identity.publicKeys,
      options.keyId
    )
    if (!transferKey) {
      throw new Error('No matching transfer key found. The provided private key does not match any transfer key on this identity.')
    }

    const currentNonce = await sdk.identities.nonce(options.senderId)
    if (currentNonce === null || currentNonce === undefined) {
      throw new Error('Failed to fetch identity nonce')
    }

    const transfer = identityCreditTransferTransitionFactory.fromObject({
      amount: options.amountCredits,
      senderId: bs58.decode(options.senderId),
      recipientId: bs58.decode(options.recipientId),
      nonce: currentNonce + BigInt(1),
      userFeeIncrease: 0,
    })

    const stateTransition = transfer.toStateTransition()
    const privateKey = PrivateKey.fromWIF(options.transferKeyWif.trim())
    stateTransition.sign(privateKey, transferKey)

    const signedTransfer = IdentityCreditTransfer.fromStateTransition(stateTransition)
    const transitionBytes = signedTransfer.toBytes()
    const transitionHash = stateTransition.hash(false)
    const receiptId = await this.deriveReceiptId(transitionBytes)

    return {
      stateTransition,
      transitionHash,
      transitionBytes,
      receiptId,
    }
  }

  async send(options: CreditTransferOptions): Promise<CreditTransferResult> {
    if (!creditTransferReceiptService.isConfigured()) {
      return {
        success: false,
        error: 'Payment receipt contract is not configured',
      }
    }

    if (options.senderId === options.recipientId) {
      return { success: false, error: 'Cannot transfer credits to the same identity' }
    }

    const amountCreditsString = options.amountCredits.toString()

    try {
      const balance = await identityService.getBalance(options.senderId)
      if (BigInt(balance.confirmed) < options.amountCredits) {
        return { success: false, error: 'Insufficient balance' }
      }

      const {
        stateTransition,
        transitionHash,
        transitionBytes,
        receiptId,
      } = await this.buildSignedTransfer(options)

      const pendingEntry: PendingCreditTransferEntry = {
        receiptId,
        transitionHash,
        senderId: options.senderId,
        recipientId: options.recipientId,
        amountCredits: amountCreditsString,
        transitionBytes: bytesToBase64(transitionBytes),
        referenceType: options.referenceType,
        referenceId: options.referenceId,
        cachedAt: Date.now(),
      }
      savePendingTransfer(pendingEntry)

      const sdk = await getEvoSdk()

      try {
        await sdk.stateTransitions.broadcastStateTransition(stateTransition)
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error
        }
      }

      let receiptConfirmed = false
      let receiptAvailable = false
      try {
        const receipt = await creditTransferReceiptService.createReceipt(options.senderId, {
          receiptId,
          recipientId: options.recipientId,
          amountCredits: amountCreditsString,
          transitionHash,
          transitionBytes,
          referenceType: options.referenceType,
          referenceId: options.referenceId,
        })

        receiptAvailable = true
        receiptConfirmed = true
        updatePendingTransfer({
          ...pendingEntry,
          receiptId: receipt.id,
        })
      } catch (error) {
        logger.warn('Receipt document creation failed; pending transfer retained for recovery', error)
      }

      try {
        const proofResult = await sdk.stateTransitions.waitForResponse(stateTransition)
        if (!isVerifiedBalanceTransfer(proofResult)) {
          return {
            success: true,
            transitionHash,
            receiptId,
            receiptConfirmed,
            verificationStatus: 'pending',
          }
        }

        if (receiptAvailable) {
          clearPendingTransfer(transitionHash)
        }
        identityService.clearCache(options.senderId)

        return {
          success: true,
          transitionHash,
          receiptId,
          receiptConfirmed,
          verificationStatus: 'verified',
          senderBalance: proofResult.sender.balance ?? undefined,
          recipientBalance: proofResult.recipient.balance ?? undefined,
        }
      } catch (error) {
        if (isTimeoutError(error) || isAlreadyExistsError(error) || isNonFatalWaitError(error)) {
          identityService.clearCache(options.senderId)
          return {
            success: true,
            transitionHash,
            receiptId,
            receiptConfirmed,
            verificationStatus: 'pending',
          }
        }

        throw error
      }
    } catch (error) {
      logger.error('Credit transfer send failed', error)
      return {
        success: false,
        error: extractErrorMessage(error),
      }
    }
  }

  async recoverPendingTransfers(senderId?: string): Promise<void> {
    if (!creditTransferReceiptService.isConfigured()) {
      return
    }

    const pendingTransfers = listPendingTransfers(senderId)
    if (pendingTransfers.length === 0) {
      return
    }

    const sdk = await getEvoSdk()

    for (const entry of pendingTransfers) {
      try {
        const transitionBytes = base64ToBytes(entry.transitionBytes)
        const transfer = IdentityCreditTransfer.fromBytes(transitionBytes)
        const stateTransition = transfer.toStateTransition()
        let receiptAvailable = false

        try {
          await sdk.stateTransitions.broadcastStateTransition(stateTransition)
        } catch (error) {
          if (!isAlreadyExistsError(error)) {
            throw error
          }
        }

        try {
          await creditTransferReceiptService.createReceipt(entry.senderId, {
            receiptId: entry.receiptId,
            recipientId: entry.recipientId,
            amountCredits: entry.amountCredits,
            transitionHash: entry.transitionHash,
            transitionBytes,
            referenceType: entry.referenceType,
            referenceId: entry.referenceId,
          })
          receiptAvailable = true
        } catch (error) {
          logger.warn('Pending receipt publication still failing', error)
        }

        try {
          const proofResult = await sdk.stateTransitions.waitForResponse(stateTransition)
          if (isVerifiedBalanceTransfer(proofResult) && receiptAvailable) {
            clearPendingTransfer(entry.transitionHash)
          }
        } catch (error) {
          if (!isTimeoutError(error) && !isAlreadyExistsError(error) && !isNonFatalWaitError(error)) {
            logger.warn('Pending receipt verification failed', error)
          }
        }
      } catch (error) {
        logger.warn('Failed to recover pending credit transfer', error)
      }
    }
  }

  async verifyReceipt(
    receiptId: string,
    options: CreditTransferVerificationOptions = {}
  ): Promise<CreditTransferReceiptVerification> {
    const cacheKey = JSON.stringify({ receiptId, ...options })
    const cached = this.verificationCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const verificationPromise = this.verifyReceiptUncached(receiptId, options)
      .finally(() => {
        this.verificationCache.delete(cacheKey)
      })
    this.verificationCache.set(cacheKey, verificationPromise)
    return verificationPromise
  }

  private async verifyReceiptUncached(
    receiptId: string,
    options: CreditTransferVerificationOptions
  ): Promise<CreditTransferReceiptVerification> {
    if (!creditTransferReceiptService.isConfigured()) {
      return {
        status: 'error',
        receiptId,
        error: 'Payment receipt contract is not configured',
      }
    }

    try {
      const receipt = await creditTransferReceiptService.getById(receiptId)
      if (!receipt) {
        return {
          status: 'pending',
          receiptId,
          receipt: null,
        }
      }

      const transfer = IdentityCreditTransfer.fromBytes(receipt.transitionBytes)
      const stateTransition = transfer.toStateTransition()
      const transitionHash = stateTransition.hash(false)
      const senderId = transfer.senderId.toString()
      const recipientId = transfer.recipientId.toString()
      const amountCredits = transfer.amount.toString()

      if (receipt.ownerId !== senderId) {
        return { status: 'invalid', receiptId, receipt, error: 'Receipt owner does not match transfer sender' }
      }
      if (receipt.recipientId !== recipientId) {
        return { status: 'invalid', receiptId, receipt, error: 'Receipt recipient does not match transfer recipient' }
      }
      if (receipt.amountCredits !== amountCredits) {
        return { status: 'invalid', receiptId, receipt, error: 'Receipt amount does not match transfer amount' }
      }
      if (receipt.transitionHash !== transitionHash) {
        return { status: 'invalid', receiptId, receipt, error: 'Receipt hash does not match signed transition hash' }
      }
      if (options.expectedSenderId && options.expectedSenderId !== senderId) {
        return { status: 'invalid', receiptId, receipt, error: 'Unexpected transfer sender' }
      }
      if (options.expectedRecipientId && options.expectedRecipientId !== recipientId) {
        return { status: 'invalid', receiptId, receipt, error: 'Unexpected transfer recipient' }
      }
      if (options.expectedAmountCredits && options.expectedAmountCredits !== amountCredits) {
        return { status: 'invalid', receiptId, receipt, error: 'Unexpected transfer amount' }
      }
      if (options.expectedReferenceType && receipt.referenceType !== options.expectedReferenceType) {
        return { status: 'invalid', receiptId, receipt, error: 'Unexpected receipt reference type' }
      }
      if (options.expectedReferenceId && receipt.referenceId !== options.expectedReferenceId) {
        return { status: 'invalid', receiptId, receipt, error: 'Unexpected receipt reference ID' }
      }

      try {
        const sdk = await getEvoSdk()
        const proofResult = await sdk.stateTransitions.waitForResponse(stateTransition)
        if (!isVerifiedBalanceTransfer(proofResult)) {
          return {
            status: 'pending',
            receiptId,
            receipt,
            amountCredits,
            senderId,
            recipientId,
            transitionHash,
          }
        }

        const provedSenderId = proofResult.sender.id.toString()
        const provedRecipientId = proofResult.recipient.id.toString()
        if (provedSenderId !== senderId || provedRecipientId !== recipientId) {
          return { status: 'invalid', receiptId, receipt, error: 'Verified proof identities do not match the signed transfer' }
        }

        return {
          status: 'verified',
          receiptId,
          receipt,
          amountCredits,
          senderId,
          recipientId,
          transitionHash,
        }
      } catch (error) {
        if (isTimeoutError(error) || isAlreadyExistsError(error) || isNonFatalWaitError(error)) {
          return {
            status: 'pending',
            receiptId,
            receipt,
            amountCredits,
            senderId,
            recipientId,
            transitionHash,
          }
        }

        return {
          status: 'error',
          receiptId,
          receipt,
          amountCredits,
          senderId,
          recipientId,
          transitionHash,
          error: extractErrorMessage(error),
        }
      }
    } catch (error) {
      return {
        status: 'error',
        receiptId,
        error: extractErrorMessage(error),
      }
    }
  }
}

export const creditTransferService = new CreditTransferService()
