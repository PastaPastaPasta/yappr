import { describe, expect, it } from 'vitest'
import { orderPaymentStatus, orderPlacedPaymentNote, placeOrderNote, formatDetectedDash } from './checkout-payment'

const detected = { txid: 'abc123', amountDash: 0.5 }

describe('orderPaymentStatus', () => {
  it('reports a detected payment whose txid filled the field', () => {
    expect(orderPaymentStatus({ detected, txid: 'abc123', canDetect: true })).toEqual({ kind: 'detected', amountDash: 0.5 })
  })

  it('says so when the buyer cleared the detected txid, since the order will carry none', () => {
    expect(orderPaymentStatus({ detected, txid: '  ', canDetect: true })).toEqual({ kind: 'detected-not-attached', amountDash: 0.5 })
  })

  it('treats a txid typed over the detected one as the buyer’s own', () => {
    expect(orderPaymentStatus({ detected, txid: 'other', canDetect: true })).toEqual({ kind: 'txid-entered' })
  })

  it('reports a typed txid when nothing was detected', () => {
    expect(orderPaymentStatus({ detected: null, txid: 'abc', canDetect: false })).toEqual({ kind: 'txid-entered' })
  })

  it('separates a watched method with nothing seen from one that is not watched', () => {
    expect(orderPaymentStatus({ detected: null, txid: '', canDetect: true })).toEqual({ kind: 'not-detected' })
    expect(orderPaymentStatus({ detected: null, txid: '', canDetect: false })).toEqual({ kind: 'not-checked' })
  })
})

describe('checkout payment copy', () => {
  it('says nothing extra before an order with a detected payment', () => {
    expect(placeOrderNote({ kind: 'detected', amountDash: 0.5 })).toBeNull()
  })

  it('labels an order placed without a detected payment', () => {
    expect(placeOrderNote({ kind: 'not-detected' })).toMatch(/No payment detected yet/)
    expect(placeOrderNote({ kind: 'not-checked' })).toMatch(/aren’t checked automatically/)
  })

  it('confirms a detected payment with its amount', () => {
    expect(orderPlacedPaymentNote({ kind: 'detected', amountDash: 0.5 })).toBe('Payment detected: 0.50000000 DASH received at the seller’s address.')
  })

  it('never claims a payment on an order that had none detected', () => {
    for (const status of [{ kind: 'not-detected' }, { kind: 'not-checked' }, { kind: 'txid-entered' }] as const) {
      expect(orderPlacedPaymentNote(status)).not.toMatch(/Payment detected/)
    }
  })

  it('does not claim the payment is attached when the txid was cleared', () => {
    const status = { kind: 'detected-not-attached', amountDash: 0.5 } as const
    expect(orderPlacedPaymentNote(status)).toMatch(/didn’t include its transaction ID/)
    expect(placeOrderNote(status)).toMatch(/won’t see it/)
  })

  it('formats the amount to eight places', () => {
    expect(formatDetectedDash(1.5)).toBe('1.50000000 DASH')
  })
})
