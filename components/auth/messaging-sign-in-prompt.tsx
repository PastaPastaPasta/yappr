'use client'

import { useId, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ChatBubbleLeftRightIcon, ChevronDownIcon, ExclamationTriangleIcon, WalletIcon } from '@heroicons/react/24/outline'
import { ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import type { MessagingSetupContext } from './set-up-messaging'

const INTRO: Record<MessagingSetupContext, string> = {
  generic: 'Messages, store orders and private feeds are end-to-end encrypted. To use them, sign in with your Dash wallet or your recovery phrase.',
  store: 'Buyers send their shipping details privately. To receive orders, sign in with your Dash wallet or your recovery phrase.',
  'private-feed': 'Private feeds are encrypted. To use them, sign in with your Dash wallet or your recovery phrase.',
}

/**
 * What a private-key session sees when it needs messaging on an App Connect
 * build (D38): messaging keys come from the Dash wallet, so the way in is to
 * sign in with the wallet or its recovery phrase. The old flows, a messaging
 * key made from the sign-in key or one pasted in, sit under "Developer
 * options": messages set up that way can only be read with that same key.
 */
export function MessagingSignInPrompt({
  context,
  hasKey,
  busy,
  onSignIn,
  onDeveloperSetUp,
  onDeveloperEnterKey,
  onCancel,
}: {
  context: MessagingSetupContext
  /** The account already has a messaging key (unlock it) rather than none (set one up). */
  hasKey: boolean
  busy: boolean
  onSignIn: () => void
  onDeveloperSetUp: () => void
  onDeveloperEnterKey: () => void
  onCancel: () => void
}) {
  const advancedId = useId()
  const [advanced, setAdvanced] = useState(false)
  return (
    <>
      <ModalTitle>
        <ChatBubbleLeftRightIcon className="h-6 w-6 text-yappr-500" />
        {hasKey ? 'Unlock messaging' : 'Set up messaging'}
      </ModalTitle>
      <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">{INTRO[context]}</Dialog.Description>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Your messaging key comes from your wallet, so you can read your messages on any device you sign in on.
      </p>
      <div className="flex flex-col gap-3">
        <Button onClick={onSignIn} className="w-full" disabled={busy}>
          <WalletIcon className="h-4 w-4 mr-2" />
          Sign in with wallet or recovery phrase
        </Button>
        <Button onClick={onCancel} variant="ghost" className="w-full" disabled={busy}>Not now</Button>
      </div>

      <div className="mt-6 border-t border-gray-100 dark:border-gray-800 pt-4">
        <button
          type="button"
          aria-expanded={advanced}
          aria-controls={advancedId}
          onClick={() => setAdvanced((open) => !open)}
          className="w-full flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 rounded-md py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yappr-500"
        >
          Advanced: developer options
          <ChevronDownIcon aria-hidden="true" className={`h-4 w-4 transition-transform ${advanced ? 'rotate-180' : ''}`} />
        </button>
        {advanced && (
          <div id={advancedId} className="mt-3 space-y-3" data-testid="messaging-developer-options">
            <div className="bg-amber-50 dark:bg-amber-950 p-3 rounded-lg flex gap-2">
              <ExclamationTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
              <div className="text-sm text-amber-700 dark:text-amber-300 space-y-1">
                <p className="font-medium">For developers. Not for normal use.</p>
                <p>
                  Messaging set up here is made from the private key you signed in with. You can only read those messages
                  again by signing in with this exact key, not with your Dash wallet or recovery phrase.
                </p>
              </div>
            </div>
            {hasKey ? (
              <Button onClick={onDeveloperEnterKey} variant="outline" className="w-full text-sm" disabled={busy}>
                {busy && <Spinner size="xs" className="mr-2" />}
                Unlock with a messaging key
              </Button>
            ) : (
              <Button onClick={onDeveloperSetUp} variant="outline" className="w-full text-sm" disabled={busy}>
                Set up messaging with this sign-in key
              </Button>
            )}
          </div>
        )}
      </div>
    </>
  )
}
