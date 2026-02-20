'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { useDpnsRegistration } from '@/hooks/use-dpns-registration'
import { dpnsService } from '@/lib/services/dpns-service'
import { identityService, IdentityPublicKey } from '@/lib/services/identity-service'
import { getPrivateKey } from '@/lib/secure-storage'
import { findMatchingKeyIndex, getSecurityLevelName, IdentityPublicKeyInfo } from '@/lib/crypto/keys'
import toast from 'react-hot-toast'

import { UsernameEntryStep } from './steps/username-entry-step'
import { CheckingStep } from './steps/checking-step'
import { ReviewStep } from './steps/review-step'
import { RegisteringStep } from './steps/registering-step'
import { CompleteStep } from './steps/complete-step'

interface DpnsRegistrationWizardProps {
  onComplete?: () => void
  onSkip?: () => void
  hasExistingUsernames?: boolean
}

/**
 * Convert identity public keys to the format expected by findMatchingKeyIndex.
 * Handles both string (base64) and Uint8Array formats for the data field.
 */
function convertToKeyInfo(keys: IdentityPublicKey[]): IdentityPublicKeyInfo[] {
  return keys.map((key) => {
    let data: Uint8Array
    if (key.data instanceof Uint8Array) {
      data = key.data
    } else if (typeof key.data === 'string') {
      // Base64 decode
      data = Uint8Array.from(atob(key.data), (c) => c.charCodeAt(0))
    } else {
      data = new Uint8Array()
    }
    return {
      id: key.id,
      type: key.type,
      purpose: key.purpose,
      securityLevel: key.securityLevel,
      data,
    }
  })
}

export function DpnsRegistrationWizard({ onComplete, onSkip, hasExistingUsernames }: DpnsRegistrationWizardProps): React.ReactNode {
  const router = useRouter()
  const { user, updateDPNSUsername } = useAuth()
  const { isReady: isSdkReady } = useSdk()
  const {
    step,
    usernames,
    setStep,
    updateUsernameStatus,
    setUsernameContested,
    setUsernameRegistered,
    setCurrentRegistrationIndex,
    reset,
  } = useDpnsRegistration()

  const identityId = user?.identityId

  const handleCheckAvailability = useCallback(async () => {
    if (!isSdkReady) {
      toast.error('Service is initializing. Please try again.')
      return
    }

    const validUsernames = usernames.filter(
      (u) => u.label.trim() && u.status !== 'invalid'
    )

    if (validUsernames.length === 0) {
      toast.error('Please enter at least one valid username.')
      return
    }

    setStep('checking')

    try {
      const labels = validUsernames.map((u) => u.label)
      const results = await dpnsService.batchCheckAvailability(labels)

      for (const entry of validUsernames) {
        const result = results.get(entry.label.toLowerCase())
        if (!result) continue

        if (result.error) {
          updateUsernameStatus(entry.id, 'invalid', result.error)
        } else if (!result.available) {
          updateUsernameStatus(entry.id, 'taken')
        } else if (result.contested) {
          updateUsernameStatus(entry.id, 'contested')
          setUsernameContested(entry.id, true)
        } else {
          updateUsernameStatus(entry.id, 'available')
        }
      }

      setStep('review')
    } catch (error) {
      console.error('Failed to check availability:', error)
      toast.error('Failed to check availability. Please try again.')
      setStep('username-entry')
    }
  }, [isSdkReady, usernames, setStep, updateUsernameStatus, setUsernameContested])

  const handleRegister = useCallback(async () => {
    if (!identityId) {
      toast.error('No identity found. Please log in again.')
      return
    }

    const privateKey = getPrivateKey(identityId)
    if (!privateKey) {
      toast.error('Authentication required. Please log in again.')
      return
    }

    const availableUsernames = usernames.filter(
      (u) => u.status === 'available' || u.status === 'contested'
    )

    if (availableUsernames.length === 0) {
      toast.error('No available usernames to register.')
      return
    }

    setStep('registering')
    setCurrentRegistrationIndex(0)

    try {
      const identity = await identityService.getIdentity(identityId)
      if (!identity) {
        toast.error('Identity not found.')
        setStep('review')
        return
      }

      // Determine network from environment
      const network = (process.env.NEXT_PUBLIC_NETWORK as 'testnet' | 'mainnet') || 'testnet'

      // Convert identity public keys to the format expected by findMatchingKeyIndex
      const keyInfos = convertToKeyInfo(identity.publicKeys)

      // Find which key matches the user's private key
      const matchedKey = findMatchingKeyIndex(privateKey, keyInfos, network)
      if (!matchedKey) {
        toast.error('Your private key does not match any key on this identity.')
        setStep('review')
        return
      }

      // Verify the matched key has sufficient security level for DPNS (CRITICAL or HIGH)
      if (matchedKey.securityLevel !== 1 && matchedKey.securityLevel !== 2) {
        const levelName = getSecurityLevelName(matchedKey.securityLevel)
        toast.error(`Your key has ${levelName} security level. DPNS requires CRITICAL or HIGH security level.`)
        setStep('review')
        return
      }

      const registrations = availableUsernames.map((u) => ({
        label: u.label,
        identityId,
        publicKeyId: matchedKey.keyId,
        privateKeyWif: privateKey,
      }))

      const results = await dpnsService.registerUsernamesSequentially(
        registrations,
        (index) => setCurrentRegistrationIndex(index)
      )

      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        const entry = availableUsernames[i]
        setUsernameRegistered(entry.id, result.success, result.error)
        if (result.isContested) {
          setUsernameContested(entry.id, true)
        }
      }

      const firstSuccess = results.find((r) => r.success)
      if (firstSuccess) {
        updateDPNSUsername(firstSuccess.label)
        toast.success('Username registered successfully!')
      }

      setStep('complete')
    } catch (error) {
      console.error('Registration failed:', error)
      const errorMessage = error instanceof Error ? error.message : 'Registration failed. Please try again.'
      toast.error(errorMessage)
      // Mark any pending usernames as failed
      for (const entry of availableUsernames) {
        setUsernameRegistered(entry.id, false, 'Registration interrupted')
      }
      setStep('complete')
    }
  }, [
    identityId,
    usernames,
    setStep,
    setCurrentRegistrationIndex,
    setUsernameRegistered,
    setUsernameContested,
    updateDPNSUsername,
  ])

  const handleBackToEdit = useCallback(() => {
    for (const entry of usernames) {
      if (entry.status !== 'invalid') {
        updateUsernameStatus(entry.id, 'pending')
      }
    }
    setStep('username-entry')
  }, [usernames, updateUsernameStatus, setStep])

  const handleRegisterMore = useCallback(() => {
    reset()
  }, [reset])

  const handleContinue = useCallback(() => {
    onComplete?.()
    router.push('/profile/create')
  }, [onComplete, router])

  return (
    <div className="space-y-6">
      {step === 'username-entry' && (
        <UsernameEntryStep onCheckAvailability={handleCheckAvailability} />
      )}

      {step === 'checking' && <CheckingStep />}

      {step === 'review' && (
        <ReviewStep onBack={handleBackToEdit} onRegister={handleRegister} hasExistingUsernames={hasExistingUsernames} />
      )}

      {step === 'registering' && <RegisteringStep />}

      {step === 'complete' && (
        <CompleteStep onRegisterMore={handleRegisterMore} onContinue={handleContinue} />
      )}

      {step === 'username-entry' && onSkip && (
        <button
          type="button"
          onClick={onSkip}
          className="w-full text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
        >
          Skip for now
        </button>
      )}
    </div>
  )
}
