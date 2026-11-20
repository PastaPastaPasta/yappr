'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { KeyExchangeQR } from '@/components/auth/key-exchange-qr'
import { heldRequestMessage, type ShownPaymentRequest } from '@/lib/services/wallet-payment-request'

/** The unpaid wallet request holding a new payment back, with its QR one tap away. */
export function HeldPaymentRequest({ request }: { request: ShownPaymentRequest }) {
  const [shown, setShown] = useState(false)
  return (
    <div className="space-y-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-3">
      <p className="text-sm text-amber-800 dark:text-amber-200">{heldRequestMessage(request)}</p>
      {shown ? (
        <KeyExchangeQR uri={request.uri} size={200} />
      ) : (
        <Button onClick={() => setShown(true)} variant="outline" className="w-full">
          Show it again
        </Button>
      )}
    </div>
  )
}
