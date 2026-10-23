/** A payment the checkout's watcher saw arrive at the seller's Dash address. */
export interface DetectedPayment {
  txid: string
  amountDash: number
}

/**
 * What the buyer can truthfully be told about payment when the order goes out.
 * The order itself is the same in every case; only its transaction id differs.
 */
export type OrderPaymentStatus =
  | { kind: 'detected'; amountDash: number }
  /** A payment was seen, but the buyer cleared its transaction id, so the order carries none. */
  | { kind: 'detected-not-attached'; amountDash: number }
  | { kind: 'txid-entered' }
  | { kind: 'not-detected' }
  | { kind: 'not-checked' }

export function orderPaymentStatus(args: {
  detected: DetectedPayment | null
  txid: string
  /** Whether the chosen method is one the checkout can watch (Dash). */
  canDetect: boolean
}): OrderPaymentStatus {
  const { detected, txid, canDetect } = args
  const entered = txid.trim()
  // A transaction id the buyer typed over the detected one is theirs to vouch for.
  if (entered && !(detected && entered === detected.txid)) return { kind: 'txid-entered' }
  if (detected) {
    return entered
      ? { kind: 'detected', amountDash: detected.amountDash }
      : { kind: 'detected-not-attached', amountDash: detected.amountDash }
  }
  return canDetect ? { kind: 'not-detected' } : { kind: 'not-checked' }
}

/** DASH to the eight places the watcher reports. */
export function formatDetectedDash(amountDash: number): string {
  return `${amountDash.toFixed(8)} DASH`
}

/** The line under the Place Order button, so placing an order with no payment seen is never a surprise. */
export function placeOrderNote(status: OrderPaymentStatus): string | null {
  switch (status.kind) {
    case 'detected':
      return null
    case 'detected-not-attached':
      return 'A payment was detected, but its transaction ID is cleared above, so the seller won’t see it with this order. Put the ID back to include it.'
    case 'txid-entered':
      return 'Your order will include the transaction ID you entered.'
    case 'not-detected':
      return 'No payment detected yet. You can still place the order, but it will reach the seller without a payment transaction.'
    case 'not-checked':
      return 'Payments with this method aren’t checked automatically. Your order will reach the seller without a payment transaction unless you add one.'
  }
}

/** What the order-placed screen says about payment. */
export function orderPlacedPaymentNote(status: OrderPaymentStatus): string {
  switch (status.kind) {
    case 'detected':
      return `Payment detected: ${formatDetectedDash(status.amountDash)} received at the seller’s address.`
    case 'detected-not-attached':
      return `A payment of ${formatDetectedDash(status.amountDash)} was detected, but this order didn’t include its transaction ID.`
    case 'txid-entered':
      return 'The seller has the transaction ID you entered with this order.'
    case 'not-detected':
      return 'No payment was detected when you placed this order. If you haven’t paid yet, send it to the seller’s payment address.'
    case 'not-checked':
      return 'Payment for this method isn’t checked automatically, and this order didn’t include a transaction ID.'
  }
}
