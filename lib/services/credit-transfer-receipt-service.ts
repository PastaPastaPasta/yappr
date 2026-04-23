import { BaseDocumentService } from './document-service'
import { PAYMENT_RECEIPT_DOCUMENT_TYPES, YAPPR_PAYMENT_RECEIPT_CONTRACT_ID } from '../constants'
import { identifierToBase58, identifierStringToDocumentBytes, toUint8Array } from './sdk-helpers'
import type { CreditTransferReceipt, CreditTransferReceiptDocument, CreditTransferReceiptReferenceType } from '@/lib/types'

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
      amountCredits: data.amountCredits,
      transitionHash: data.transitionHash,
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

    const { documents } = await this.query({
      where: [['transitionHash', '==', transitionHash]],
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
      amountCredits: string
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
      amountCredits: data.amountCredits,
      transitionHash: data.transitionHash,
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
