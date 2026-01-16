'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { useDpnsRegistration } from '@/hooks/use-dpns-registration'
import { dpnsService } from '@/lib/services/dpns-service'
import { identityService } from '@/lib/services/identity-service'
import { getPrivateKey } from '@/lib/secure-storage'
import toast from 'react-hot-toast'

import { UsernameEntryStep } from './steps/username-entry-step'
import { CheckingStep } from './steps/checking-step'
import { ReviewStep } from './steps/review-step'
import { RegisteringStep } from './steps/registering-step'
import { CompleteStep } from './steps/complete-step'

interface DpnsRegistrationWizardProps {
  onComplete?: () => void
  onSkip?: () => void
}

export function DpnsRegistrationWizard({ onComplete, onSkip }: DpnsRegistrationWizardProps) {
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

  // Check availability for all valid usernames
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

      // Update each username with results
      for (const entry of validUsernames) {
        const result = results.get(entry.label.toLowerCase())
        if (result) {
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
      }

      setStep('review')
    } catch (error) {
      console.error('Failed to check availability:', error)
      toast.error('Failed to check availability. Please try again.')
      setStep('username-entry')
    }
  }, [isSdkReady, usernames, setStep, updateUsernameStatus, setUsernameContested])

  // Handle registration
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

    // Get identity to find suitable key
    const identity = await identityService.getIdentity(identityId)
    if (!identity) {
      toast.error('Identity not found.')
      return
    }

    // Find suitable key (CRITICAL or HIGH security level)
    const suitableKey = identity.publicKeys.find((key: { id: number; securityLevel: number; disabledAt?: number }) => {
      const keySecurityLevel = key.securityLevel
      const keyDisabledAt = key.disabledAt
      return !keyDisabledAt && (keySecurityLevel === 1 || keySecurityLevel === 2)
    })

    if (!suitableKey) {
      toast.error('No suitable key found. DPNS requires CRITICAL or HIGH security level key.')
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

    // Register each username sequentially
    const registrations = availableUsernames.map((u) => ({
      label: u.label,
      identityId,
      publicKeyId: suitableKey.id,
      privateKeyWif: privateKey,
    }))

    const results = await dpnsService.registerUsernamesSequentially(
      registrations,
      (index) => {
        setCurrentRegistrationIndex(index)
      }
    )

    // Update usernames with results
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const entry = availableUsernames[i]
      setUsernameRegistered(entry.id, result.success, result.error)
      if (result.isContested) {
        setUsernameContested(entry.id, true)
      }
    }

    // Update auth context with first successful username
    const firstSuccess = results.find((r) => r.success)
    if (firstSuccess) {
      updateDPNSUsername(firstSuccess.label)
      toast.success('Username registered successfully!')
    }

    setStep('complete')
  }, [
    identityId,
    usernames,
    setStep,
    setCurrentRegistrationIndex,
    setUsernameRegistered,
    setUsernameContested,
    updateDPNSUsername,
  ])

  // Handle back to edit
  const handleBackToEdit = useCallback(() => {
    // Reset statuses to pending for re-checking
    for (const entry of usernames) {
      if (entry.status !== 'invalid') {
        updateUsernameStatus(entry.id, 'pending')
      }
    }
    setStep('username-entry')
  }, [usernames, updateUsernameStatus, setStep])

  // Handle register more
  const handleRegisterMore = useCallback(() => {
    reset()
  }, [reset])

  // Handle continue after completion
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
        <ReviewStep onBack={handleBackToEdit} onRegister={handleRegister} />
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
