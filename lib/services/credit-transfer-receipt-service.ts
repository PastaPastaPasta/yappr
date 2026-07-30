import { BaseDocumentService } from './document-service'
import { PAYMENT_RECEIPT_DOCUMENT_TYPES, YAPPR_PAYMENT_RECEIPT_CONTRACT_ID } from '../constants'
import bs58 from 'bs58'
import {
  base64ToBytes,
  bytesToBase64QueryOperand,
  identifierToBase58,
  identifierStringToDocumentBytes,
  toUint8Array,
} from './sdk-helpers'
import type { CreditTransferReceipt, CreditTransferReceiptDocument, CreditTransferReceiptReferenceType } from '@/lib/types'

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function transitionHashStringToBytes(value: string): Uint8Array {
  const normalized = value.trim()

  if (/^[0-9a-fA-F]{64}$/.test(normalized)) {
    const bytes = new Uint8Array(normalized.length / 2)
    for (let index = 0; index < normalized.length; index += 2) {
      bytes[index / 2] = parseInt(normalized.slice(index, index + 2), 16)
    }
    return bytes
  }

  if (normalized.includes('+') || normalized.includes('/') || normalized.endsWith('=')) {
    const bytes = base64ToBytes(normalized)
    if (bytes.length === 32) {
      return bytes
    }
  }

  const decoded = bs58.decode(normalized)
  if (decoded.length !== 32) {
    throw new Error('Invalid transition hash: expected 32 bytes')
  }

  return decoded
}

function amountCreditsToDocumentInteger(value: bigint): number {
  const amount = Number(value)
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error('Invalid amountCredits: expected a non-negative safe integer for receipt storage')
  }
  return amount
}

class CreditTransferReceiptService extends BaseDocumentService<CreditTransferReceipt> {
  constructor() {
    super(PAYMENT_RECEIPT_DOCUMENT_TYPES.CREDIT_TRANSFER_RECEIPT, YAPPR_PAYMENT_RECEIPT_CONTRACT_ID)
  }

  isConfigured(): boolean {
    return Boolean(YAPPR_PAYMENT_RECEIPT_CONTRACT_ID)
  }

  private ensureConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error('Payment receipt contract is not configured. Set NEXT_PUBLIC_YAPPR_PAYMENT_RECEIPT_CONTRACT_ID before using receipt-backed credit transfers.')
    }
  }

  protected transformDocument(doc: Record<string, unknown>): CreditTransferReceipt {
    const data = (doc.data || doc) as CreditTransferReceiptDocument

    return {
      id: (doc.$id || doc.id) as string,
      ownerId: (doc.$ownerId || doc.ownerId) as string,
      createdAt: new Date((doc.$createdAt || doc.createdAt) as number),
      recipientId: identifierToBase58(data.recipientId) || '',
      amountCredits: BigInt(data.amountCredits),
      transitionHash: bytesToHex(toUint8Array(data.transitionHash) || new Uint8Array()),
      transitionBytes: toUint8Array(data.transitionBytes) || new Uint8Array(),
      referenceType: data.referenceType,
      referenceId: data.referenceId ? identifierToBase58(data.referenceId) || undefined : undefined,
    }
  }

  async getById(receiptId: string): Promise<CreditTransferReceipt | null> {
    this.ensureConfigured()
    return this.get(receiptId)
  }

  async getByTransitionHash(transitionHash: string): Promise<CreditTransferReceipt | null> {
    this.ensureConfigured()
    const transitionHashBytes = transitionHashStringToBytes(transitionHash)

    const { documents } = await this.query({
      where: [['transitionHash', '==', bytesToBase64QueryOperand(transitionHashBytes)]],
      orderBy: [['transitionHash', 'asc']],
      limit: 1,
    })

    return documents[0] || null
  }

  async createReceipt(
    ownerId: string,
    data: {
      receiptId: string
      recipientId: string
      amountCredits: bigint
      transitionHash: string
      transitionBytes: Uint8Array
      referenceType?: CreditTransferReceiptReferenceType
      referenceId?: string
    }
  ): Promise<CreditTransferReceipt> {
    this.ensureConfigured()

    const existingById = await this.getById(data.receiptId)
    if (existingById) {
      return existingById
    }

    const existingByHash = await this.getByTransitionHash(data.transitionHash)
    if (existingByHash) {
      return existingByHash
    }

    const documentData: Record<string, unknown> = {
      recipientId: identifierStringToDocumentBytes(data.recipientId),
      amountCredits: amountCreditsToDocumentInteger(data.amountCredits),
      transitionHash: transitionHashStringToBytes(data.transitionHash),
      transitionBytes: data.transitionBytes,
    }

    if (data.referenceType) {
      documentData.referenceType = data.referenceType
    }
    if (data.referenceId) {
      documentData.referenceId = identifierStringToDocumentBytes(data.referenceId)
    }

    return this.createWithOptions(ownerId, documentData, {
      documentId: data.receiptId,
    })
  }
}

export const creditTransferReceiptService = new CreditTransferReceiptService()
