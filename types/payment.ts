export type CreditTransferReceiptReferenceType = string

export interface CreditTransferReceiptDocument {
  $id: string
  $ownerId: string
  $createdAt: number
  recipientId: Uint8Array | string
  amountCredits: string
  transitionHash: string
  transitionBytes: Uint8Array | string
  referenceType?: string
  referenceId?: Uint8Array | string
}

export interface CreditTransferReceipt {
  id: string
  ownerId: string
  createdAt: Date
  recipientId: string
  amountCredits: string
  transitionHash: string
  transitionBytes: Uint8Array
  referenceType?: string
  referenceId?: string
}

export type CreditTransferReceiptVerificationStatus = 'verified' | 'pending' | 'invalid' | 'error'

export interface CreditTransferReceiptVerification {
  status: CreditTransferReceiptVerificationStatus
  receiptId: string
  receipt?: CreditTransferReceipt | null
  amountCredits?: string
  senderId?: string
  recipientId?: string
  transitionHash?: string
  error?: string
}
