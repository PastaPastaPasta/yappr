import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { FrameGuard } from '@/components/layout/frame-guard'
import { PaymentSelector } from '@/components/checkout/payment-selector'
import { PaymentQRCode } from '@/components/ui/payment-qr-code'
import type { ParsedPaymentUri } from '@/lib/types'

const unsafe = { scheme: 'dash:', label: 'Verified Dash payment', uri: 'javascript:document.body.textContent="SECURITY_QA_EXECUTED"' }
const bitcoin = { scheme: 'dash:', label: 'Verified Dash payment', uri: 'bitcoin:1BoatSLRHtKNngkdXEeobR76b53LETtpyT' }
function PaymentFixture() {
  const [selected, setSelected] = useState<ParsedPaymentUri | null>(unsafe)
  return <>
    <PaymentSelector paymentUris={[unsafe, { scheme: 'dash:', uri: 'data:text/html,SECURITY_QA' }, bitcoin]}
      selected={selected} onSelect={setSelected} txid="" onTxidChange={() => {}}
      detectedPayment={null} onDetectedPaymentChange={() => {}} onContinue={() => {}} />
    <div data-testid="unsafe-qr"><PaymentQRCode paymentUri={unsafe} /></div>
  </>
}
function GuardedContent() {
  const [draft, setDraft] = useState('')
  return <>
    <button>Sign In</button><input type="password" aria-label="Private key" />
    <input aria-label="Draft" value={draft} onChange={event => setDraft(event.target.value)} />
    <button onClick={() => { history.pushState({}, '', '/feed/'); window.dispatchEvent(new PopStateEvent('popstate')) }}>Navigate</button>
  </>
}
const root = document.getElementById('root')
if (!root) throw new Error('Missing fixture root')
createRoot(root).render(new URLSearchParams(location.search).has('payments') ? <PaymentFixture /> : (
  <FrameGuard basePath={new URLSearchParams(location.search).get('base') ?? ''}>
    <GuardedContent />
  </FrameGuard>
))
