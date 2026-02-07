'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { X, Eye, EyeOff, Shield, AlertTriangle, Key, Check } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useKeyBackupModal } from '@/hooks/use-key-backup-modal'
import { encryptedKeyService } from '@/lib/services/encrypted-key-service'
import {
  validateBackupPassword,
  MIN_PASSWORD_LENGTH,
  MIN_KDF_ITERATIONS,
  MAX_KDF_ITERATIONS
} from '@/lib/onchain-key-encryption'
import { useSettingsStore } from '@/lib/store'

export function KeyBackupModal() {
  const router = useRouter()
  const { isOpen, identityId, username, privateKey, redirectOnClose, close } = useKeyBackupModal()
  const potatoMode = useSettingsStore((s) => s.potatoMode)

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [consentChecked, setConsentChecked] = useState(false)

  // Benchmark and iteration settings
  const [isBenchmarking, setIsBenchmarking] = useState(true)
  const [iterations, setIterations] = useState(MIN_KDF_ITERATIONS)
  const [estimatedTime, setEstimatedTime] = useState(2)
  const [targetTime, setTargetTime] = useState(2) // seconds
  const [iterationsPerMs, setIterationsPerMs] = useState<number | null>(null)

  // Benchmark on mount to get device speed
  useEffect(() => {
    if (isOpen && iterationsPerMs === null) {
      runBenchmark().catch(err => console.error('Failed to run benchmark:', err))
    }
  }, [isOpen, iterationsPerMs])

  const runBenchmark = async () => {
    setIsBenchmarking(true)
    try {
      // Benchmark for 2 seconds to get a baseline
      const result = await encryptedKeyService.benchmarkDevice(2000)
      const rate = result.iterations / result.estimatedMs
      setIterationsPerMs(rate)
      setIterations(result.iterations)
      setEstimatedTime(result.estimatedMs / 1000)
    } catch (error) {
      console.error('Benchmark failed:', error)
      // Use minimum iterations as fallback
      setIterations(MIN_KDF_ITERATIONS)
      setEstimatedTime(2)
      // Estimate a conservative rate
      setIterationsPerMs(MIN_KDF_ITERATIONS / 2000)
    } finally {
      setIsBenchmarking(false)
    }
  }

  // Update iterations when target time changes (instant calculation, no re-benchmark)
  const handleTimeChange = useCallback((newTime: number) => {
    setTargetTime(newTime)
    if (iterationsPerMs !== null) {
      // Calculate iterations for new target time
      let newIterations = Math.round(iterationsPerMs * newTime * 1000)
      // Clamp to allowed range
      newIterations = Math.max(MIN_KDF_ITERATIONS, Math.min(MAX_KDF_ITERATIONS, newIterations))
      setIterations(newIterations)
      // Calculate actual estimated time with clamped iterations
      setEstimatedTime(newIterations / iterationsPerMs / 1000)
    }
  }, [iterationsPerMs])

  const passwordValidation = validateBackupPassword(password)
  const passwordsMatch = password === confirmPassword
  const canSubmit = passwordValidation.valid && passwordsMatch && consentChecked && !isSubmitting && !isBenchmarking

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!passwordValidation.valid) {
      setError(passwordValidation.error || 'Invalid password')
      return
    }

    if (!passwordsMatch) {
      setError('Passwords do not match')
      return
    }

    if (!consentChecked) {
      setError('You must acknowledge the security warning')
      return
    }

    if (!identityId || !privateKey) {
      setError('Missing identity or private key')
      return
    }

    setIsSubmitting(true)
    try {
      const result = await encryptedKeyService.createBackup(
        identityId,
        privateKey,
        password,
        iterations
      )

      if (!result.success) {
        setError(result.error || 'Failed to create backup')
        return
      }

      // Success - close modal
      handleClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create backup')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    setPassword('')
    setConfirmPassword('')
    setError(null)
    setConsentChecked(false)
    setTargetTime(2)
    setIterationsPerMs(null) // Reset so we re-benchmark next time
    setIsBenchmarking(true)
    const shouldRedirect = redirectOnClose
    close()
    // Redirect to profile creation after closing (only during registration flow)
    if (shouldRedirect) {
      router.push('/profile/create')
    }
  }

  const formatIterations = (n: number): string => {
    if (n >= 1_000_000) {
      return `${(n / 1_000_000).toFixed(1)}M`
    }
    return `${(n / 1_000).toFixed(0)}K`
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={`fixed inset-0 bg-black/50 z-50 ${potatoMode ? '' : 'backdrop-blur-sm'}`}
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 flex items-center justify-center z-50 px-4 overflow-y-auto py-8"
          >
            <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-xl p-6 max-w-md w-full relative my-auto">
              {/* Close button */}
              <button
                onClick={handleClose}
                className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>

              {/* Icon */}
              <div className="flex justify-center mb-4">
                <div className="w-16 h-16 rounded-full bg-yappr-100 dark:bg-yappr-900/30 flex items-center justify-center">
                  <Shield className="w-8 h-8 text-yappr-600 dark:text-yappr-400" />
                </div>
              </div>

              <h1 className="text-2xl font-bold text-center mb-2">Backup Your Key</h1>
              <p className="text-gray-600 dark:text-gray-400 text-center mb-4 text-sm">
                Save an encrypted copy of your key to Dash Platform.
                This lets you sign in with just your username and password.
              </p>

              {/* Key to be protected */}
              <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 mb-4">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">
                  Key included in backup
                </p>
                <div className="flex items-center gap-3 text-sm">
                  <div className="w-8 h-8 rounded-full bg-yappr-100 dark:bg-yappr-900/30 flex items-center justify-center">
                    <Key className="w-4 h-4 text-yappr-600 dark:text-yappr-400" />
                  </div>
                  <div className="flex-1">
                    <span className="font-medium text-gray-900 dark:text-white">Login Key</span>
                    <span className="text-gray-500 dark:text-gray-400 ml-2 text-xs">Required for signing in</span>
                  </div>
                  <Check className="w-4 h-4 text-green-500" />
                </div>
              </div>

              {/* Security Warning */}
              <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-300 dark:border-orange-600 rounded-lg p-4 mb-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-orange-600 dark:text-orange-400 flex-shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-semibold text-orange-800 dark:text-orange-200 mb-1">
                      Security Warning
                    </p>
                    <ul className="text-orange-700 dark:text-orange-300 space-y-1 list-disc list-inside">
                      <li>Your encrypted key will be stored publicly on Dash Platform</li>
                      <li><strong>Anyone who knows your password can access your key</strong></li>
                      <li>This cannot be undone</li>
                    </ul>
                  </div>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                {/* Password input */}
                <div>
                  <label htmlFor="backup-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Passphrase ({password.length}/{MIN_PASSWORD_LENGTH} min)
                  </label>
                  <div className="relative">
                    <input
                      id="backup-password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter a strong passphrase (16+ characters)"
                      className="w-full px-3 py-2 pr-10 bg-surface-1 dark:bg-surface-2 border border-border rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:border-transparent transition-colors"
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-600"
                    >
                      {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                  {password.length > 0 && password.length < MIN_PASSWORD_LENGTH && (
                    <p className="text-xs text-orange-600 dark:text-orange-400 mt-1">
                      {MIN_PASSWORD_LENGTH - password.length} more characters needed
                    </p>
                  )}
                </div>

                {/* Confirm password */}
                <div>
                  <label htmlFor="backup-confirm-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Confirm Passphrase
                  </label>
                  <input
                    id="backup-confirm-password"
                    type={showPassword ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm your passphrase"
                    className="w-full px-3 py-2 bg-surface-1 dark:bg-surface-2 border border-border rounded-lg text-gray-900 dark:text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-yappr-500 focus:border-transparent transition-colors"
                    autoComplete="new-password"
                  />
                  {confirmPassword.length > 0 && !passwordsMatch && (
                    <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                      Passwords do not match
                    </p>
                  )}
                </div>

                {/* Security strength slider */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Security Strength
                  </label>
                  <div className="space-y-2">
                    <input
                      type="range"
                      min="1"
                      max="30"
                      value={targetTime}
                      onChange={(e) => handleTimeChange(parseInt(e.target.value))}
                      className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-yappr-600"
                      disabled={isBenchmarking}
                    />
                    <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                      <span>1s (faster)</span>
                      <span>30s (stronger)</span>
                    </div>
                    <div className="text-center text-sm">
                      {isBenchmarking ? (
                        <span className="text-gray-500 dark:text-gray-400 flex items-center justify-center gap-2">
                          <Spinner size="xs" />
                          Calibrating...
                        </span>
                      ) : (
                        <span className="text-gray-700 dark:text-gray-300">
                          ~{formatIterations(iterations)} iterations ({estimatedTime.toFixed(1)}s to decrypt)
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Consent checkbox */}
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={consentChecked}
                    onChange={(e) => setConsentChecked(e.target.checked)}
                    className="mt-1 h-4 w-4 text-yappr-600 focus:ring-yappr-500 border-gray-300 rounded"
                  />
                  <span className="text-sm text-gray-700 dark:text-gray-300">
                    I understand that anyone with my password can access my private key from the public backup
                  </span>
                </label>

                {error && (
                  <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-600 rounded-lg p-3">
                    <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                  </div>
                )}

                <div className="flex gap-3 pt-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={handleClose}
                  >
                    Skip for now
                  </Button>
                  <Button
                    type="submit"
                    className="flex-1"
                    disabled={!canSubmit}
                  >
                    {isSubmitting ? (
                      <>
                        <Spinner size="xs" className="mr-2" />
                        Encrypting...
                      </>
                    ) : (
                      'Backup to Chain'
                    )}
                  </Button>
                </div>

                <p className="text-xs text-center text-gray-500 dark:text-gray-400">
                  Backing up for <span className="font-medium">@{username}</span>
                </p>
              </form>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
