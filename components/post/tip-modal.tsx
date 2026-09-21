'use client'

import { logger } from '@/lib/logger';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { XMarkIcon, CurrencyDollarIcon, QrCodeIcon, WalletIcon, ChevronDownIcon, SparklesIcon } from '@heroicons/react/24/outline'
import { CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/24/solid'
import { buildYapprStateTransitionUri } from 'platform-auth'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { KeyExchangeQR } from '@/components/auth/key-exchange-qr'
import { useTipModal } from '@/hooks/use-tip-modal'
import { useAuth } from '@/contexts/auth-context'
import { tipService } from '@/lib/services/tip-service'
import { tipHistoryService, matchesSentTip, type SentTipMatch } from '@/lib/services/tip-history-service'
import { tokenService } from '@/lib/services/token-service'
import { buildUnsignedYappTipTransition } from '@/lib/services/token-transfer-builder'
import { MIN_YAPP_TIP, getConfiguredNetwork } from '@/lib/constants'
import { TIP_MESSAGE_MAX_LENGTH, type TipTargetKind } from '@/lib/tip-note'
import { targetKindOf } from '@/lib/contract-topology'
import { PaymentSchemeIcon, getPaymentLabel, truncateAddress, PAYMENT_SCHEME_LABELS } from '@/components/ui/payment-icons'
import { PaymentQRCodeDialog } from '@/components/ui/payment-qr-dialog'
import type { ParsedPaymentUri } from '@/lib/types'

// Preset tip amounts, in whole YAPP.
const YAPP_PRESETS = [1, 5, 25, 100]

// How long the dash-st: QR stays valid before the flow gives up waiting for
// the wallet. Matches the buy-YAPP flow's window.
const WALLET_SIGN_TIMEOUT_MS = 300000
// Slack between this browser's clock and the chain's when deciding whether a
// transfer document is "ours" (created after the QR went up).
const CLOCK_SKEW_MARGIN_MS = 60000

type ModalState =
  | 'input'
  | 'confirming'
  | 'needKey'
  | 'walletSign'
  | 'processing'
  | 'confirming-landed'
  | 'attaching'
  | 'success'
  | 'attach-failed'
  | 'unconfirmed'
  | 'error'
type PaymentTab = 'yapp' | 'crypto'

/** The tip flow's primary-action styling, on every step that has one. */
const AMBER_BUTTON = 'flex-1 bg-amber-500 hover:bg-amber-600 text-white'
const AMBER_BUTTON_WIDE = 'w-full bg-amber-500 hover:bg-amber-600 text-white'

// Only these steps retitle the modal; every other one is still "Send Tip".
const MODAL_TITLES: Partial<Record<ModalState, string>> = {
  success: 'Tip Sent!',
  error: 'Transfer Failed',
}

interface AmountPresetsProps {
  presets: number[]
  /** The amount currently in the input, as typed. */
  value: string
  onSelect: (preset: string) => void
}

/** The row of quick-pick amount chips. */
function AmountPresets({ presets, value, onSelect }: AmountPresetsProps) {
  return (
    <div className="flex gap-2 overflow-x-auto">
      {presets.map((preset) => (
        <button
          key={preset}
          onClick={() => onSelect(preset.toString())}
          className={`px-2.5 py-1.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap ${
            value === preset.toString()
              ? 'bg-amber-500 text-white'
              : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
          }`}
        >
          {preset} YAPP
        </button>
      ))}
    </div>
  )
}

export function TipModal() {
  const { isOpen, post, recipient, close } = useTipModal()
  const { user, refreshBalance } = useAuth()

  // Derive recipient info from either post.author or direct recipient
  const recipientInfo = useMemo(() => {
    if (post) {
      return {
        id: post.author.id,
        displayName: post.author.displayName,
        username: post.author.username,
      }
    }
    if (recipient) {
      return recipient
    }
    return null
  }, [post, recipient])

  // What the tip's public note names, so the proof can be found again. Only a
  // post/reply tip has one; a profile tip transfers YAPP with no target.
  const tipTarget = useMemo<{ kind: TipTargetKind; id: string } | undefined>(
    () => (post ? { kind: targetKindOf(post), id: post.id } : undefined),
    [post]
  )

  const [yappAmount, setYappAmount] = useState('1')
  const [tipMessage, setTipMessage] = useState('')
  const [state, setState] = useState<ModalState>('input')
  const [error, setError] = useState<string | null>(null)
  const [loadingBalance, setLoadingBalance] = useState(false)
  const [yappBalance, setYappBalance] = useState<bigint | null>(null)
  // Whether this browser holds a CRITICAL key for the tipper. Token
  // transitions need one; without it the tip has to go out to the wallet.
  const [canSignLocally, setCanSignLocally] = useState<boolean | null>(null)
  const [criticalKeyWif, setCriticalKeyWif] = useState('')
  const [showKeyEntry, setShowKeyEntry] = useState(false)

  // Payment URI support
  const [paymentUris, setPaymentUris] = useState<ParsedPaymentUri[]>([])
  const [activeTab, setActiveTab] = useState<PaymentTab>('yapp')
  const [selectedQrPayment, setSelectedQrPayment] = useState<ParsedPaymentUri | null>(null)
  const [showQrDialog, setShowQrDialog] = useState(false)

  // Remote wallet signing (dash-st: QR): the unsigned transfer URI, whether the
  // silent wait ran out, and the moment the QR went up — the tip is detected by
  // its own `transfer` document appearing on chain after that moment.
  // The transfer whose tip could not be attached, so the retry cites the same
  // one rather than sending anything new.
  const [attachTransferId, setAttachTransferId] = useState<string | null>(null)
  const [walletUri, setWalletUri] = useState<string | null>(null)
  const [walletExpired, setWalletExpired] = useState(false)
  const walletMatchRef = useRef<SentTipMatch | null>(null)
  const walletSessionRef = useRef(0)

  // Fetch the tipper's YAPP balance when the modal opens
  useEffect(() => {
    if (isOpen && user) {
      setLoadingBalance(true)
      const identityId = user.identityId
      tokenService.getBalance(identityId)
        .then(setYappBalance)
        .catch(() => setYappBalance(null))
        .finally(() => setLoadingBalance(false))
    }
  }, [isOpen, user])

  // Fetch recipient's payment URIs when modal opens
  useEffect(() => {
    if (isOpen && recipientInfo) {
      import('@/lib/services/unified-profile-service')
        .then(({ unifiedProfileService }) => unifiedProfileService.getPaymentUris(recipientInfo.id))
        .then(uris => setPaymentUris(uris))
        .catch(() => setPaymentUris([]))
    }
  }, [isOpen, recipientInfo])

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setYappAmount('1')
      setTipMessage('')
      setState('input')
      setError(null)
      setActiveTab('yapp')
      setPaymentUris([])
      setSelectedQrPayment(null)
      setShowQrDialog(false)
      setCriticalKeyWif('')
      setShowKeyEntry(false)
      setAttachTransferId(null)
      setWalletUri(null)
      setWalletExpired(false)
      setYappBalance(null)
      setCanSignLocally(null)
      walletMatchRef.current = null
      walletSessionRef.current++
    }
  }, [isOpen])

  const yappAmountBig = /^\d+$/.test(yappAmount) ? BigInt(yappAmount) : BigInt(0)
  // The text that rides along in the tip note, normalised once: the note that
  // gets signed and the match used to find it again must never disagree.
  const noteMessage = tipMessage.trim() || undefined

  const handleYappAmountChange = (value: string) => {
    if (/^\d*$/.test(value)) {
      setYappAmount(value)
      setError(null)
    }
  }

  const handleContinue = () => {
    if (yappAmountBig < MIN_YAPP_TIP) {
      setError(`Minimum tip is ${MIN_YAPP_TIP.toString()} YAPP`)
      return
    }
    if (yappBalance !== null && yappAmountBig > yappBalance) {
      setError('Not enough YAPP for this tip')
      return
    }
    // Probed here rather than on open: it costs an identity fetch, and a user
    // who only wanted the crypto tab should never pay for it.
    if (user && canSignLocally === null) {
      tokenService.canSignTokenTransitions(user.identityId)
        .then(setCanSignLocally)
        .catch(() => setCanSignLocally(false))
    }
    setState('confirming')
    setError(null)
  }

  // Shared tail of both YAPP paths: refresh balances and drop the cached
  // transfer pages so the next read sees the new one.
  const finishYappTip = useCallback(() => {
    if (user) tokenService.getBalance(user.identityId).then(setYappBalance).catch(() => {})
    // The transfer also burned a little DASH in fees, so the credit balance the
    // auth context caches is stale too.
    refreshBalance().catch(err => logger.error('Failed to refresh balance:', err))
    tipHistoryService.clearCache()
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('yapp-balance-changed'))
    setState('success')
  }, [user, refreshBalance])

  /**
   * Put the tip on the post: the message becomes a reply, and a tip document
   * cites the transfer that paid for it.
   *
   * This is the step that makes the tip visible — the transfer alone moves YAPP
   * and says nothing about any post. It can fail on its own (the reply is a
   * separate write, and a tip naming a transfer Drive has not indexed yet is
   * refused), and when it does the money is still gone, so the failure screen
   * offers to attach the tip again and never to send another.
   */
  const attachTip = useCallback(async (transferId: string): Promise<boolean> => {
    if (!user || !recipientInfo || !post || !tipTarget) return false
    setState('attaching')

    let messageReplyId: string | undefined
    if (noteMessage) {
      try {
        const { replyService } = await import('@/lib/services/reply-service')
        const { replyLinkageTo } = await import('@/lib/contract-topology')
        const reply = await replyService.createReply(user.identityId, noteMessage, {
          ...replyLinkageTo(post),
          parentOwnerId: post.author.id,
        })
        // A reply the chain has not acknowledged cannot be cited yet: the tip
        // would be a paid rejection. Record the tip without it rather than lose
        // the tip as well as the words.
        messageReplyId = (reply as { __createConfirmed?: boolean }).__createConfirmed === false ? undefined : reply.id
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('reply-created', {
            detail: { reply, replyId: reply.id, confirmed: messageReplyId !== undefined },
          }))
        }
      } catch (err) {
        logger.error('Could not post the message that went with the tip:', err)
      }
    }

    const recorded = await tipService.recordTip({
      senderId: user.identityId,
      target: tipTarget,
      recipientId: recipientInfo.id,
      amount: yappAmountBig,
      transferId,
      messageReplyId,
    })
    if (!recorded.success) {
      setError(recorded.error ?? 'Your YAPP was sent, but the tip could not be attached to this post.')
      setAttachTransferId(transferId)
      setState('attach-failed')
      return false
    }
    setAttachTransferId(null)
    return true
  }, [user, recipientInfo, post, tipTarget, noteMessage, yappAmountBig])

  /**
   * The whole YAPP path's tail: the transfer landed, so attach it and show the
   * result. A tip aimed at a profile rather than a post has nothing to attach.
   */
  const settleYappTip = useCallback(async (transferId: string | undefined) => {
    finishYappTip()
    if (!tipTarget || !tipService.tipsAreRecordable()) return
    if (!transferId) {
      setError('Your YAPP was sent, but we could not find the transfer to attach it to this post yet.')
      setAttachTransferId(null)
      setState('attach-failed')
      return
    }
    if (await attachTip(transferId)) setState('success')
  }, [attachTip, finishYappTip, tipTarget])

  const handleSendYappTip = async () => {
    if (!user || !recipientInfo) return
    setState('processing')
    const enteredKey = criticalKeyWif.trim()
    const result = await tipService.sendYappTipLocal(
      user.identityId,
      recipientInfo.id,
      yappAmountBig,
      tipTarget,
      noteMessage,
      enteredKey || undefined
    )

    if (result.errorCode === 'NEEDS_CRITICAL_KEY') {
      // The only branch that keeps the entered key: the user stays on the key
      // screen to correct it in place.
      setError(enteredKey ? "That key doesn't match a critical key on your identity. Check it and try again." : null)
      setShowKeyEntry(Boolean(enteredKey))
      setState('needKey')
      return
    }

    // Leaving the key-entry flow — drop the entered key so a later action can't
    // silently sign with it without the user re-confirming.
    setCriticalKeyWif('')

    if (result.success) {
      await settleYappTip(result.transferId)
    } else if (result.errorCode === 'UNCONFIRMED') {
      // Broadcast went out, the proof has not shown up yet. Never offer a plain
      // retry here — a second press would move the money twice.
      setError(result.error ?? null)
      setState('unconfirmed')
    } else {
      setState('error')
      setError(result.error || 'Tip failed')
    }
  }

  /**
   * Re-ask the chain whether a tip we could not confirm has landed.
   *
   * Deliberately no time floor, unlike the wallet path's own match: if the
   * chain's clock ran behind ours the tip is real but sits before the moment
   * we sent it, and a floor would hide it.
   */
  const recheckTip = useCallback(async () => {
    if (!user || !recipientInfo) return false
    const match = tipService.tipMatch(recipientInfo.id, yappAmountBig, tipTarget, noteMessage)
    const result = await tipService.confirmYappTip(user.identityId, match)
    if (result.success) {
      await settleYappTip(result.transferId)
      return true
    }
    setError(result.error ?? null)
    return false
  }, [user, recipientInfo, yappAmountBig, tipTarget, noteMessage, settleYappTip])

  /**
   * Ask the chain first, act second. Both "check again" buttons go through
   * here, so neither the "couldn't confirm" screen nor the expired QR — which
   * the user could scan into a SECOND transfer — offers a fresh send before
   * the first one has been ruled out. `onStillMissing` runs only when no proof
   * turned up.
   */
  const checkTipLanded = (onStillMissing: () => void) => {
    setState('confirming-landed')
    recheckTip()
      .then(landed => { if (!landed) onStillMissing() })
      .catch(err => { logger.error('Tip re-check failed:', err); onStillMissing() })
  }

  // Leave the dash-st: QR screen. Bumping the generation counter discards any
  // in-flight build so a late resolve can't put a stale QR back on screen.
  const exitWalletSign = useCallback((message: string | null) => {
    walletSessionRef.current++
    setWalletUri(null)
    setWalletExpired(false)
    setError(message)
    setState(canSignLocally ? 'confirming' : 'needKey')
  }, [canSignLocally])

  /**
   * Build the unsigned transfer and show it as a dash-st: QR for a remote
   * wallet to sign with its CRITICAL key and broadcast — the same channel
   * buying YAPP and registering keys use.
   */
  const handleWalletSign = async () => {
    if (!user || !recipientInfo) return
    const invalid = tipService.validateYappTip(user.identityId, recipientInfo.id, yappAmountBig)
    if (invalid) {
      setState('input')
      setError(invalid.error ?? 'Invalid tip')
      return
    }
    const session = ++walletSessionRef.current
    setState('walletSign')
    setError(null)
    setWalletUri(null)
    setWalletExpired(false)
    try {
      // Recipient, amount, post and message all have to agree before a row
      // counts as this tip, plus a time floor so an identical earlier tip to
      // the same author isn't mistaken for the wallet's. The margin absorbs
      // skew between this clock and the chain's.
      walletMatchRef.current = tipService.tipMatch(
        recipientInfo.id,
        yappAmountBig,
        tipTarget,
        noteMessage,
        Date.now() - CLOCK_SKEW_MARGIN_MS
      )
      const bytes = await buildUnsignedYappTipTransition(
        user.identityId,
        recipientInfo.id,
        yappAmountBig,
        tipService.tipNoteFor(tipTarget, noteMessage)
      )
      if (walletSessionRef.current !== session) return
      setWalletUri(buildYapprStateTransitionUri(bytes, getConfiguredNetwork()))
    } catch (err) {
      if (walletSessionRef.current !== session) return
      logger.error('Failed to build wallet tip request:', err)
      exitWalletSign('Could not prepare the wallet signing request — please try again')
    }
  }

  const startWalletSign = () => {
    handleWalletSign().catch(err => logger.error('Failed to start wallet signing:', err))
  }

  // While the QR is up, poll the token-history contract for this tip's own
  // `transfer` document. That is the proof the UI will render, so waiting on it
  // (rather than on the YAPP balance merely falling) cannot be tripped by the
  // user spending YAPP elsewhere mid-flow. The wait has a silent budget; when
  // it runs out the QR gives way to a "check again" prompt, never a countdown.
  useEffect(() => {
    const match = walletMatchRef.current
    if (state !== 'walletSign' || !walletUri || !user || !match) return
    const identityId = user.identityId

    const budget = setTimeout(() => {
      setWalletUri(null)
      setWalletExpired(true)
    }, WALLET_SIGN_TIMEOUT_MS)

    let finished = false
    const poll = setInterval(() => {
      tipHistoryService.getTipsSent(identityId, { fresh: true }).then(sent => {
        if (finished) return
        const landed = sent.find(tip => matchesSentTip(tip, match))
        if (!landed) return
        finished = true
        void settleYappTip(landed.id)
      }).catch(() => {
        // Transient read failures — keep polling.
      })
    }, 5000)

    return () => {
      clearTimeout(budget)
      clearInterval(poll)
    }
  }, [state, walletUri, user, settleYappTip])

  const handleClose = () => {
    if (state === 'processing') return // Don't allow closing during processing
    // Clear sensitive data
    setCriticalKeyWif('')
    close()
  }

  const handleCloseQrDialog = () => {
    setShowQrDialog(false)
    setSelectedQrPayment(null)
  }

  if (!recipientInfo) return null

  const isYapp = activeTab === 'yapp'
  const recipientName = recipientInfo.displayName || recipientInfo.username || 'this user'
  const amountLabel = `${yappAmountBig.toString()} YAPP`

  // The confirm step's primary action: which tab is open, and for YAPP whether
  // this browser can sign a token transition at all or has to ask the wallet.
  function confirmAction() {
    if (isYapp && canSignLocally === null) {
      return <Button disabled className="flex-1 bg-amber-500 text-white">Checking your keys…</Button>
    }
    if (isYapp && !canSignLocally) {
      return <Button onClick={startWalletSign} className={AMBER_BUTTON}>Sign with wallet</Button>
    }
    return (
      <Button onClick={handleSendYappTip} className={AMBER_BUTTON}>
        Confirm &amp; Send
      </Button>
    )
  }

  const tabClass = (tab: PaymentTab) =>
    `flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
      activeTab === tab
        ? 'bg-white dark:bg-neutral-700 text-amber-600 dark:text-amber-400 shadow-sm'
        : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
    }`

  return (
    <>
    <Modal open={isOpen} onOpenChange={handleClose} className="w-[420px] max-w-[90vw]">
                <ModalTitle className="mb-4">
                  <CurrencyDollarIcon className="h-6 w-6 text-amber-500" />
                  {MODAL_TITLES[state] ?? 'Send Tip'}
                </ModalTitle>

                <Dialog.Description className="sr-only">
                  Send a tip to {recipientName}
                </Dialog.Description>

                <button
                  onClick={handleClose}
                  aria-label="Close tip modal"
                  className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                  disabled={state === 'processing'}
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>

                {/* Input State */}
                {state === 'input' && (
                  <div className="space-y-4">
                    <p className="text-gray-600 dark:text-gray-400">
                      Send a tip to <span className="font-semibold text-gray-900 dark:text-white">{recipientName}</span>
                    </p>

                    <div className="flex rounded-lg bg-gray-100 dark:bg-neutral-800 p-1">
                      <button type="button" onClick={() => { setActiveTab('yapp'); setError(null) }} className={tabClass('yapp')}>
                        <SparklesIcon className="w-4 h-4" />
                        YAPP
                      </button>
                      {paymentUris.length > 0 && (
                        <button type="button" onClick={() => { setActiveTab('crypto'); setError(null) }} className={tabClass('crypto')}>
                          <WalletIcon className="w-4 h-4" />
                          Other
                          <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-gray-200 dark:bg-neutral-600">
                            {paymentUris.length}
                          </span>
                        </button>
                      )}
                    </div>

                    {/* YAPP Tab Content — the provable path */}
                    {activeTab === 'yapp' && (
                      <div className="space-y-4">
                        <div className="text-sm text-gray-500">
                          {loadingBalance ? (
                            'Loading balance...'
                          ) : yappBalance !== null ? (
                            <>Your YAPP: <span className="font-medium">{yappBalance.toString()}</span></>
                          ) : (
                            'Could not load YAPP balance'
                          )}
                        </div>

                        <div>
                          <label htmlFor="tip-yapp-amount" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Amount (YAPP)
                          </label>
                          <input
                            id="tip-yapp-amount"
                            type="text"
                            inputMode="numeric"
                            value={yappAmount}
                            onChange={(e) => handleYappAmountChange(e.target.value)}
                            placeholder="1"
                            className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-lg font-mono focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                          />
                        </div>

                        <AmountPresets
                          presets={YAPP_PRESETS}
                          value={yappAmount}
                          onSelect={(preset) => { setYappAmount(preset); setError(null) }}
                        />

                        <div>
                          <label htmlFor="tip-yapp-message" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Message (optional)
                          </label>
                          <textarea
                            id="tip-yapp-message"
                            value={tipMessage}
                            onChange={(e) => setTipMessage(e.target.value)}
                            placeholder="Add a note with your tip..."
                            maxLength={TIP_MESSAGE_MAX_LENGTH}
                            rows={2}
                            className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                          />
                          <p className="mt-1 text-xs text-gray-500 text-right">
                            {tipMessage.length}/{TIP_MESSAGE_MAX_LENGTH}
                          </p>
                        </div>

                        <p className="text-xs text-gray-500">
                          {post
                            ? 'The transfer, the amount and this note are signed by you and recorded on Dash Platform, so the tip on this post can be verified by anyone.'
                            : 'The transfer and the amount are signed by you and recorded on Dash Platform.'}
                        </p>

                        {error && <p className="text-red-500 text-sm">{error}</p>}

                        <Button
                          onClick={handleContinue}
                          className={AMBER_BUTTON_WIDE}
                          disabled={yappAmountBig <= BigInt(0) || loadingBalance}
                        >
                          Continue
                        </Button>
                      </div>
                    )}

                    {/* Other Crypto Tab Content */}
                    {activeTab === 'crypto' && (
                      <div className="space-y-3">
                        <p className="text-sm text-gray-500">
                          Send a tip directly to {recipientName}&apos;s wallet. Click an address to see the QR code.
                        </p>

                        {/* Grid of crypto options */}
                        <div className="grid gap-2">
                          {paymentUris.map((paymentUri, idx) => {
                            const label = PAYMENT_SCHEME_LABELS[paymentUri.scheme.toLowerCase()] || getPaymentLabel(paymentUri.uri)
                            return (
                              <button
                                key={idx}
                                type="button"
                                onClick={() => { setSelectedQrPayment(paymentUri); setShowQrDialog(true) }}
                                className="w-full p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-amber-400 dark:hover:border-amber-500 hover:bg-amber-50 dark:hover:bg-amber-900/10 text-left transition-all group"
                              >
                                <div className="flex items-center gap-3">
                                  <PaymentSchemeIcon scheme={paymentUri.scheme} size="lg" />
                                  <div className="flex-1 min-w-0">
                                    <span className="font-medium text-gray-900 dark:text-gray-100">{label}</span>
                                    <p className="text-xs text-gray-500 font-mono truncate">
                                      {truncateAddress(paymentUri.uri, 24)}
                                    </p>
                                  </div>
                                  <div className="flex items-center gap-1 text-gray-400 group-hover:text-amber-500 transition-colors">
                                    <QrCodeIcon className="w-5 h-5" />
                                  </div>
                                </div>
                              </button>
                            )
                          })}
                        </div>

                        <p className="text-xs text-gray-400 text-center pt-2">
                          Tips sent via external wallets are not tracked on Yappr
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {/* Confirming State */}
                {state === 'confirming' && (
                  <div className="space-y-4">
                    <div className="bg-gray-50 dark:bg-neutral-800 rounded-lg p-4 space-y-2">
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">Amount</span>
                        <span className="font-bold text-lg">{amountLabel}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">To</span>
                        <span className="font-medium">{recipientName}</span>
                      </div>
                      {isYapp && tipMessage.trim() && (
                        <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                          <span className="text-gray-600 dark:text-gray-400 text-sm">Message:</span>
                          <p className="text-sm mt-1">{tipMessage}</p>
                        </div>
                      )}
                    </div>

                    <p className="text-sm text-gray-500 text-center">
                      This action cannot be undone.
                    </p>

                    {error && <p className="text-red-500 text-sm">{error}</p>}

                    <div className="flex gap-3">
                      <Button
                        onClick={() => { setState('input'); setError(null) }}
                        variant="outline"
                        className="flex-1"
                      >
                        Back
                      </Button>
                      {confirmAction()}
                    </div>

                    {isYapp && canSignLocally && (
                      <button
                        type="button"
                        onClick={startWalletSign}
                        className="w-full text-xs text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                      >
                        Sign with my wallet instead
                      </button>
                    )}
                  </div>
                )}

                {/* Needs a CRITICAL key — token transitions can't be signed with a HIGH login key */}
                {state === 'needKey' && (
                  <div className="space-y-4">
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      Moving YAPP needs your identity&apos;s{' '}
                      <span className="font-medium text-gray-900 dark:text-gray-100">critical</span> key. Your sign-in
                      key can post but not transfer tokens, so approve this tip in the Dash wallet that holds it.
                    </p>
                    <div className="flex justify-between text-sm bg-gray-50 dark:bg-neutral-800 rounded-lg px-3 py-2">
                      <span className="text-gray-600 dark:text-gray-400">Tipping {recipientName}</span>
                      <span className="font-medium">{amountLabel}</span>
                    </div>
                    {error && !showKeyEntry && <p className="text-red-500 text-sm">{error}</p>}
                    <div className="flex gap-3">
                      <Button
                        onClick={() => { setState('confirming'); setError(null); setCriticalKeyWif(''); setShowKeyEntry(false) }}
                        variant="outline"
                        className="flex-1"
                      >
                        Back
                      </Button>
                      <Button onClick={startWalletSign} className="flex-1">
                        Approve in wallet
                      </Button>
                    </div>
                    <div className="border-t border-gray-200 dark:border-gray-700 pt-3">
                      <button
                        type="button"
                        aria-expanded={showKeyEntry}
                        onClick={() => setShowKeyEntry(v => !v)}
                        className="w-full flex items-center justify-between text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors py-1"
                      >
                        <span>{showKeyEntry ? 'Hide private key entry' : 'Paste a critical private key instead'}</span>
                        <ChevronDownIcon aria-hidden="true" className={`w-4 h-4 transition-transform ${showKeyEntry ? 'rotate-180' : ''}`} />
                      </button>
                      {showKeyEntry && (
                        <div className="space-y-3 pt-3">
                          <p className="text-xs text-gray-500">
                            The key signs this tip locally and is never stored or sent anywhere.
                          </p>
                          <input
                            type="password"
                            value={criticalKeyWif}
                            onChange={(e) => { setCriticalKeyWif(e.target.value); setError(null) }}
                            placeholder="Critical private key (WIF)"
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck={false}
                            className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                          />
                          {error && <p className="text-red-500 text-sm">{error}</p>}
                          <Button onClick={handleSendYappTip} disabled={!criticalKeyWif.trim()} variant="outline" className="w-full">
                            Authorize &amp; tip with this key
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Remote wallet signing */}
                {state === 'walletSign' && (
                  <div className="space-y-4">
                    <div className="flex justify-between text-sm bg-gray-50 dark:bg-neutral-800 rounded-lg px-3 py-2">
                      <span className="text-gray-600 dark:text-gray-400">Tipping {recipientName}</span>
                      <span className="font-medium">{amountLabel}</span>
                    </div>
                    {walletUri ? (
                      <>
                        <KeyExchangeQR uri={walletUri} size={200} />
                        <div className="flex items-center justify-center gap-2 text-sm text-gray-500">
                          <Spinner size="sm" className="border-amber-500" />
                          Waiting for the wallet to sign &amp; broadcast…
                        </div>
                      </>
                    ) : walletExpired ? (
                      <div className="py-6 text-center space-y-4">
                        <p className="font-medium text-gray-900 dark:text-white">Haven&apos;t seen the tip land yet</p>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                          If your wallet already broadcast it, your balance will update shortly. Otherwise check again
                          for a fresh request.
                        </p>
                        <Button onClick={() => checkTipLanded(startWalletSign)} className="w-full">
                          Check again
                        </Button>
                      </div>
                    ) : (
                      <div className="py-8 text-center space-y-4">
                        <Spinner size="lg" className="mx-auto border-amber-500" />
                        <p className="text-gray-600 dark:text-gray-400">Preparing signing request…</p>
                      </div>
                    )}
                    <Button onClick={() => exitWalletSign(null)} variant="outline" className="w-full">
                      Back
                    </Button>
                  </div>
                )}

                {/* Processing State */}
                {state === 'processing' && (
                  <div className="py-8 text-center space-y-4">
                    <Spinner size="lg" className="mx-auto border-amber-500" />
                    <p className="text-gray-600 dark:text-gray-400">Sending tip...</p>
                    <p className="text-xs text-gray-500">Please wait, this may take a moment.</p>
                  </div>
                )}

                {/* The money moved; now the tip is being put on the post */}
                {state === 'attaching' && (
                  <div className="py-8 text-center space-y-4">
                    <Spinner size="lg" className="mx-auto border-amber-500" />
                    <p className="text-gray-600 dark:text-gray-400">
                      {noteMessage ? 'Posting your reply and attaching the tip…' : 'Attaching the tip to this post…'}
                    </p>
                    <p className="text-xs text-gray-500">Your YAPP has already been sent.</p>
                  </div>
                )}

                {/* The transfer landed, the tip document did not. Never a
                    "send again" screen — the money is already gone. */}
                {state === 'attach-failed' && (
                  <div className="py-4 text-center space-y-4">
                    <ExclamationCircleIcon className="h-16 w-16 text-amber-500 mx-auto" />
                    <div className="space-y-2">
                      <p className="text-lg font-medium">Tip sent, not yet shown</p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">{error}</p>
                      <p className="text-xs text-gray-500">
                        The {amountLabel} reached {recipientName}. Only the record that puts it on this post is
                        missing, and attaching it again costs nothing but a moment.
                      </p>
                    </div>
                    <div className="flex gap-3">
                      <Button onClick={close} variant="outline" className="flex-1">
                        Close
                      </Button>
                      <Button
                        onClick={() => {
                          if (attachTransferId) {
                            void attachTip(attachTransferId).then((attached) => { if (attached) setState('success') })
                          } else {
                            void recheckTip()
                          }
                        }}
                        className={AMBER_BUTTON}
                      >
                        Attach again
                      </Button>
                    </div>
                  </div>
                )}

                {/* Asking the chain whether an unconfirmed tip landed */}
                {state === 'confirming-landed' && (
                  <div className="py-8 text-center space-y-4">
                    <Spinner size="lg" className="mx-auto border-amber-500" />
                    <p className="text-gray-600 dark:text-gray-400">Checking whether your tip landed…</p>
                    <p className="text-xs text-gray-500">Reading the transfer record from Dash Platform.</p>
                  </div>
                )}

                {/* Broadcast went out, no proof yet — deliberately NOT a retry screen */}
                {state === 'unconfirmed' && (
                  <div className="py-4 text-center space-y-4">
                    <ExclamationCircleIcon className="h-16 w-16 text-amber-500 mx-auto" />
                    <div className="space-y-2">
                      <p className="text-lg font-medium">Couldn&apos;t confirm your tip</p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">{error}</p>
                      <p className="text-xs text-gray-500">
                        Your wallet or this browser already broadcast {amountLabel}. Sending again would transfer it a
                        second time, so check first.
                      </p>
                    </div>
                    <div className="flex gap-3">
                      <Button onClick={close} variant="outline" className="flex-1">
                        Close
                      </Button>
                      <Button onClick={() => checkTipLanded(() => setState('unconfirmed'))} className="flex-1">
                        Check again
                      </Button>
                    </div>
                  </div>
                )}

                {state === 'success' && (
                  <div className="py-4 text-center space-y-4">
                    <CheckCircleIcon className="h-16 w-16 text-green-500 mx-auto" />
                    <div>
                      <p className="text-lg font-medium">Tip sent successfully!</p>
                      <p className="text-gray-600 dark:text-gray-400">
                        You sent {amountLabel} to {recipientName}
                      </p>
                    </div>
                    {tipTarget && tipService.tipsAreRecordable() && (
                      <p className="text-sm text-gray-500">
                        It now shows on this post{noteMessage ? ', with your reply' : ''}.
                      </p>
                    )}
                    <Button onClick={close} className="w-full">
                      Done
                    </Button>
                  </div>
                )}

                {/* Error State */}
                {state === 'error' && (
                  <div className="py-4 text-center space-y-4">
                    <ExclamationCircleIcon className="h-16 w-16 text-red-500 mx-auto" />
                    <div>
                      <p className="text-lg font-medium">Transfer Failed</p>
                      <p className="text-red-500 text-sm">{error}</p>
                    </div>
                    <div className="flex gap-3">
                      <Button onClick={close} variant="outline" className="flex-1">
                        Close
                      </Button>
                      <Button onClick={() => { setState('input'); setError(null) }} className="flex-1">
                        Try Again
                      </Button>
                    </div>
                  </div>
                )}
    </Modal>

    {/* QR Code Dialog - opens on top of the tip modal */}
    <PaymentQRCodeDialog
      isOpen={showQrDialog}
      onClose={handleCloseQrDialog}
      paymentUri={selectedQrPayment}
      recipientName={recipientName}
      watchForTransaction={true}
      onDone={handleCloseQrDialog}
    />
  </>
  )
}
