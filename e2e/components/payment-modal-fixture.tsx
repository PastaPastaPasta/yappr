import { useEffect } from 'react'
import { BuyYappModal } from '@/components/token/buy-yapp-modal'
import { TipModal } from '@/components/post/tip-modal'
import { useBuyYappModal } from '@/hooks/use-buy-yapp-modal'
import { useTipModal } from '@/hooks/use-tip-modal'

const openTip = () => useTipModal.getState().openForUser({ id: 'component-test-recipient', username: 'recipient.dash' })

declare global {
  interface Window {
    openTipModal?: () => void
  }
}
window.openTipModal = openTip

/** The buy-YAPP or tip modal, open for the signed-in (mocked) identity against mocked payment services. */
export function PaymentModalFixture({ modal, signing }: { modal: 'buy' | 'tip'; signing: 'local' | 'wallet' }) {
  useEffect(() => {
    if (modal === 'buy') useBuyYappModal.getState().open(undefined, signing)
    else openTip()
  }, [modal, signing])
  return modal === 'buy' ? <BuyYappModal /> : <TipModal />
}
