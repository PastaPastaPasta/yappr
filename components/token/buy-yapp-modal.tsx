'use client'

import { logger } from '@/lib/logger'
import { useState, useEffect, useRef, useCallback } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, SparklesIcon } from '@heroicons/react/24/outline'
import { CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/24/solid'
import { motion, AnimatePresence } from 'framer-motion'
import { buildYapprStateTransitionUri } from 'platform-auth'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { KeyExchangeQR } from '@/components/auth/key-exchange-qr'
import { useBuyYappModal } from '@/hooks/use-buy-yapp-modal'
import { useAuth } from '@/contexts/auth-context'
import { tokenService, MIN_YAPP_PURCHASE } from '@/lib/services/token-service'
import { buildUnsignedDirectPurchaseTransition } from '@/lib/services/token-purchase-builder'
import { identityService } from '@/lib/services/identity-service'
import { tipService, CREDITS_PER_DASH as CREDITS_PER_DASH_NUM } from '@/lib/services/tip-service'
import { YAPP_TOKEN_COSTS, getConfiguredNetwork } from '@/lib/constants'

// Preset purchase amounts in whole YAPP (must be >= the on-chain minimum of 100).
const PRESETS = [100, 500, 1000, 5000]

/** "≈ 10 posts, 33 replies, or 100 likes" for a given YAPP amount. */
function formatCoverage(amount: bigint): string {
  const posts = amount / BigInt(YAPP_TOKEN_COSTS.post)
  const replies = amount / BigInt(YAPP_TOKEN_COSTS.reply)
  const likes = amount / BigInt(YAPP_TOKEN_COSTS.like)
  return `≈ ${posts.toString()} posts, ${replies.toString()} replies, or ${likes.toString()} likes`
}

const CREDITS_PER_DASH = BigInt(CREDITS_PER_DASH_NUM) // 1 DASH = 1e11 platform credits

/** BigInt-safe credits → "X.XXXX DASH" (or "N credits" for sub-0.0001 DASH). */
function formatCreditsAsDash(credits: bigint): string {
  const whole = credits / CREDITS_PER_DASH
  const frac = ((credits % CREDITS_PER_DASH) * BigInt(10000)) / CREDITS_PER_DASH
  if (whole === BigInt(0) && frac === BigInt(0)) return `${credits.toString()} credits`
  return `${whole.toString()}.${frac.toString().padStart(4, '0')} DASH`
}

type ModalState = 'input' | 'confirming' | 'needKey' | 'walletSign' | 'processing' | 'success' | 'error'

const MODAL_TITLES: Record<ModalState, string> = {
  input: 'Buy YAPP',
  confirming: 'Buy YAPP',
  needKey: 'Authorize Purchase',
  walletSign: 'Authorize Purchase',
  processing: 'Buy YAPP',
  success: 'YAPP Purchased!',
  error: 'Purchase Failed',
}

// How long the dash-st: QR stays valid before the flow gives up waiting for
// the wallet (matches the key-registration flow's 5-minute window).
const WALLET_SIGN_TIMEOUT_S = 300

export function BuyYappModal() {
  const { isOpen, reason, close } = useBuyYappModal()
  const { user, refreshBalance } = useAuth()

  const [amount, setAmount] = useState('100')
  const [state, setState] = useState<ModalState>('input')
  const [error, setError] = useState<string | null>(null)
  const [yappBalance, setYappBalance] = useState<bigint | null>(null)
  const [creditBalance, setCreditBalance] = useState<number | null>(null)
  const [pricePerToken, setPricePerToken] = useState<bigint | null>(null)
  const [loading, setLoading] = useState(false)
  const [showCosts, setShowCosts] = useState(false)
  // CRITICAL key the user pastes when their login key is HIGH — kept in
  // component state only for the purchase, never persisted.
  const [criticalKeyWif, setCriticalKeyWif] = useState('')
  // Remote wallet signing (dash-st: QR): the unsigned purchase URI, the QR
  // countdown, and the YAPP balance right before the QR was shown — success is
  // detected by the balance growing by the purchased amount.
  const [walletUri, setWalletUri] = useState<string | null>(null)
  const [walletRemaining, setWalletRemaining] = useState<number | null>(null)
  const walletBaselineRef = useRef<bigint | null>(null)
  // Generation counter guarding handleWalletSign's async steps: bumped on every
  // start/back/close so a superseded invocation can't overwrite a fresh QR or
  // baseline after its awaits resolve.
  const walletSessionRef = useRef(0)

  useEffect(() => {
    if (isOpen && user) {
      setLoading(true)
      void Promise.all([
        tokenService.getBalance(user.identityId).then(setYappBalance).catch(() => setYappBalance(null)),
        identityService.getBalance(user.identityId).then(b => setCreditBalance(b.confirmed)).catch(() => setCreditBalance(null)),
        tokenService.getPricePerToken().then(setPricePerToken).catch(() => setPricePerToken(null)),
      ]).finally(() => setLoading(false))
    }
  }, [isOpen, user])

  useEffect(() => {
    if (!isOpen) {
      setAmount('100')
      setState('input')
      setError(null)
      setShowCosts(false)
      setCriticalKeyWif('')
      setWalletUri(null)
      setWalletRemaining(null)
      walletBaselineRef.current = null
      walletSessionRef.current++
    }
  }, [isOpen])

  // Keep token/credit values as BigInt end-to-end so the signed amount and cap
  // can never diverge from what the UI showed.
  const amountBig = /^\d+$/.test(amount) ? BigInt(amount) : BigInt(0)
  const costCredits = pricePerToken !== null ? pricePerToken * amountBig : null
  const costDashLabel = costCredits !== null ? formatCreditsAsDash(costCredits) : '—'

  const handleAmountChange = (value: string) => {
    if (/^\d*$/.test(value)) {
      setAmount(value)
      setError(null)
    }
  }

  const handleContinue = () => {
    if (amountBig < MIN_YAPP_PURCHASE) {
      setError(`Minimum purchase is ${MIN_YAPP_PURCHASE} YAPP`)
      return
    }
    if (costCredits === null) {
      setError('Price unavailable right now — please try again')
      return
    }
    if (creditBalance !== null && costCredits > BigInt(Math.floor(creditBalance))) {
      setError('Not enough DASH credits for this purchase')
      return
    }
    setState('confirming')
    setError(null)
  }

  // Shared tail of both purchase paths (local signing and remote wallet
  // signing): refresh the credit balance, tell other YAPP balance views (e.g.
  // the sidebar dropdown) to refresh, and show the success screen.
  const finishPurchase = useCallback(() => {
    refreshBalance().catch(err => logger.error('Failed to refresh balance:', err))
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('yapp-balance-changed'))
    setState('success')
  }, [refreshBalance])

  const handleBuy = async () => {
    if (!user || costCredits === null) return
    setState('processing')
    // Cap the spend at the exact cost the user just confirmed. If the on-chain
    // price rose since, the transition is rejected rather than silently overspending.
    const enteredKey = criticalKeyWif.trim()
    const result = await tokenService.buyYapp(user.identityId, amountBig, costCredits, enteredKey || undefined)
    if (result.success) {
      setCriticalKeyWif('')
      tokenService.getBalance(user.identityId).then(setYappBalance).catch(() => {})
      finishPurchase()
    } else if (result.errorCode === 'NEEDS_CRITICAL_KEY') {
      // Login key is HIGH but purchases must be signed with CRITICAL — ask for
      // it. If a key was already entered, it didn't match a CRITICAL key.
      setError(enteredKey ? 'That key doesn\'t match a CRITICAL key on your identity — check it and try again' : null)
      setState('needKey')
    } else {
      // Leaving the needKey flow — drop the entered key so a later retry can't
      // silently sign with it without the user re-confirming.
      setCriticalKeyWif('')
      setState('error')
      setError(result.error || 'Purchase failed')
    }
  }

  // Leave the dash-st: QR screen and fall back to pasting the CRITICAL key,
  // optionally with a message. Bumping the generation counter discards any
  // in-flight build so a late resolve can't put a stale QR back on screen.
  const exitWalletSign = useCallback((message: string | null) => {
    walletSessionRef.current++
    setWalletUri(null)
    setWalletRemaining(null)
    setError(message)
    setState('needKey')
  }, [])

  /**
   * Alternative to pasting the CRITICAL key: build the unsigned purchase
   * transition and show it as a dash-st: QR for a remote wallet (e.g. Dash Evo
   * Tool) to sign and broadcast — the same channel key registration uses.
   */
  const handleWalletSign = async () => {
    if (!user || costCredits === null) return
    const session = ++walletSessionRef.current
    setState('walletSign')
    setError(null)
    setWalletUri(null)
    setWalletRemaining(null)
    try {
      // Baseline balance fetched fresh so the success check ("balance grew by
      // the purchased amount") can't trip on a stale value from modal open.
      const baseline = await tokenService.getBalance(user.identityId)
      if (walletSessionRef.current !== session) return
      walletBaselineRef.current = baseline
      const bytes = await buildUnsignedDirectPurchaseTransition(user.identityId, amountBig, costCredits)
      if (walletSessionRef.current !== session) return
      setWalletUri(buildYapprStateTransitionUri(bytes, getConfiguredNetwork()))
    } catch (err) {
      if (walletSessionRef.current !== session) return
      logger.error('Failed to build wallet signing request:', err)
      exitWalletSign('Could not prepare the wallet signing request — please try again')
    }
  }

  // While the dash-st: QR is up, poll the YAPP balance until the wallet's
  // broadcast lands (balance grew by at least the purchased amount), and run
  // the QR expiry countdown. The transition embeds the current contract nonce,
  // so it expires naturally if the user posts or likes in the meantime.
  useEffect(() => {
    if (state !== 'walletSign' || !walletUri || !user) return
    const identityId = user.identityId
    const startedAt = Date.now()
    setWalletRemaining(WALLET_SIGN_TIMEOUT_S)

    const countdown = setInterval(() => {
      const remaining = Math.max(0, WALLET_SIGN_TIMEOUT_S - Math.floor((Date.now() - startedAt) / 1000))
      setWalletRemaining(remaining)
      if (remaining === 0) {
        exitWalletSign('Didn\'t detect the purchase in time — if your wallet did broadcast it, your balance will update shortly')
      }
    }, 1000)

    let finished = false
    const poll = setInterval(() => {
      tokenService.getBalance(identityId).then(balance => {
        const baseline = walletBaselineRef.current
        if (finished || baseline === null) return
        if (balance < baseline) {
          // The user spent YAPP mid-flow (e.g. posted from another tab).
          // Re-baseline to the running minimum so the wallet's purchase still
          // registers as "+amount over the low-water mark" when it lands.
          walletBaselineRef.current = balance
          return
        }
        if (balance < baseline + amountBig) return
        finished = true
        setYappBalance(balance)
        finishPurchase()
      }).catch(() => {
        // Transient balance-fetch failures — keep polling.
      })
    }, 5000)

    return () => {
      clearInterval(countdown)
      clearInterval(poll)
    }
  }, [state, walletUri, user, amountBig, finishPurchase, exitWalletSign])

  const handleClose = () => {
    if (state === 'processing') return
    close()
  }

  return (
    <Dialog.Root open={isOpen} onOpenChange={handleClose}>
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
                    className="bg-white dark:bg-neutral-900 rounded-2xl p-6 w-[420px] max-w-[90vw] shadow-xl relative"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Dialog.Title className="text-xl font-bold mb-4 flex items-center gap-2">
                      <SparklesIcon className="h-6 w-6 text-yappr-500" />
                      {MODAL_TITLES[state]}
                    </Dialog.Title>
                    <Dialog.Description className="sr-only">
                      Buy YAPP tokens to post, comment, and like on Yappr.
                    </Dialog.Description>

                    <button
                      onClick={handleClose}
                      aria-label="Close Buy YAPP modal"
                      className="absolute top-4 right-4 p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full transition-colors"
                      disabled={state === 'processing'}
                    >
                      <XMarkIcon className="h-5 w-5" />
                    </button>

                    {state === 'input' && (
                      <div className="space-y-4">
                        {reason && (
                          <p className="text-sm bg-yappr-500/10 text-yappr-500 rounded-lg px-3 py-2">{reason}</p>
                        )}
                        <p className="text-gray-600 dark:text-gray-400 text-sm">
                          YAPP powers posting, comments, and likes. Buy in bundles of {MIN_YAPP_PURCHASE.toString()}+ — the upfront stake keeps spam out.{' '}
                          <button
                            onClick={() => setShowCosts(v => !v)}
                            className="text-yappr-500 hover:underline font-medium"
                            aria-expanded={showCosts}
                          >
                            {showCosts ? 'Hide action costs' : 'See action costs'}
                          </button>
                        </p>

                        {showCosts && (
                          <div className="text-sm bg-gray-50 dark:bg-neutral-800 rounded-lg px-3 py-2 space-y-1">
                            <div className="flex justify-between">
                              <span className="text-gray-600 dark:text-gray-400">Post</span>
                              <span className="font-medium">{YAPP_TOKEN_COSTS.post} YAPP</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-600 dark:text-gray-400">Reply</span>
                              <span className="font-medium">{YAPP_TOKEN_COSTS.reply} YAPP</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-600 dark:text-gray-400">Like</span>
                              <span className="font-medium">{YAPP_TOKEN_COSTS.like} YAPP</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-gray-600 dark:text-gray-400">Repost</span>
                              <span className="font-medium">{YAPP_TOKEN_COSTS.repost} YAPP</span>
                            </div>
                            <p className="text-xs text-gray-500 pt-1">
                              Costs are fixed in the contract and can&apos;t change under you. Following, bookmarking, and browsing are free.
                            </p>
                          </div>
                        )}

                        <div className="text-sm text-gray-500 space-y-0.5">
                          <div>Your YAPP: <span className="font-medium">{loading ? '…' : yappBalance !== null ? yappBalance.toString() : '—'}</span></div>
                          <div>Your credits: <span className="font-medium">{loading ? '…' : creditBalance !== null ? tipService.formatDash(tipService.creditsToDash(creditBalance)) : '—'}</span></div>
                        </div>

                        <div>
                          <label htmlFor="buy-yapp-amount" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Amount (YAPP)</label>
                          <input
                            id="buy-yapp-amount"
                            type="text"
                            inputMode="numeric"
                            value={amount}
                            onChange={(e) => handleAmountChange(e.target.value)}
                            placeholder="100"
                            className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-lg font-mono focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:border-transparent"
                          />
                        </div>

                        <div className="flex gap-2 overflow-x-auto">
                          {PRESETS.map((preset) => (
                            <button
                              key={preset}
                              onClick={() => { setAmount(preset.toString()); setError(null) }}
                              className={`px-2.5 py-1.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap ${
                                amount === preset.toString()
                                  ? 'bg-yappr-500 text-white'
                                  : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                              }`}
                            >
                              {preset}
                            </button>
                          ))}
                        </div>

                        <div className="text-sm bg-gray-50 dark:bg-neutral-800 rounded-lg px-3 py-2 space-y-1">
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">Cost</span>
                            <span className="font-medium">{costDashLabel}</span>
                          </div>
                          {amountBig > BigInt(0) && (
                            <p className="text-xs text-gray-500">{formatCoverage(amountBig)}</p>
                          )}
                        </div>

                        {error && <p className="text-red-500 text-sm">{error}</p>}

                        <Button onClick={handleContinue} className="w-full" disabled={amountBig <= BigInt(0) || loading}>
                          Continue
                        </Button>
                      </div>
                    )}

                    {state === 'confirming' && (
                      <div className="space-y-4">
                        <div className="bg-gray-50 dark:bg-neutral-800 rounded-lg p-4 space-y-2">
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">Buying</span>
                            <span className="font-bold text-lg">{amountBig.toString()} YAPP</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-gray-600 dark:text-gray-400">Cost</span>
                            <span className="font-medium">{costDashLabel}</span>
                          </div>
                          <p className="text-xs text-gray-500">{formatCoverage(amountBig)}</p>
                        </div>
                        <div className="flex gap-3">
                          <Button onClick={() => { setState('input'); setCriticalKeyWif('') }} variant="outline" className="flex-1">Back</Button>
                          <Button onClick={handleBuy} className="flex-1">Confirm &amp; Buy</Button>
                        </div>
                      </div>
                    )}

                    {state === 'needKey' && (
                      <div className="space-y-4">
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                          Buying YAPP spends DASH credits, and Dash Platform requires your{' '}
                          <span className="font-medium text-gray-900 dark:text-gray-100">CRITICAL</span> key to
                          authorize that — your login key is a HIGH key, which can post but not spend.
                          Paste your CRITICAL private key below. It signs this purchase locally and is
                          never stored or sent anywhere.
                        </p>
                        <div className="flex justify-between text-sm bg-gray-50 dark:bg-neutral-800 rounded-lg px-3 py-2">
                          <span className="text-gray-600 dark:text-gray-400">Buying {amountBig.toString()} YAPP</span>
                          <span className="font-medium">{costDashLabel}</span>
                        </div>
                        <input
                          type="password"
                          value={criticalKeyWif}
                          onChange={(e) => { setCriticalKeyWif(e.target.value); setError(null) }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && criticalKeyWif.trim()) {
                              e.preventDefault()
                              handleBuy().catch(err => logger.error('Failed to buy YAPP:', err))
                            }
                          }}
                          placeholder="CRITICAL private key (WIF)"
                          autoComplete="off"
                          className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:border-transparent"
                        />
                        {error && <p className="text-red-500 text-sm">{error}</p>}
                        <div className="flex gap-3">
                          <Button
                            onClick={() => { setState('confirming'); setError(null); setCriticalKeyWif('') }}
                            variant="outline"
                            className="flex-1"
                          >
                            Back
                          </Button>
                          <Button onClick={handleBuy} disabled={!criticalKeyWif.trim()} className="flex-1">
                            Authorize &amp; Buy
                          </Button>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="flex-1 border-t border-gray-200 dark:border-gray-700" />
                          <span className="text-xs text-gray-500">or</span>
                          <div className="flex-1 border-t border-gray-200 dark:border-gray-700" />
                        </div>
                        <Button
                          onClick={() => { handleWalletSign().catch(err => logger.error('Failed to start wallet signing:', err)) }}
                          variant="outline"
                          className="w-full"
                        >
                          Sign with Dash wallet
                        </Button>
                        <p className="text-xs text-gray-500 text-center">
                          Approve the purchase in a wallet that holds your CRITICAL key — no key ever touches this browser.
                        </p>
                      </div>
                    )}

                    {state === 'walletSign' && (
                      <div className="space-y-4">
                        <div className="flex justify-between text-sm bg-gray-50 dark:bg-neutral-800 rounded-lg px-3 py-2">
                          <span className="text-gray-600 dark:text-gray-400">Buying {amountBig.toString()} YAPP</span>
                          <span className="font-medium">{costDashLabel}</span>
                        </div>
                        {walletUri ? (
                          <>
                            <KeyExchangeQR uri={walletUri} size={200} remainingTime={walletRemaining} />
                            <div className="flex items-center justify-center gap-2 text-sm text-gray-500">
                              <Spinner size="sm" className="border-yappr-500" />
                              Waiting for the wallet to sign &amp; broadcast…
                            </div>
                          </>
                        ) : (
                          <div className="py-8 text-center space-y-4">
                            <Spinner size="lg" className="mx-auto border-yappr-500" />
                            <p className="text-gray-600 dark:text-gray-400">Preparing signing request…</p>
                          </div>
                        )}
                        <Button
                          onClick={() => exitWalletSign(null)}
                          variant="outline"
                          className="w-full"
                        >
                          Back
                        </Button>
                      </div>
                    )}

                    {state === 'processing' && (
                      <div className="py-8 text-center space-y-4">
                        <Spinner size="lg" className="mx-auto border-yappr-500" />
                        <p className="text-gray-600 dark:text-gray-400">Purchasing YAPP…</p>
                        <p className="text-xs text-gray-500">Please wait, this may take a moment.</p>
                      </div>
                    )}

                    {state === 'success' && (
                      <div className="py-4 text-center space-y-4">
                        <CheckCircleIcon className="h-16 w-16 text-green-500 mx-auto" />
                        <div>
                          <p className="text-lg font-medium">Purchased {amountBig.toString()} YAPP</p>
                          {yappBalance !== null && (
                            <p className="text-gray-600 dark:text-gray-400">New balance: {yappBalance.toString()} YAPP</p>
                          )}
                        </div>
                        <Button onClick={close} className="w-full">Done</Button>
                      </div>
                    )}

                    {state === 'error' && (
                      <div className="py-4 text-center space-y-4">
                        <ExclamationCircleIcon className="h-16 w-16 text-red-500 mx-auto" />
                        <div>
                          <p className="text-lg font-medium">Purchase Failed</p>
                          <p className="text-red-500 text-sm">{error}</p>
                        </div>
                        <div className="flex gap-3">
                          <Button onClick={close} variant="outline" className="flex-1">Close</Button>
                          <Button onClick={() => setState('input')} className="flex-1">Try Again</Button>
                        </div>
                      </div>
                    )}
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
