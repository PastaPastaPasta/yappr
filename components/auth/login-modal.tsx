'use client'

import { useState, useEffect, useCallback, useId } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { X, KeyRound, ChevronDown } from 'lucide-react'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { useLoginModal } from '@/hooks/use-login-modal'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { WalletLoginPanel } from './wallet-login-panel'
import { KeyLoginForm } from './key-login-form'

/**
 * Global sign-in dialog.
 *
 * Wallet sign-in is the primary path: opening the dialog immediately shows a
 * dash-key: QR code for the user's Dash wallet. A passkey button sits under
 * it for returning users on an enrolled device. Password and private-key
 * entry live behind a collapsed "more ways to sign in" disclosure.
 */
export function LoginModal() {
  const router = useRouter()
  const { isOpen, close } = useLoginModal()
  const { loginWithPasskey } = useAuth()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const reduceMotion = useReducedMotion()
  const titleId = useId()
  const advancedId = useId()

  const [showAdvanced, setShowAdvanced] = useState(false)
  const [walletKey, setWalletKey] = useState(0)
  const [passkeyBusy, setPasskeyBusy] = useState(false)
  const [passkeyError, setPasskeyError] = useState<string | null>(null)

  // Reset to the primary view whenever the dialog closes.
  useEffect(() => {
    if (!isOpen) {
      setShowAdvanced(false)
      setPasskeyBusy(false)
      setPasskeyError(null)
    }
  }, [isOpen])

  const handleClose = useCallback(() => {
    close()
    // If we're on /login, navigate away
    if (typeof window !== 'undefined' && window.location.pathname === '/login') {
      router.push('/')
    }
  }, [close, router])

  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isOpen, handleClose])

  const handlePasskey = async () => {
    setPasskeyError(null)
    setPasskeyBusy(true)
    try {
      await loginWithPasskey()
      close()
    } catch (err) {
      setPasskeyError(err instanceof Error ? err.message : 'Passkey sign-in failed')
    } finally {
      setPasskeyBusy(false)
    }
  }

  // Backing out of first-time key registration restarts the wallet request
  // with a fresh code rather than leaving a dead panel behind.
  const restartWallet = useCallback(() => setWalletKey((k) => k + 1), [])

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleClose}
          className={`fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/60 ${potatoMode ? '' : 'backdrop-blur-sm'}`}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.2 }}
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-neutral-900 rounded-2xl shadow-xl w-full max-w-md relative max-h-[90vh] overflow-y-auto"
          >
            <button
              type="button"
              onClick={handleClose}
              aria-label="Close"
              className="absolute top-3 right-3 z-10 p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yappr-500"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="px-6 pt-7 pb-6">
              {/* Header */}
              <div className="text-center mb-6">
                <h1 id={titleId} className="text-2xl font-bold text-gray-900 dark:text-white">
                  Sign in to <span className="text-gradient">Yappr</span>
                </h1>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  Scan the code with your Dash wallet to sign in.
                </p>
              </div>

              {/* Primary: wallet */}
              <WalletLoginPanel key={walletKey} onComplete={close} onCancel={restartWallet} />

              {/* Secondary: passkey */}
              <div className="mt-6">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  className="w-full"
                  disabled={passkeyBusy}
                  onClick={handlePasskey}
                >
                  {passkeyBusy ? (
                    <Spinner size="sm" className="mr-2" />
                  ) : (
                    <KeyRound className="w-4 h-4 mr-2" />
                  )}
                  Sign in with a passkey
                </Button>
                {passkeyError && (
                  <p className="mt-2 text-xs text-red-500 dark:text-red-400" aria-live="polite">
                    {passkeyError}
                  </p>
                )}
              </div>

              {/* Advanced: password / private key */}
              <div className="mt-5 border-t border-gray-100 dark:border-gray-800 pt-4">
                <button
                  type="button"
                  aria-expanded={showAdvanced}
                  aria-controls={advancedId}
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="w-full flex items-center justify-between text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors rounded-md py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yappr-500"
                >
                  <span>{showAdvanced ? 'Hide password and key sign-in' : 'Sign in with a password or private key'}</span>
                  <ChevronDown
                    aria-hidden="true"
                    className={`w-4 h-4 transition-transform duration-200 ${showAdvanced ? 'rotate-180' : ''}`}
                  />
                </button>
                <AnimatePresence initial={false}>
                  {showAdvanced && (
                    <motion.div
                      id={advancedId}
                      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <div className="pt-4">
                        <KeyLoginForm onComplete={close} />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* New users */}
              <p className="mt-5 text-center text-sm text-gray-600 dark:text-gray-400">
                New to Dash?{' '}
                <a
                  href="https://bridge.thepasta.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-yappr-600 dark:text-yappr-400 hover:underline underline-offset-4"
                >
                  Create an identity
                </a>
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
