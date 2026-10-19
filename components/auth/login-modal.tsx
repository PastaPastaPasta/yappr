'use client'

import { useState, useEffect, useCallback, useId, useRef } from 'react'
import Link from 'next/link'
import * as Dialog from '@radix-ui/react-dialog'
import { usePathname, useRouter } from 'next/navigation'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { X, ChevronDown, Wallet, ScrollText, KeyRound } from 'lucide-react'
import type { AppConnectGrant } from 'platform-auth'
import { useAuth } from '@/contexts/auth-context'
import { useSettingsStore } from '@/lib/store'
import { useLoginModal } from '@/hooks/use-login-modal'
import { identityBridgeUrl } from '@/lib/identity-bridge'
import { getConfiguredNetwork } from '@/lib/constants'
import { COMMUNITY_RULES_HREF, MINIMUM_AGE } from '@/lib/legal'
import { AppConnectLoginPanel } from './app-connect-login-panel'
import { appConnectPins, isAppConnectBuild } from '@/lib/app-connect/config'
import { KeyLoginForm } from './key-login-form'
import { PasskeySignIn } from './passkey-sign-in'
import { RecoveryPhraseForm } from './recovery-phrase-form'

/** Where newcomers go: the wallet on mainnet, the identity bridge elsewhere. */
const DASH_WALLET_DOWNLOAD_URL = 'https://www.dash.org/download/'

function newUserLink(): { href: string; label: string } {
  return getConfiguredNetwork() === 'mainnet'
    ? { href: DASH_WALLET_DOWNLOAD_URL, label: 'Get the Dash wallet' }
    : { href: identityBridgeUrl(), label: 'Create a Dash identity' }
}

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

type Section = 'wallet' | 'phrase' | 'key'

/** One collapsible sign-in option; its content mounts only while open (the wallet request is made on opening). */
function Disclosure({
  id,
  open,
  onToggle,
  icon,
  label,
  children,
}: {
  id: string
  open: boolean
  onToggle: () => void
  icon: React.ReactNode
  label: string
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
        className="w-full flex items-center justify-between text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors rounded-md py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yappr-500"
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

/**
 * Global sign-in dialog.
 *
 * App Connect builds (D38): the Dash wallet first, then the wallet's recovery
 * phrase, both of which unlock messaging with the key the wallet uses;
 * private-key sign-in sits under "Advanced". Each opens on demand, one at a
 * time, so the wallet request is only made once its option is opened.
 *
 * Other builds: private-key sign-in is the primary path, with the way to
 * create an identity right under it.
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

  const newUser = newUserLink()
  const walletAvailable = walletSignInAvailable()
  const [open, setOpen] = useState<Section | null>(null)
  const toggle = (section: Section) => setOpen((current) => (current === section ? null : section))

  // Reset to the primary view whenever the dialog closes.
  useEffect(() => {
    if (!isOpen) setOpen(null)
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
            onOpenAutoFocus={() => {
              opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault()
              if (opener.current?.getClientRects().length) opener.current.focus()
            }}
          >
          <motion.div
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
                <Dialog.Title asChild>
                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                  Sign in to <span className="text-gradient">Yappr</span>
                </h1>
                </Dialog.Title>
                <Dialog.Description asChild>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {walletAvailable ? 'Sign in with your Dash wallet.' : 'Sign in with your Dash identity\'s private key.'}
                </p>
                </Dialog.Description>
              </div>

              {/* Fastest where it works: a passkey added on an earlier sign-in */}
              <PasskeySignIn onComplete={close} />

              {walletAvailable ? (
                <div className="space-y-4" data-testid="sign-in-options">
                  <Disclosure
                    id={`${sectionId}-wallet`}
                    open={open === 'wallet'}
                    onToggle={() => toggle('wallet')}
                    icon={<Wallet aria-hidden="true" className="w-4 h-4" />}
                    label="Sign in with your Dash wallet"
                  >
                    <p className="mb-4 text-xs text-center text-gray-500 dark:text-gray-400">
                      Wallet sign-in is coming to the Dash wallet apps soon. If yours already supports it, scan this code with it.
                    </p>
                    <AppConnectLoginPanel onGrant={signInWithGrant} onComplete={close} />
                  </Disclosure>
                  <Disclosure
                    id={`${sectionId}-phrase`}
                    open={open === 'phrase'}
                    onToggle={() => toggle('phrase')}
                    icon={<ScrollText aria-hidden="true" className="w-4 h-4" />}
                    label="Sign in with your recovery phrase"
                  >
                    <RecoveryPhraseForm onComplete={close} />
                  </Disclosure>
                  <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
                    <Disclosure
                      id={`${sectionId}-key`}
                      open={open === 'key'}
                      onToggle={() => toggle('key')}
                      icon={<KeyRound aria-hidden="true" className="w-4 h-4" />}
                      label="Advanced: sign in with a private key"
                    >
                      <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
                        A private key signs you in to post and browse. To use messages, store orders and private feeds,
                        sign in with your Dash wallet or your recovery phrase.
                      </p>
                      <KeyLoginForm onComplete={close} />
                    </Disclosure>
                  </div>
                </div>
              ) : (
                <KeyLoginForm onComplete={close} />
              )}
              <p className="mt-3 text-xs text-center text-gray-600 dark:text-gray-400">
                By continuing, you agree to the <ConsentLink href="/terms">Terms</ConsentLink> and{' '}
                <ConsentLink href={COMMUNITY_RULES_HREF}>Community Rules</ConsentLink> and confirm you are {MINIMUM_AGE} or
                older. The <ConsentLink href="/privacy">Privacy Policy</ConsentLink> explains what is public. Yappr has no centralized moderation.
              </p>

              {/* New users */}
              <div className="mt-5 rounded-xl bg-gray-50 dark:bg-neutral-800/60 px-4 py-3 text-center">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Don&apos;t have a Dash identity yet?
                </p>
                <a
                  href={newUser.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 inline-block text-sm font-semibold text-yappr-600 dark:text-yappr-400 hover:underline underline-offset-4"
                >
                  {newUser.label}
                </a>
              </div>
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
