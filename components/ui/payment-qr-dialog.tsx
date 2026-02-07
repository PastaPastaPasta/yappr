'use client'

import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, QrCodeIcon } from '@heroicons/react/24/outline'
import { motion, AnimatePresence } from 'framer-motion'
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
    <Dialog.Root open={isOpen} onOpenChange={onClose}>
      <AnimatePresence>
        {isOpen && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center px-4"
              >
                <Dialog.Content asChild>
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="bg-white dark:bg-gray-900 rounded-2xl p-6 w-[420px] max-w-[90vw] shadow-xl relative"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Dialog.Title className="text-xl font-bold mb-4 flex items-center gap-2">
                      <QrCodeIcon className="h-6 w-6 text-amber-500" />
                      Send {displayName} a tip
                    </Dialog.Title>

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
                  </motion.div>
                </Dialog.Content>
              </motion.div>
            </Dialog.Overlay>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  )
}
