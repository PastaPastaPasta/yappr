'use client'

import { logger } from '@/lib/logger';
import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/contexts/auth-context'
import { useSdk } from '@/contexts/sdk-context'
import { useDpnsRegistration } from '@/hooks/use-dpns-registration'
import { dpnsService } from '@/lib/services/dpns-service'
import { clearRegistration, registrationsInProgress } from '@/lib/dpns/registration-journal'
import type { UsernameEntry } from '@/lib/types'
import { identityService } from '@/lib/services/identity-service'
import { findDuplicateLabels } from '@/lib/utils/duplicate-labels'
import { getPrivateKey } from '@/lib/secure-storage'
import { matchIdentityKey } from '@/lib/crypto/keys'
import { KeyPurpose, SecurityLevel, getSecurityLevelName } from '@/lib/crypto/identity-keys'
import toast from 'react-hot-toast'

import { UsernameEntryStep } from './steps/username-entry-step'
import { canonicalDpnsLabel } from './canonical-label'
import { CheckingStep } from './steps/checking-step'
import { ReviewStep } from './steps/review-step'
import { RegisteringStep } from './steps/registering-step'
import { CompleteStep } from './steps/complete-step'
import { keyNetwork } from '@/lib/constants'
import { afterRegistrationRoute, currentReturnToParam } from '@/lib/auth/return-to'

interface DpnsRegistrationWizardProps {
  onComplete?: () => void
  onSkip?: () => void
  hasExistingUsernames?: boolean
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
    setQuote,
    quote,
    reset,
  } = useDpnsRegistration()

  const identityId = user?.identityId
  const [checkingAgain, setCheckingAgain] = useState(false)
  // Registrations this browser started and has not finished (the tab closed mid-way, say).
  const [unfinished, setUnfinished] = useState<string[]>([])
  useEffect(() => {
    if (step !== 'username-entry' || !identityId) return
    let current = true
    const records = registrationsInProgress(identityId)
    setUnfinished(records.map((record) => record.label))
    // One whose name is already this account's finished after its answer was lost: forget it.
    Promise.all(records.map(async (record) => {
      dpnsService.clearCache(record.normalizedLabel)
      const owner = await dpnsService.findIdentityByName(record.normalizedLabel).catch(() => undefined)
      if (owner !== identityId) return record.label
      clearRegistration(identityId, record.normalizedLabel)
      return null
    })).then((labels) => {
      if (current) setUnfinished(labels.filter((label): label is string => label !== null))
    }).catch((error: unknown) => logger.warn('Could not check unfinished registrations:', error))
    return () => { current = false }
  }, [step, identityId])
  const handleContinueUnfinished = useCallback(() => {
    useDpnsRegistration.setState({
      usernames: unfinished.map((label) => ({ id: crypto.randomUUID(), label, status: 'pending', isContested: false })),
    })
  }, [unfinished])

  const handleCheckAvailability = useCallback(async () => {
    if (!isSdkReady) {
      toast.error('Service is initializing. Please try again.')
      return
    }

    const validUsernames = usernames.filter((entry) => {
      const label = entry.label.trim()
      const error = label ? dpnsService.getUsernameValidationError(label) : null
      if (error) updateUsernameStatus(entry.id, 'invalid', error)
      return label && !error
    })

    if (validUsernames.length === 0) {
      toast.error('Please enter at least one valid username.')
      return
    }

    // The entry step already blocks this; guard here too so the availability
    // check and registration never see two labels DPNS treats as the same name.
    const duplicates = findDuplicateLabels(
      validUsernames.map((u) => u.label),
      (label) => canonicalDpnsLabel(label, isSdkReady)
    )
    if (duplicates.size > 0) {
      toast.error('Each username must be different.')
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

      // What the registrable names cost, read before the review shows them: the
      // amount the user approves is the most a contested name pays.
      const registrable = validUsernames.filter((entry) => {
        const result = results.get(entry.label.toLowerCase())
        return result && !result.error && result.available
      })
      setQuote({ status: 'none' })
      if (registrable.length > 0 && identityId) {
        try {
          const { quote, balance } = await dpnsService.quoteRegistrations(registrable.map((u) => u.label), identityId)
          setQuote({ status: 'ready', quote, balance })
        } catch (error) {
          logger.error('Failed to read the registration cost:', error)
          setQuote({ status: 'failed' })
        }
      }

      setStep('review')
    } catch (error) {
      logger.error('Failed to check availability:', error)
      toast.error('Failed to check availability. Please try again.')
      setStep('username-entry')
    }
  }, [isSdkReady, usernames, identityId, setStep, updateUsernameStatus, setUsernameContested, setQuote])

  /**
   * Register `entries` (all available, or the ones still being confirmed) with
   * the deposits the review approved, and record each outcome. `needed` is the
   * review's total: nothing is sent unless the balance covers it.
   */
  const runRegistrations = useCallback(async (entries: UsernameEntry[], { needed, showProgress }: { needed?: bigint; showProgress: boolean }) => {
    if (!identityId) {
      toast.error('Please sign in again.')
      return
    }
    const privateKey = getPrivateKey(identityId)
    if (!privateKey) {
      toast.error('Please sign in again.')
      return
    }
    if (quote.status !== 'ready') {
      toast.error('The cost of registering could not be read. Check the names again.')
      setStep('review')
      return
    }

    if (showProgress) {
      setStep('registering')
      setCurrentRegistrationIndex(0)
    } else {
      setCheckingAgain(true)
    }

    try {
      const identity = await identityService.getIdentity(identityId)
      if (!identity) {
        toast.error('Identity not found.')
        setStep('review')
        return
      }

      // DPNS registration signs with a CRITICAL or HIGH authentication key.
      const matched = matchIdentityKey(privateKey, identity.publicKeys, {
        network: keyNetwork(),
        purpose: KeyPurpose.AUTHENTICATION,
        allowedSecurityLevels: [SecurityLevel.CRITICAL, SecurityLevel.HIGH],
      })
      if (!matched.ok) {
        toast.error(
          matched.reason === 'rejected'
            ? `Your key has ${getSecurityLevelName(matched.match.securityLevel)} security level. DPNS requires a CRITICAL or HIGH authentication key.`
            : 'Your private key does not match any key on this identity.'
        )
        setStep('review')
        return
      }

      const approved = new Map(quote.quote.names.map((name) => [name.label, name.contestFund?.credits ?? null]))
      const registrations = entries.map((u) => ({
        label: u.label,
        identityId,
        privateKeyWif: privateKey,
        contestFund: approved.get(u.label) ?? null,
      }))

      const results = await dpnsService.registerUsernamesSequentially(
        registrations,
        (index) => { if (showProgress) setCurrentRegistrationIndex(index) },
        needed
      )

      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        const entry = entries[i]
        setUsernameRegistered(entry.id, result.success, result.error, result.pending)
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
      logger.error('Registration failed:', error)
      const errorMessage = error instanceof Error ? error.message : 'Registration failed. Please try again.'
      toast.error(errorMessage)
      // The identity read or the key check failed: registerUsernamesSequentially, which sends, never throws.
      for (const entry of entries) {
        setUsernameRegistered(entry.id, false, 'Nothing was sent. Try again.', entry.pending)
      }
      setStep('complete')
    } finally {
      setCheckingAgain(false)
    }
  }, [
    identityId,
    quote,
    setStep,
    setCurrentRegistrationIndex,
    setUsernameRegistered,
    setUsernameContested,
    updateDPNSUsername,
  ])

  const handleRegister = useCallback(async () => {
    const availableUsernames = usernames.filter(
      (u) => u.status === 'available' || u.status === 'contested'
    )

    if (availableUsernames.length === 0) {
      toast.error('No available usernames to register.')
      return
    }

    for (const entry of availableUsernames) {
      const error = dpnsService.getUsernameValidationError(entry.label.trim())
      if (error) {
        updateUsernameStatus(entry.id, 'invalid', error)
        setStep('username-entry')
        return
      }
    }

    await runRegistrations(availableUsernames, { needed: quote.status === 'ready' ? quote.quote.total : undefined, showProgress: true })
  }, [usernames, quote, runRegistrations, updateUsernameStatus, setStep])

  // Continues each registration still being confirmed: a step already sent is settled, never paid again.
  const handleCheckAgain = useCallback(async () => {
    await runRegistrations(usernames.filter((u) => u.pending), { showProgress: false })
  }, [usernames, runRegistrations])

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
    const hasUsername = Boolean(user?.dpnsUsername) || usernames.some((u) => u.registered === true)
    onComplete?.()
    router.push(afterRegistrationRoute(hasUsername, currentReturnToParam()))
  }, [onComplete, router, user?.dpnsUsername, usernames])

  return (
    <div className="space-y-6">
      {step === 'username-entry' && unfinished.length > 0 && (
        <div className="border border-purple-300 bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4 space-y-3" data-testid="dpns-unfinished">
          <p className="text-sm text-purple-900 dark:text-purple-100">
            You started registering {unfinished.map((label) => `${label}.dash`).join(', ')} and it isn&apos;t finished yet.
            Continuing uses what you already paid; nothing is charged twice.
          </p>
          <button
            type="button"
            onClick={handleContinueUnfinished}
            className="text-sm font-medium text-purple-700 hover:text-purple-900 dark:text-purple-300 dark:hover:text-purple-100"
          >
            Continue registering
          </button>
        </div>
      )}

      {step === 'username-entry' && (
        <UsernameEntryStep onCheckAvailability={handleCheckAvailability} />
      )}

      {step === 'checking' && <CheckingStep />}

      {step === 'review' && (
        <ReviewStep onBack={handleBackToEdit} onRegister={handleRegister} hasExistingUsernames={hasExistingUsernames} />
      )}

      {step === 'registering' && <RegisteringStep />}

      {step === 'complete' && (
        <CompleteStep onRegisterMore={handleRegisterMore} onContinue={handleContinue} onCheckAgain={handleCheckAgain} checkingAgain={checkingAgain} />
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
