'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { XMarkIcon, CurrencyDollarIcon, QrCodeIcon, WalletIcon, BookmarkIcon } from '@heroicons/react/24/outline'
import { CheckCircleIcon, ExclamationCircleIcon } from '@heroicons/react/24/solid'
import { motion, AnimatePresence } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { useTipModal } from '@/hooks/use-tip-modal'
import { useAuth } from '@/contexts/auth-context'
import { tipService, MIN_TIP_CREDITS } from '@/lib/services/tip-service'
import { identityService } from '@/lib/services/identity-service'
import { PaymentSchemeIcon, getPaymentLabel, truncateAddress, PAYMENT_SCHEME_LABELS } from '@/components/ui/payment-icons'
import { PaymentQRCodeDialog } from '@/components/ui/payment-qr-dialog'
import type { ParsedPaymentUri } from '@/lib/types'
import {
  getTransferKey,
  hasTransferKey,
  storeTransferKey,
} from '@/lib/secure-storage'

// Preset tip amounts in DASH
const PRESET_AMOUNTS = [0.001, 0.005, 0.01, 0.05]

type ModalState = 'input' | 'confirming' | 'processing' | 'success' | 'save-prompt' | 'error'
type PaymentTab = 'credits' | 'crypto'
type KeySource = 'prefilled' | 'manual' | null

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

  const [amount, setAmount] = useState('')
  const [tipMessage, setTipMessage] = useState('')
  const [transferKey, setTransferKey] = useState('')
  const [state, setState] = useState<ModalState>('input')
  const [error, setError] = useState<string | null>(null)
  const [balance, setBalance] = useState<number | null>(null)
  const [loadingBalance, setLoadingBalance] = useState(false)

  // Payment URI support
  const [paymentUris, setPaymentUris] = useState<ParsedPaymentUri[]>([])
  const [activeTab, setActiveTab] = useState<PaymentTab>('credits')
  const [selectedQrPayment, setSelectedQrPayment] = useState<ParsedPaymentUri | null>(null)
  const [showQrDialog, setShowQrDialog] = useState(false)

  // Transfer key persistence
  const [keySource, setKeySource] = useState<KeySource>(null)
  const usedTransferKeyRef = useRef<string | null>(null)

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
    if (isOpen && recipientInfo) {
      import('@/lib/services/unified-profile-service')
        .then(({ unifiedProfileService }) => unifiedProfileService.getPaymentUris(recipientInfo.id))
        .then(uris => setPaymentUris(uris))
        .catch(() => setPaymentUris([]))
    }
  }, [isOpen, recipientInfo])

  // Check for stored transfer key when modal opens
  useEffect(() => {
    if (isOpen && user) {
      const storedKey = getTransferKey(user.identityId)
      if (storedKey) {
        setTransferKey(storedKey)
        setKeySource('prefilled')
      } else {
        setKeySource(null)
      }
    }
  }, [isOpen, user])

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      setAmount('')
      setTipMessage('')
      setTransferKey('')
      setState('input')
      setError(null)
      setActiveTab('credits')
      setPaymentUris([])
      setSelectedQrPayment(null)
      setShowQrDialog(false)
      setKeySource(null)
      usedTransferKeyRef.current = null
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

  const handleTransferKeyChange = (value: string) => {
    setTransferKey(value)
    // If user types anything different from the prefilled key, mark as manual
    if (keySource === 'prefilled' && user) {
      const storedKey = getTransferKey(user.identityId)
      if (value !== storedKey) {
        setKeySource('manual')
      }
    } else if (value && keySource === null) {
      setKeySource('manual')
    }
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
    if (!user || !recipientInfo) return

    setState('processing')

    const dashAmount = parseFloat(amount)
    const credits = tipService.dashToCredits(dashAmount)

    // Store key for potential save-for-later prompt
    // postId is null for user-only tipping (no tip post will be created)
    const keyToUse = transferKey
    if (keySource === 'manual') {
      usedTransferKeyRef.current = keyToUse
    }

    const result = await tipService.sendTip(
      user.identityId,
      recipientInfo.id,
      post?.id || null,
      credits,
      keyToUse,
      tipMessage.trim() || undefined
    )

    // Clear sensitive data from input immediately
    setTransferKey('')

    if (result.success) {
      // Refresh balance display and persist to auth context
      identityService.getBalance(user.identityId)
        .then(b => setBalance(b.confirmed))
        .catch(() => {})
      // Update global balance in auth context (persists to localStorage)
      refreshBalance().catch(err => console.error('Failed to refresh balance:', err))

      // If key was manually entered and not already saved, offer to save
      if (keySource === 'manual' && usedTransferKeyRef.current && !hasTransferKey(user.identityId)) {
        setState('save-prompt')
      } else {
        setState('success')
      }
    } else {
      usedTransferKeyRef.current = null
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

  // Handle saving the transfer key for future use
  const handleSaveKey = () => {
    if (!user || !usedTransferKeyRef.current) {
      setState('success')
      return
    }

    // Store the key locally and go to success
    storeTransferKey(user.identityId, usedTransferKeyRef.current)
    usedTransferKeyRef.current = null
    setState('success')
  }

  const handleSkipSave = () => {
    usedTransferKeyRef.current = null
    setState('success')
  }

  // Handle showing QR code for an external payment URI
  const handleShowQr = (paymentUri: ParsedPaymentUri) => {
    setSelectedQrPayment(paymentUri)
    setShowQrDialog(true)
  }

  // Handle closing QR dialog
  const handleCloseQrDialog = () => {
    setShowQrDialog(false)
    setSelectedQrPayment(null)
  }


  if (!recipientInfo) return null

  const dashAmount = parseFloat(amount) || 0
  const recipientName = recipientInfo.displayName || recipientInfo.username || 'this user'

  return (
    <>
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

                    {/* Tab Navigation - only show if there are external payment options */}
                    {paymentUris.length > 0 && (
                      <div className="flex rounded-lg bg-gray-100 dark:bg-neutral-800 p-1">
                        <button
                          type="button"
                          onClick={() => setActiveTab('credits')}
                          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                            activeTab === 'credits'
                              ? 'bg-white dark:bg-neutral-700 text-amber-600 dark:text-amber-400 shadow-sm'
                              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                          }`}
                        >
                          <CurrencyDollarIcon className="w-4 h-4" />
                          Platform Credits
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveTab('crypto')}
                          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                            activeTab === 'crypto'
                              ? 'bg-white dark:bg-neutral-700 text-amber-600 dark:text-amber-400 shadow-sm'
                              : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                          }`}
                        >
                          <WalletIcon className="w-4 h-4" />
                          Other Crypto
                          <span className="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-gray-200 dark:bg-neutral-600">
                            {paymentUris.length}
                          </span>
                        </button>
                      </div>
                    )}

                    {/* Credits Tab Content */}
                    {activeTab === 'credits' && (
                      <div className="space-y-4">
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

                        {/* Transfer key input */}
                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                            Transfer Private Key (WIF)
                          </label>
                          <div className="relative">
                            <input
                              type="password"
                              value={transferKey}
                              onChange={(e) => handleTransferKeyChange(e.target.value)}
                              placeholder="Enter your transfer private key"
                              className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                            />
                            {keySource === 'prefilled' && (
                              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-2 py-0.5 rounded-full">
                                Saved
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-gray-500">
                            {keySource === 'prefilled'
                              ? 'Using your saved transfer key.'
                              : 'Your key is cleared after the transaction unless you choose to save it.'}
                          </p>
                        </div>

                        {/* Error message */}
                        {error && (
                          <p className="text-red-500 text-sm">{error}</p>
                        )}

                        {/* Continue button */}
                        <Button
                          onClick={handleContinue}
                          className="w-full bg-amber-500 hover:bg-amber-600 text-white"
                          disabled={!amount || !transferKey}
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
                                onClick={() => handleShowQr(paymentUri)}
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

                {/* Save Prompt State - offer to save manually entered key */}
                {state === 'save-prompt' && (
                  <div className="py-4 space-y-4">
                    <div className="text-center">
                      <CheckCircleIcon className="h-12 w-12 text-green-500 mx-auto mb-2" />
                      <p className="text-lg font-medium">Tip sent successfully!</p>
                      <p className="text-gray-600 dark:text-gray-400">
                        You sent {dashAmount} DASH to {recipientName}
                      </p>
                    </div>

                    <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-4">
                      <div className="flex items-start gap-3">
                        <BookmarkIcon className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <p className="font-medium text-amber-800 dark:text-amber-300">
                            Save transfer key for future tips?
                          </p>
                          <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
                            Your transfer key will be securely stored so you won&apos;t need to enter it again.
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="flex gap-3">
                      <Button
                        onClick={handleSkipSave}
                        variant="outline"
                        className="flex-1"
                      >
                        No thanks
                      </Button>
                      <Button
                        onClick={handleSaveKey}
                        className="flex-1 bg-amber-500 hover:bg-amber-600 text-white"
                      >
                        Save key
                      </Button>
                    </div>
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
