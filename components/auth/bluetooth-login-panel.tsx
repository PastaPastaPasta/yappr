'use client'

import { logger } from '@/lib/logger'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Bluetooth, CheckCircle, Smartphone } from 'lucide-react'
import {
  clearSensitiveBytes,
  decodeYapprContractId,
  decryptYapprLoginKey,
  deriveYapprAuthKeyFromLogin,
  deriveYapprSharedSecret,
  generateYapprEphemeralKeyPair,
  getYapprPublicKey,
} from 'platform-auth'
import { useAuth } from '@/contexts/auth-context'
import { YAPPR_CONTRACT_ID, getConfiguredNetwork } from '@/lib/constants'
import {
  BluetoothLoginError,
  BluetoothLoginStatus,
  bluetoothPairingCode,
  buildBluetoothLoginRequest,
  exchangeLoginKeyOverBluetooth,
  parseBluetoothLoginResponse,
  requestBluetoothWallet,
} from '@/lib/auth/bluetooth-login'
import { checkAuthKeyRegistered } from '@/lib/services/identity-update-builder'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

interface BluetoothLoginPanelProps {
  onComplete: () => void
  onBack: () => void
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'choosing' }
  | { kind: 'connecting' }
  | { kind: 'awaiting-confirmation'; pairingCode: string }
  | { kind: 'registering'; pairingCode: string }
  | { kind: 'unlocking' }
  | { kind: 'checking' }
  | { kind: 'signing-in' }
  | { kind: 'done' }
  | { kind: 'error'; message: string }

/** How long to wait for the phone's key registration to show up on chain. */
const KEY_VISIBLE_TIMEOUT_MS = 90_000
const KEY_VISIBLE_POLL_MS = 3_000

/**
 * "Sign in with your phone": the Bluetooth alternative to the QR panel.
 *
 * The user taps the button (Web Bluetooth needs a gesture), picks the phone
 * from the browser's chooser, reads the six-digit pairing code off this
 * panel and confirms it on the phone. The phone registers a budget- and
 * expiry-limited authentication key and sends the login key it was derived
 * from; this panel decrypts it, waits until the key is visible on Platform,
 * then signs in through the same login-key path as the QR flow.
 */
export function BluetoothLoginPanel({ onComplete, onBack }: BluetoothLoginPanelProps) {
  const { loginWithKeyExchange } = useAuth()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  const update = useCallback((next: Phase) => {
    if (mountedRef.current) setPhase(next)
  }, [])

  const start = useCallback(async () => {
    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort

    update({ kind: 'choosing' })
    let device: BluetoothDevice
    try {
      device = await requestBluetoothWallet()
    } catch (err) {
      update({ kind: 'error', message: err instanceof Error ? err.message : 'Could not open the Bluetooth chooser' })
      return
    }

    const ephemeral = generateYapprEphemeralKeyPair()
    const pairingCode = bluetoothPairingCode(ephemeral.publicKey)
    let loginKey: Uint8Array | null = null
    try {
      update({ kind: 'connecting' })
      const requestBytes = buildBluetoothLoginRequest(
        {
          appEphemeralPubKey: ephemeral.publicKey,
          contractId: decodeYapprContractId(YAPPR_CONTRACT_ID),
          label: 'Login to Yappr',
        },
        getConfiguredNetwork(),
      )

      const responseBytes = await exchangeLoginKeyOverBluetooth(device, requestBytes, {
        signal: abort.signal,
        onStatus: (status) => {
          if (status === BluetoothLoginStatus.AwaitingConfirmation || status === BluetoothLoginStatus.Idle) {
            update({ kind: 'awaiting-confirmation', pairingCode })
          } else if (status === BluetoothLoginStatus.Registering) {
            update({ kind: 'registering', pairingCode })
          }
        },
      })
      if (abort.signal.aborted) return

      update({ kind: 'unlocking' })
      const response = parseBluetoothLoginResponse(responseBytes)
      const sharedSecret = deriveYapprSharedSecret(ephemeral.privateKey, response.walletEphemeralPubKey)
      try {
        loginKey = await decryptYapprLoginKey(response.encryptedPayload, sharedSecret)
      } finally {
        clearSensitiveBytes(sharedSecret)
      }

      // The phone broadcast the key registration just before answering, so
      // give Platform a moment to serve it before the session is built.
      update({ kind: 'checking' })
      const authKey = deriveYapprAuthKeyFromLogin(loginKey, response.identityIdBytes)
      const authPublicKey = getYapprPublicKey(authKey)
      clearSensitiveBytes(authKey)
      const registered = await waitForAuthKey(response.identityId, authPublicKey, abort.signal)
      if (abort.signal.aborted) return
      if (!registered) {
        throw new BluetoothLoginError('The phone said it registered a key, but Platform does not show it yet. Try again in a minute.')
      }

      update({ kind: 'signing-in' })
      await loginWithKeyExchange(response.identityId, loginKey, response.keyId)
      if (!mountedRef.current) return
      update({ kind: 'done' })
      setTimeout(() => {
        if (mountedRef.current) onComplete()
      }, 1200)
    } catch (err) {
      if (abort.signal.aborted) return
      logger.error('Bluetooth login failed:', err)
      update({ kind: 'error', message: err instanceof Error ? err.message : 'Sign-in failed' })
    } finally {
      clearSensitiveBytes(ephemeral.privateKey)
      if (loginKey) clearSensitiveBytes(loginKey)
    }
  }, [loginWithKeyExchange, onComplete, update])

  switch (phase.kind) {
    case 'idle':
      return (
        <PanelPrompt
          tone="brand"
          icon={<Bluetooth className="w-7 h-7" />}
          title="Sign in with your phone"
          description="On your phone, open the identity and choose “Share Login Key with Browser”, then pick it here."
        >
          <div className="w-full space-y-2">
            <Button className="w-full" size="lg" onClick={start}>
              <Bluetooth className="w-4 h-4 mr-2" />
              Find my phone
            </Button>
            <Button variant="ghost" className="w-full" onClick={onBack}>
              Back to the QR code
            </Button>
          </div>
        </PanelPrompt>
      )

    case 'choosing':
      return <PanelSpinner label="Pick your phone in the Bluetooth list" />

    case 'connecting':
      return <PanelSpinner label="Connecting to your phone" />

    case 'awaiting-confirmation':
    case 'registering':
      return (
        <PanelStatus>
          <StatusBadge tone="brand"><Smartphone className="w-7 h-7" /></StatusBadge>
          <div className="text-center">
            <p className="font-medium text-gray-900 dark:text-white">
              {phase.kind === 'registering' ? 'Your phone is registering the key' : 'Confirm on your phone'}
            </p>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 max-w-xs">
              {phase.kind === 'registering'
                ? 'Waiting for Platform to accept it.'
                : 'Only confirm if your phone shows this pairing code.'}
            </p>
          </div>
          <p
            className="font-mono text-3xl font-bold tracking-[0.3em] text-gray-900 dark:text-white"
            aria-label={`Pairing code ${phase.pairingCode.split('').join(' ')}`}
          >
            {phase.pairingCode}
          </p>
          {phase.kind === 'registering' && <Spinner size="sm" />}
        </PanelStatus>
      )

    case 'unlocking':
      return <PanelSpinner label="Phone approved. Unlocking your keys" />

    case 'checking':
      return <PanelSpinner label="Checking your identity" />

    case 'signing-in':
      return <PanelSpinner label="Signing you in" />

    case 'done':
      return (
        <PanelStatus>
          <StatusBadge tone="success"><CheckCircle className="w-7 h-7" /></StatusBadge>
          <p className="font-medium text-gray-900 dark:text-white">Signed in</p>
        </PanelStatus>
      )

    case 'error':
      return (
        <PanelPrompt
          tone="error"
          icon={<AlertCircle className="w-6 h-6" />}
          title="Couldn't sign in over Bluetooth"
          description={phase.message}
        >
          <div className="w-full space-y-2">
            <Button className="w-full" onClick={start}>Try again</Button>
            <Button variant="ghost" className="w-full" onClick={onBack}>Back to the QR code</Button>
          </div>
        </PanelPrompt>
      )

    default:
      return null
  }
}

/** Poll Platform until the auth key is visible, the deadline passes, or the signal aborts. */
async function waitForAuthKey(identityId: string, authPublicKey: Uint8Array, signal: AbortSignal): Promise<boolean> {
  const deadline = Date.now() + KEY_VISIBLE_TIMEOUT_MS
  while (!signal.aborted && Date.now() < deadline) {
    try {
      if (await checkAuthKeyRegistered(identityId, authPublicKey)) return true
    } catch (err) {
      logger.warn('Bluetooth login: key registration check failed, retrying', err)
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, KEY_VISIBLE_POLL_MS)
      const onAbort = () => { clearTimeout(timer); resolve() }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
  return false
}

function PanelSpinner({ label }: { label: string }) {
  return (
    <PanelStatus>
      <Spinner size="lg" />
      <p className="text-sm text-gray-600 dark:text-gray-400">{label}</p>
    </PanelStatus>
  )
}

function PanelPrompt({
  tone,
  icon,
  title,
  description,
  children,
}: {
  tone: StatusTone
  icon: React.ReactNode
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <PanelStatus>
      <StatusBadge tone={tone}>{icon}</StatusBadge>
      <div className="text-center">
        <p className="font-medium text-gray-900 dark:text-white">{title}</p>
        <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 max-w-xs">{description}</p>
      </div>
      {children}
    </PanelStatus>
  )
}

function PanelStatus({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 py-8" role="status" aria-live="polite">
      {children}
    </div>
  )
}

type StatusTone = 'success' | 'error' | 'brand'

function StatusBadge({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  const toneClass = {
    success: 'bg-green-50 text-green-600 dark:bg-green-900/20 dark:text-green-400',
    error: 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400',
    brand: 'bg-yappr-100 text-yappr-600 dark:bg-yappr-900/30 dark:text-yappr-400',
  }[tone]
  return <div className={`p-3 rounded-full ${toneClass}`}>{children}</div>
}
