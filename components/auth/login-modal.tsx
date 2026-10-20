'use client'

import { useState, useEffect, useCallback, useId, useRef } from 'react'
import Link from 'next/link'
import * as Dialog from '@radix-ui/react-dialog'
import { usePathname, useRouter } from 'next/navigation'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { X, ChevronDown, ChevronLeft, Wallet, ScrollText, KeyRound } from 'lucide-react'
import type { AppConnectGrant } from 'platform-auth'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { useLoginModal } from '@/hooks/use-login-modal'
import { getConfiguredNetwork } from '@/lib/constants'
import { COMMUNITY_RULES_HREF } from '@/lib/legal'
import { Button } from '@/components/ui/button'
import { AppConnectLoginPanel } from './app-connect-login-panel'
import { appConnectPins, isAppConnectBuild } from '@/lib/app-connect/config'
import { KeyLoginForm } from './key-login-form'
import { PasskeySignIn } from './passkey-sign-in'
import { RecoveryPhraseForm } from './recovery-phrase-form'
import { recoveryPhraseOffered } from '@/lib/auth/recovery-phrase'

/** Where newcomers go: an account starts in the Dash wallet. */
const DASH_WALLET_DOWNLOAD_URL = 'https://www.dash.org/download/'

/** A legal page opened in a new tab, so the sign-in under way is not lost. */
function ConsentLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-gray-700 dark:hover:text-gray-200">
      {children}
      <span className="sr-only"> (opens in new tab)</span>
    </Link>
  )
}

/** Wallet sign-in is offered only where App Connect is set up on this build. */
function walletSignInAvailable(): boolean {
  return isAppConnectBuild() && appConnectPins() !== null
}

/** One collapsible option; its content mounts only while open. */
function Disclosure({
  id,
  open,
  onToggle,
  icon,
  label,
  centered = false,
  children,
}: {
  id: string
  open: boolean
  onToggle: () => void
  icon?: React.ReactNode
  label: string
  centered?: boolean
  children: React.ReactNode
}) {
  const reduceMotion = useReducedMotion()
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className={`w-full flex items-center ${centered ? 'justify-center gap-1' : 'justify-between'} text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors rounded-md py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yappr-500`}
      >
        <span className="flex items-center gap-2">
          {icon}
          {label}
        </span>
        <ChevronDown aria-hidden="true" className={`w-4 h-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={id}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="pt-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

type AdvancedSection = 'phrase' | 'key'

/**
 * Global sign-in dialog.
 *
 * App Connect builds: the Dash wallet is the main way in, a passkey added on
 * an earlier sign-in comes second, and the recovery phrase and private key
 * sit under "Advanced". The wallet request is only made once the wallet
 * option is chosen.
 *
 * Other builds: a passkey where one exists, then private-key sign-in.
 */
export function LoginModal() {
  const router = useRouter()
  const pathname = usePathname()
  const { isOpen, close } = useLoginModal()
  const { loginWithAppConnect } = useAuth()
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  const reduceMotion = useReducedMotion()
  const sectionId = useId()
  const opener = useRef<HTMLElement | null>(null)
  const content = useRef<HTMLDivElement>(null)

  const walletAvailable = walletSignInAvailable()
  const phraseAvailable = walletAvailable && recoveryPhraseOffered(getConfiguredNetwork())
  const [showWallet, setShowWallet] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [advanced, setAdvanced] = useState<AdvancedSection | null>(null)
  const toggleAdvanced = (section: AdvancedSection) => setAdvanced((current) => (current === section ? null : section))

  // Reset to the first view whenever the dialog closes.
  useEffect(() => {
    if (isOpen) return
    setShowWallet(false)
    setShowAdvanced(false)
    setAdvanced(null)
  }, [isOpen])

  const handleClose = useCallback(() => {
    close()
    // If we're on /login, navigate away
    // Next's pathname omits the deployment base path; exports add a trailing slash.
    if (pathname.replace(/\/+$/, '') === '/login') {
      router.push('/')
    }
  }, [close, pathname, router])

  const signInWithGrant = useCallback(async (grant: AppConnectGrant) => {
    await loginWithAppConnect(grant)
  }, [loginWithAppConnect])

  const walletOptions = (
    <div data-testid="sign-in-options">
      <div className="flex flex-col gap-3">
        <Button type="button" size="lg" className="w-full gap-2" onClick={() => setShowWallet(true)}>
          <Wallet aria-hidden="true" className="w-5 h-5" />
          Sign in with your Dash wallet
        </Button>
        <PasskeySignIn onComplete={close} secondary />
      </div>

      <div className="mt-4">
        <Disclosure
          id={`${sectionId}-advanced`}
          open={showAdvanced}
          onToggle={() => setShowAdvanced((value) => !value)}
          label="Advanced"
          centered
        >
          <div className="space-y-4 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
            {phraseAvailable && (
              <Disclosure
                id={`${sectionId}-phrase`}
                open={advanced === 'phrase'}
                onToggle={() => toggleAdvanced('phrase')}
                icon={<ScrollText aria-hidden="true" className="w-4 h-4" />}
                label="Sign in with your recovery phrase"
              >
                <RecoveryPhraseForm onComplete={close} />
              </Disclosure>
            )}
            <Disclosure
              id={`${sectionId}-key`}
              open={advanced === 'key'}
              onToggle={() => toggleAdvanced('key')}
              icon={<KeyRound aria-hidden="true" className="w-4 h-4" />}
              label="Sign in with a private key"
            >
              <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
                {phraseAvailable
                  ? 'Messages, orders and private feeds need your Dash wallet or recovery phrase.'
                  : 'Messages, orders and private feeds need your Dash wallet.'}
              </p>
              <KeyLoginForm onComplete={close} />
            </Disclosure>
          </div>
        </Disclosure>
      </div>
    </div>
  )

  const walletView = (
    <div>
      <button
        type="button"
        onClick={() => setShowWallet(false)}
        className="mb-4 -ml-1 flex items-center gap-1 rounded-md py-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yappr-500"
      >
        <ChevronLeft aria-hidden="true" className="w-4 h-4" />
        Other ways to sign in
      </button>
      <AppConnectLoginPanel onGrant={signInWithGrant} onComplete={close} />
    </div>
  )

  const keyOptions = (
    <>
      <PasskeySignIn onComplete={close} />
      <KeyLoginForm onComplete={close} />
    </>
  )

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) handleClose() }}>
    <AnimatePresence>
      {isOpen && (
        <Dialog.Portal forceMount>
        <Dialog.Overlay asChild>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className={`fixed inset-0 z-50 flex items-center justify-center px-4 bg-black/60 ${potatoMode ? '' : 'backdrop-blur-sm'}`}
        >
          <Dialog.Content
            asChild
            onOpenAutoFocus={(event) => {
              opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
              // Focus the dialog itself rather than ringing the close button on open.
              event.preventDefault()
              content.current?.focus({ preventScroll: true })
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (opener.current?.getClientRects().length) opener.current.focus()
            }}
          >
          <motion.div
            ref={content}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.2 }}
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-neutral-900 rounded-2xl shadow-xl w-full max-w-md relative max-h-[90vh] overflow-y-auto outline-none"
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
              <div className="text-center mb-6">
                <Dialog.Title asChild>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                  Sign in to <span className="text-gradient">Yappr</span>
                </h1>
                </Dialog.Title>
                <Dialog.Description className="sr-only">
                  {walletAvailable ? 'Sign in with your Dash wallet or a passkey.' : 'Sign in with a passkey or a private key.'}
                </Dialog.Description>
              </div>

              {!walletAvailable ? keyOptions : showWallet ? walletView : walletOptions}

              <p className="mt-5 text-xs text-center text-gray-500 dark:text-gray-400">
                By continuing, you agree to the <ConsentLink href="/terms">Terms</ConsentLink>,{' '}
                <ConsentLink href={COMMUNITY_RULES_HREF}>Community Rules</ConsentLink> and{' '}
                <ConsentLink href="/privacy">Privacy Policy</ConsentLink>.
              </p>

              <p className="mt-4 border-t border-gray-100 dark:border-gray-800 pt-4 text-sm text-center text-gray-600 dark:text-gray-400">
                New to Dash?{' '}
                <a
                  href={DASH_WALLET_DOWNLOAD_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-yappr-600 dark:text-yappr-400 hover:underline underline-offset-4"
                >
                  Get the Dash wallet
                  <span className="sr-only"> (opens in new tab)</span>
                </a>
              </p>
            </div>
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
