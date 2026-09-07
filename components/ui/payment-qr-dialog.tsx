'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { Modal, ModalTitle } from './modal'
import { XMarkIcon, QrCodeIcon } from '@heroicons/react/24/outline'
import { PaymentQRCode } from './payment-qr-code'
import type { ParsedPaymentUri } from '@/lib/types'

interface PaymentQRCodeDialogProps {
  isOpen: boolean
  onClose: () => void
  paymentUri: ParsedPaymentUri | null
  recipientName?: string
  watchForTransaction?: boolean
  onTransactionDetected?: (txid: string, amountDash: number) => void
  onWatchTimeout?: () => void
  onDone?: () => void
}

export function PaymentQRCodeDialog({
  isOpen,
  onClose,
  paymentUri,
  recipientName,
  watchForTransaction = false,
  onTransactionDetected,
  onWatchTimeout,
  onDone
}: PaymentQRCodeDialogProps) {
  if (!paymentUri) return null

  const displayName = recipientName || 'this user'

  return (
    <Modal open={isOpen} onOpenChange={onClose} className="w-[420px] max-w-[90vw]">
                    <ModalTitle className="mb-4">
                      <QrCodeIcon className="h-6 w-6 text-amber-500" />
                      Send {displayName} a tip
                    </ModalTitle>

                    <Dialog.Description className="sr-only">
                      Scan QR code to send a tip to {displayName}
                    </Dialog.Description>

                    <button
                      onClick={onClose}
                      aria-label="Close"
                      className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                    >
                      <XMarkIcon className="h-5 w-5" />
                    </button>

                    <PaymentQRCode
                      paymentUri={paymentUri}
                      size={200}
                      watchForTransaction={watchForTransaction}
                      onTransactionDetected={onTransactionDetected}
                      onWatchTimeout={onWatchTimeout}
                      onDone={onDone}
                    />
    </Modal>
  )
}
