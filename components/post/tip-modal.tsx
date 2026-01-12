'use client'

import { useState, useEffect } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, CurrencyDollarIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import { CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/24/solid'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { useTipModal } from '@/hooks/use-tip-modal'
import { useAuth } from '@/contexts/auth-context'
import { tipService, MIN_TIP_CREDITS } from '@/lib/services/tip-service'
import { identityService } from '@/lib/services/identity-service'
import { PaymentSchemeIcon, getPaymentLabel, truncateAddress } from '@/components/ui/payment-icons'
import type { ParsedPaymentUri } from '@/lib/types'

// Preset tip amounts in DASH
const PRESET_AMOUNTS = [0.001, 0.005, 0.01, 0.05]

type ModalState = 'input' | 'confirming' | 'processing' | 'success' | 'error'
type PaymentMethod = 'credits' | 'external'

export function TipModal() {
  const { isOpen, post, close } = useTipModal()
  const { user, refreshBalance } = useAuth()

  const [amount, setAmount] = useState('')
  const [tipMessage, setTipMessage] = useState('')
  const [transferKey, setTransferKey] = useState('')
  const [state, setState] = useState<ModalState>('input')
  const [error, setError] = useState<string | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [loadingBalance, setLoadingBalance] = useState(false)

  // Payment URI support
  const [paymentUris, setPaymentUris] = useState<ParsedPaymentUri[]>([])
  const [loadingUris, setLoadingUris] = useState(false)
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('credits')
  const [selectedUri, setSelectedUri] = useState<string | null>(null)

  // Fetch user balance when modal opens
  useEffect(() => {
    if (isOpen && user) {
      setLoadingBalance(true)
      identityService.getBalance(user.identityId)
        .then(b => setBalance(b.confirmed))
        .catch(() => setBalance(null))
        .finally(() => setLoadingBalance(false))
    }
  }, [isOpen, user])

  // Fetch recipient's payment URIs when modal opens
  useEffect(() => {
    if (isOpen && post) {
      setLoadingUris(true)
      import('@/lib/services/unified-profile-service')
        .then(({ unifiedProfileService }) => unifiedProfileService.getPaymentUris(post.author.id))
        .then(uris => setPaymentUris(uris))
        .catch(() => setPaymentUris([]))
        .finally(() => setLoadingUris(false))
    }
  }, [isOpen, post])

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setAmount('')
      setTipMessage('')
      setTransferKey('')
      setState('input')
      setError(null)
      setPaymentMethod('credits')
      setSelectedUri(null)
      setPaymentUris([])
    }
  }, [isOpen])

  const handleAmountChange = (value: string) => {
    // Only allow valid decimal numbers with up to 8 decimal places
    if (/^\d*\.?\d{0,8}$/.test(value) || value === '') {
      setAmount(value)
      setError(null)
    }
  }

  const handlePresetClick = (preset: number) => {
    setAmount(preset.toString())
    setError(null)
  }

  const handleContinue = () => {
    const dashAmount = parseFloat(amount)
    if (isNaN(dashAmount) || dashAmount <= 0) {
      setError('Please enter a valid amount')
      return
    }

    const credits = tipService.dashToCredits(dashAmount)
    if (credits < MIN_TIP_CREDITS) {
      setError(`Minimum tip is ${tipService.formatDash(tipService.creditsToDash(MIN_TIP_CREDITS))}`)
      return
    }

    if (balance !== null && credits > balance) {
      setError('Insufficient balance')
      return
    }

    if (!transferKey.trim()) {
      setError('Please enter your transfer key')
      return
    }

    setState('confirming')
    setError(null)
  }

  const handleSendTip = async () => {
    if (!user || !post) return

    setState('processing')

    const dashAmount = parseFloat(amount)
    const credits = tipService.dashToCredits(dashAmount)

    const result = await tipService.sendTip(
      user.identityId,
      post.author.id,
      post.id,
      credits,
      transferKey,
      tipMessage.trim() || undefined
    )

    // Clear sensitive data from memory immediately
    setTransferKey('')

    if (result.success) {
      setState('success')
      // Refresh balance display and persist to auth context
      identityService.getBalance(user.identityId)
        .then(b => setBalance(b.confirmed))
        .catch(() => {})
      // Update global balance in auth context (persists to localStorage)
      refreshBalance()
    } else {
      setState('error')
      setError(result.error || 'Transfer failed')
    }
  }

  const handleClose = () => {
    if (state === 'processing') return // Don't allow closing during processing
    // Clear sensitive data
    setTransferKey('')
    close()
  }

  const handleRetry = () => {
    setState('input')
    setError(null)
  }

  // Handle opening an external payment URI
  const handleExternalPayment = (uri: string) => {
    // Open the payment URI (e.g., dash:Xaddr...) in a new tab/wallet app
    window.open(uri, '_blank')
    // Close the modal immediately after opening
    close()
  }

  if (!post) return null

  const dashAmount = parseFloat(amount) || 0
  const recipientName = post.author.displayName || post.author.username || 'this user'

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
                  <CurrencyDollarIcon className="h-6 w-6 text-amber-500" />
                  {state === 'success' ? 'Tip Sent!' : state === 'error' ? 'Transfer Failed' : 'Send Tip'}
                </Dialog.Title>

                <Dialog.Description className="sr-only">
                  Send a Dash tip to {recipientName}
                </Dialog.Description>

                <button
                  onClick={handleClose}
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

                    {/* Balance display */}
                    <div className="text-sm text-gray-500">
                      {loadingBalance ? (
                        'Loading balance...'
                      ) : balance !== null ? (
                        <>Your balance: <span className="font-medium">{tipService.formatDash(tipService.creditsToDash(balance))}</span></>
                      ) : (
                        'Could not load balance'
                      )}
                    </div>

                    {/* Amount input */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        Amount (DASH)
                      </label>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={amount}
                        onChange={(e) => handleAmountChange(e.target.value)}
                        placeholder="0.001"
                        className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-lg font-mono placeholder:text-gray-400 dark:placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                      />
                    </div>

                    {/* Preset amounts */}
                    <div className="flex gap-2 overflow-x-auto">
                      {PRESET_AMOUNTS.map((preset) => (
                        <button
                          key={preset}
                          onClick={() => handlePresetClick(preset)}
                          className={`px-2.5 py-1.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap ${
                            amount === preset.toString()
                              ? 'bg-amber-500 text-white'
                              : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                          }`}
                        >
                          {preset} DASH
                        </button>
                      ))}
                    </div>

                    {/* Optional message */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        Message (optional)
                      </label>
                      <textarea
                        value={tipMessage}
                        onChange={(e) => setTipMessage(e.target.value)}
                        placeholder="Add a note with your tip..."
                        maxLength={280}
                        rows={2}
                        className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                      />
                      <p className="mt-1 text-xs text-gray-500 text-right">
                        {tipMessage.length}/280
                      </p>
                    </div>

                    {/* Payment method selection */}
                    {paymentUris.length > 0 && (
                      <div className="space-y-2">
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                          Payment Method
                        </label>

                        {/* Platform credits option */}
                        <button
                          type="button"
                          onClick={() => {
                            setPaymentMethod('credits')
                            setSelectedUri(null)
                          }}
                          className={`w-full p-3 rounded-lg border text-left transition-colors ${
                            paymentMethod === 'credits'
                              ? 'border-amber-500 bg-amber-50 dark:bg-amber-900/20'
                              : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <CurrencyDollarIcon className="w-5 h-5 text-amber-500" />
                            <div>
                              <span className="font-medium">Platform Credits</span>
                              <p className="text-xs text-gray-500">Direct transfer via Dash Platform</p>
                            </div>
                          </div>
                        </button>

                        {/* External wallet options */}
                        <p className="text-xs text-gray-500 pt-1">Or send directly to wallet:</p>
                        {paymentUris.map((paymentUri, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => handleExternalPayment(paymentUri.uri)}
                            className="w-full p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 text-left transition-colors"
                          >
                            <div className="flex items-center gap-3">
                              <PaymentSchemeIcon scheme={paymentUri.scheme} />
                              <div className="flex-1 min-w-0">
                                <span className="font-medium">{getPaymentLabel(paymentUri.uri)}</span>
                                <p className="text-xs text-gray-500 font-mono truncate">
                                  {truncateAddress(paymentUri.uri, 20)}
                                </p>
                              </div>
                              <ArrowTopRightOnSquareIcon className="w-4 h-4 text-gray-400" />
                            </div>
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Transfer key input - only show for platform credits */}
                    {paymentMethod === 'credits' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        Transfer Private Key (WIF)
                      </label>
                      <input
                        type="password"
                        value={transferKey}
                        onChange={(e) => setTransferKey(e.target.value)}
                        placeholder="Enter your transfer private key"
                        className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                      />
                      <p className="mt-1 text-xs text-gray-500">
                        Your key is never stored and is cleared after the transaction.
                      </p>
                    </div>
                    )}

                    {/* Error message */}
                    {error && (
                      <p className="text-red-500 text-sm">{error}</p>
                    )}

                    {/* Continue button - only for platform credits */}
                    {paymentMethod === 'credits' && (
                      <Button
                        onClick={handleContinue}
                        className="w-full bg-amber-500 hover:bg-amber-600 text-white"
                        disabled={!amount || !transferKey}
                      >
                        Continue
                      </Button>
                    )}
                  </div>
                )}

                {/* Confirming State */}
                {state === 'confirming' && (
                  <div className="space-y-4">
                    <div className="bg-gray-50 dark:bg-neutral-800 rounded-lg p-4 space-y-2">
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">Amount</span>
                        <span className="font-bold text-lg">{dashAmount} DASH</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-600 dark:text-gray-400">To</span>
                        <span className="font-medium">{recipientName}</span>
                      </div>
                      {tipMessage.trim() && (
                        <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                          <span className="text-gray-600 dark:text-gray-400 text-sm">Message:</span>
                          <p className="text-sm mt-1">{tipMessage}</p>
                        </div>
                      )}
                    </div>

                    <p className="text-sm text-gray-500 text-center">
                      This action cannot be undone.
                    </p>

                    <div className="flex gap-3">
                      <Button
                        onClick={() => setState('input')}
                        variant="outline"
                        className="flex-1"
                      >
                        Back
                      </Button>
                      <Button
                        onClick={handleSendTip}
                        className="flex-1 bg-amber-500 hover:bg-amber-600 text-white"
                      >
                        Confirm & Send
                      </Button>
                    </div>
                  </div>
                )}

                {/* Processing State */}
                {state === 'processing' && (
                  <div className="py-8 text-center space-y-4">
                    <div className="animate-spin rounded-full h-12 w-12 border-4 border-amber-500 border-t-transparent mx-auto" />
                    <p className="text-gray-600 dark:text-gray-400">Sending tip...</p>
                    <p className="text-xs text-gray-500">Please wait, this may take a moment.</p>
                  </div>
                )}

                {/* Success State */}
                {state === 'success' && (
                  <div className="py-4 text-center space-y-4">
                    <CheckCircleIcon className="h-16 w-16 text-green-500 mx-auto" />
                    <div>
                      <p className="text-lg font-medium">Tip sent successfully!</p>
                      <p className="text-gray-600 dark:text-gray-400">
                        You sent {dashAmount} DASH to {recipientName}
                      </p>
                    </div>
                    {balance !== null && (
                      <p className="text-sm text-gray-500">
                        New balance: {tipService.formatDash(tipService.creditsToDash(balance))}
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
                      <Button onClick={handleRetry} className="flex-1">
                        Try Again
                      </Button>
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
