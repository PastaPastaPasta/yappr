import { useCallback, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { SetUpMessaging } from '../../components/auth/set-up-messaging'
import { bindCurrentIdentity } from '@/lib/auth/active-identity'
import { DUMMY_IDENTITY } from './private-feed-mocks'

declare global {
  interface Window {
    messagingReady?: number
    signOut?: () => void
  }
}
window.messagingReady = 0
window.signOut = () => { bindCurrentIdentity(() => null) }

/**
 * The App Connect developer setup, as the encryption dialog hosts it. "Close" aborts the attempt the way the
 * dialog's Close does, but the form stays mounted, as it does while the dialog animates out.
 */
export function SetUpMessagingFixture() {
  const attemptRef = useRef<AbortController | null>(null)
  const [closed, setClosed] = useState(false)
  const beginAttempt = useCallback(() => {
    attemptRef.current?.abort()
    attemptRef.current = new AbortController()
    return attemptRef.current.signal
  }, [])
  const close = () => {
    attemptRef.current?.abort()
    setClosed(true)
  }
  return (
    <Dialog.Root open modal={false}>
      <p data-testid="modal-state">{closed ? 'closed' : 'open'}</p>
      <button type="button" onClick={close}>Close dialog</button>
      <Dialog.Content aria-describedby={undefined}>
        <SetUpMessaging
          identityId={DUMMY_IDENTITY}
          context="generic"
          onDone={() => { window.messagingReady = (window.messagingReady ?? 0) + 1 }}
          onAlreadySetUp={() => undefined}
          onCancel={close}
          beginAttempt={beginAttempt}
        />
      </Dialog.Content>
    </Dialog.Root>
  )
}
