'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { X, Loader2, AlertTriangle, Trash2, CheckCircle, XCircle } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useDeleteAccountModal } from '@/hooks/use-delete-account-modal'
import { useAuth } from '@/contexts/auth-context'
import { accountDeletionService, DeletionProgress } from '@/lib/services/account-deletion-service'

/**
 * Delete Account Modal
 *
 * Multi-step modal for permanent account deletion:
 * 1. Warning - explain what will be deleted
 * 2. Confirm - type "DELETE" to confirm
 * 3. Progress - show deletion progress
 * 4. Complete/Error - show result
 */
export function DeleteAccountModal() {
  const router = useRouter()
  const { user, logout } = useAuth()
  const {
    isOpen,
    step,
    progress,
    result,
    documentCounts,
    isLoadingCounts,
    setStep,
    setProgress,
    setResult,
    setDocumentCounts,
    setIsLoadingCounts,
    reset
  } = useDeleteAccountModal()

  const [confirmText, setConfirmText] = useState('')
  const [understood, setUnderstood] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  // Load document counts when modal opens
  useEffect(() => {
    const loadCounts = async () => {
      if (!user?.identityId) return

      setIsLoadingCounts(true)
      try {
        const counts = await accountDeletionService.countUserDocuments(user.identityId)
        setDocumentCounts(counts)
      } catch (error) {
        console.error('Failed to load document counts:', error)
        // Continue anyway - counts are just informational
        setDocumentCounts({})
      } finally {
        setIsLoadingCounts(false)
      }
    }

    if (isOpen && step === 'warning' && user?.identityId && documentCounts === null && !isLoadingCounts) {
      void loadCounts()
    }
  }, [isOpen, step, user?.identityId, documentCounts, isLoadingCounts, setIsLoadingCounts, setDocumentCounts])

  const handleClose = () => {
    if (isDeleting) return // Prevent closing during deletion
    setConfirmText('')
    setUnderstood(false)
    reset()
  }

  const handleStartDeletion = async () => {
    if (!user?.identityId) return

    setIsDeleting(true)
    setStep('progress')

    try {
      const deletionResult = await accountDeletionService.deleteAccount(
        user.identityId,
        (progressUpdate: DeletionProgress) => {
          setProgress(progressUpdate)
        }
      )

      setResult(deletionResult)

      if (deletionResult.success) {
        setStep('complete')
      } else if (deletionResult.partialFailure) {
        setStep('error')
      } else {
        setStep('error')
      }
    } catch (error) {
      console.error('Deletion failed:', error)
      setResult({
        success: false,
        totalDeleted: 0,
        totalFailed: 0,
        errors: [{
          contractId: 'unknown',
          documentType: 'unknown',
          documentId: 'unknown',
          error: error instanceof Error ? error.message : 'Unknown error'
        }],
        partialFailure: false
      })
      setStep('error')
    } finally {
      setIsDeleting(false)
    }
  }

  const handleCompleteLogout = async () => {
    try {
      await logout()
    } catch (error) {
      console.error('Failed to logout after account deletion:', error)
      // Navigate to login even if logout fails
      router.push('/login')
    } finally {
      handleClose()
    }
  }

  const getTotalDocuments = () => {
    if (!documentCounts) return 0
    return Object.values(documentCounts).reduce((sum, count) => sum + count, 0)
  }

  const deletionSummary = accountDeletionService.getDeletionSummary()

  // Render warning step
  const renderWarningStep = () => (
    <div className="space-y-4">
      {/* Icon */}
      <div className="flex justify-center">
        <div className="w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
          <Trash2 className="w-8 h-8 text-red-600 dark:text-red-400" />
        </div>
      </div>

      <h2 className="text-xl font-bold text-center">Delete Your Account</h2>

      <p className="text-gray-600 dark:text-gray-400 text-center text-sm">
        This will permanently delete all your data from Dash Platform.
      </p>

      {/* Document counts */}
      {isLoadingCounts ? (
        <div className="bg-gray-50 dark:bg-gray-950 rounded-lg p-4 text-center">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" />
          <p className="text-sm text-gray-500">Counting your documents...</p>
        </div>
      ) : documentCounts && getTotalDocuments() > 0 ? (
        <div className="bg-gray-50 dark:bg-gray-950 rounded-lg p-4">
          <p className="text-sm font-medium mb-2">
            You have <span className="text-red-600 dark:text-red-400">{getTotalDocuments()}</span> documents to delete:
          </p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {Object.entries(documentCounts).map(([type, count]) => (
              <div key={type} className="flex justify-between">
                <span className="text-gray-500 capitalize">{type.replace(/([A-Z])/g, ' $1').trim()}</span>
                <span className="font-mono">{count}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* What will be deleted */}
      <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
        <h3 className="font-semibold text-red-800 dark:text-red-200 mb-2 text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          What will be deleted:
        </h3>
        <div className="space-y-2">
          {deletionSummary.map((category) => (
            <div key={category.category}>
              <p className="text-xs font-medium text-red-700 dark:text-red-300">{category.category}</p>
              <ul className="text-xs text-red-600 dark:text-red-400 ml-4 list-disc">
                {category.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {/* Third-party warning */}
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-amber-800 dark:text-amber-200 mb-1">
              Important Notice
            </p>
            <p className="text-amber-700 dark:text-amber-300 text-xs">
              While your data will be deleted from Dash Platform, <strong>third-party indexers or explorers may retain historical copies</strong>.
              The blockchain itself doesn&apos;t keep document history, but external services that have indexed your data may still have copies.
            </p>
          </div>
        </div>
      </div>

      {/* Consent checkbox */}
      <label className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-gray-200 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-950 transition-colors">
        <input
          type="checkbox"
          checked={understood}
          onChange={(e) => setUnderstood(e.target.checked)}
          className="mt-1 h-4 w-4 text-red-600 focus:ring-red-500 border-gray-300 rounded"
        />
        <span className="text-sm text-gray-700 dark:text-gray-300">
          I understand this action is <strong>permanent</strong> and cannot be undone
        </span>
      </label>

      <div className="flex gap-3 pt-2">
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          onClick={handleClose}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="destructive"
          className="flex-1 bg-red-600 hover:bg-red-700 text-white"
          disabled={!understood || isLoadingCounts}
          onClick={() => setStep('confirm')}
        >
          Continue
        </Button>
      </div>
    </div>
  )

  // Render confirm step
  const renderConfirmStep = () => (
    <div className="space-y-4">
      <div className="flex justify-center">
        <div className="w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
          <AlertTriangle className="w-8 h-8 text-red-600 dark:text-red-400" />
        </div>
      </div>

      <h2 className="text-xl font-bold text-center">Confirm Deletion</h2>

      <p className="text-gray-600 dark:text-gray-400 text-center text-sm">
        To confirm, type <strong className="text-red-600">DELETE</strong> below
      </p>

      <div>
        <input
          type="text"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
          placeholder="Type DELETE to confirm"
          className="w-full px-4 py-3 bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg text-center text-lg font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-colors"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
        />
      </div>

      <div className="flex gap-3 pt-2">
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          onClick={() => {
            setConfirmText('')
            setStep('warning')
          }}
        >
          Go Back
        </Button>
        <Button
          type="button"
          variant="destructive"
          className="flex-1 bg-red-600 hover:bg-red-700 text-white"
          disabled={confirmText !== 'DELETE'}
          onClick={handleStartDeletion}
        >
          Delete My Account
        </Button>
      </div>
    </div>
  )

  // Render progress step
  const renderProgressStep = () => {
    const progressPercent = progress
      ? Math.round((progress.processedDocuments / Math.max(progress.totalDocuments, 1)) * 100)
      : 0

    return (
      <div className="space-y-4">
        <div className="flex justify-center">
          <div className="w-16 h-16 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
            <Loader2 className="w-8 h-8 text-blue-600 dark:text-blue-400 animate-spin" />
          </div>
        </div>

        <h2 className="text-xl font-bold text-center">Deleting Your Data</h2>

        <p className="text-gray-600 dark:text-gray-400 text-center text-sm">
          Please wait while we delete your documents...
        </p>

        {/* Progress bar */}
        <div className="space-y-2">
          <div className="h-3 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 transition-all duration-300 ease-out"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <p className="text-sm text-center text-gray-500">
            {progress?.processedDocuments || 0} / {progress?.totalDocuments || 0} documents processed
          </p>
        </div>

        {/* Current operation */}
        {progress && (
          <div className="bg-gray-50 dark:bg-gray-950 rounded-lg p-4 text-center">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {progress.phase === 'counting' && 'Counting documents...'}
              {progress.phase === 'deleting' && (
                <>Deleting {progress.currentDocumentType} from {progress.currentContract}...</>
              )}
              {progress.phase === 'cleanup' && 'Cleaning up local data...'}
            </p>
          </div>
        )}

        {/* Stats */}
        {progress && progress.processedDocuments > 0 && (
          <div className="flex justify-center gap-6 text-sm">
            <div className="text-center">
              <p className="text-green-600 dark:text-green-400 font-semibold">{progress.deletedDocuments}</p>
              <p className="text-gray-500 text-xs">Deleted</p>
            </div>
            {progress.failedDocuments > 0 && (
              <div className="text-center">
                <p className="text-red-600 dark:text-red-400 font-semibold">{progress.failedDocuments}</p>
                <p className="text-gray-500 text-xs">Failed</p>
              </div>
            )}
          </div>
        )}

        <p className="text-xs text-center text-gray-400">
          Do not close this window
        </p>
      </div>
    )
  }

  // Render complete step
  const renderCompleteStep = () => (
    <div className="space-y-4">
      <div className="flex justify-center">
        <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
          <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
        </div>
      </div>

      <h2 className="text-xl font-bold text-center">Account Deleted</h2>

      <p className="text-gray-600 dark:text-gray-400 text-center text-sm">
        Your account data has been successfully deleted from Dash Platform.
      </p>

      {result && (
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4 text-center">
          <p className="text-green-700 dark:text-green-300 font-semibold">
            {result.totalDeleted} documents deleted
          </p>
        </div>
      )}

      <Button
        type="button"
        className="w-full"
        onClick={handleCompleteLogout}
      >
        Return to Login
      </Button>
    </div>
  )

  // Render error step
  const renderErrorStep = () => (
    <div className="space-y-4">
      <div className="flex justify-center">
        <div className="w-16 h-16 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
          <XCircle className="w-8 h-8 text-red-600 dark:text-red-400" />
        </div>
      </div>

      <h2 className="text-xl font-bold text-center">
        {result?.partialFailure ? 'Partial Deletion' : 'Deletion Failed'}
      </h2>

      <p className="text-gray-600 dark:text-gray-400 text-center text-sm">
        {result?.partialFailure
          ? 'Some documents could not be deleted. You may try again later.'
          : 'We encountered an error while deleting your data.'}
      </p>

      {result && (
        <div className="space-y-2">
          {result.totalDeleted > 0 && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-3 text-center">
              <p className="text-green-700 dark:text-green-300 text-sm">
                {result.totalDeleted} documents successfully deleted
              </p>
            </div>
          )}

          {result.totalFailed > 0 && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
              <p className="text-red-700 dark:text-red-300 text-sm text-center mb-2">
                {result.totalFailed} documents failed to delete
              </p>
              {result.errors.length > 0 && result.errors.length <= 5 && (
                <ul className="text-xs text-red-600 dark:text-red-400 space-y-1">
                  {result.errors.map((err, i) => (
                    <li key={i} className="truncate">
                      {err.documentType}: {err.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex gap-3 pt-2">
        {result?.partialFailure ? (
          <>
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={handleCompleteLogout}
            >
              Continue Anyway
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="flex-1 bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                setConfirmText('')
                setStep('warning')
              }}
            >
              Try Again
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={handleClose}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="flex-1 bg-red-600 hover:bg-red-700 text-white"
              onClick={() => {
                setConfirmText('')
                setStep('warning')
              }}
            >
              Try Again
            </Button>
          </>
        )}
      </div>
    </div>
  )

  const renderStep = () => {
    switch (step) {
      case 'warning':
        return renderWarningStep()
      case 'confirm':
        return renderConfirmStep()
      case 'progress':
        return renderProgressStep()
      case 'complete':
        return renderCompleteStep()
      case 'error':
        return renderErrorStep()
      default:
        return renderWarningStep()
    }
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
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50"
            onClick={isDeleting ? undefined : handleClose}
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
              {/* Close button - hidden during deletion */}
              {!isDeleting && step !== 'progress' && (
                <button
                  onClick={handleClose}
                  className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              )}

              {renderStep()}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
