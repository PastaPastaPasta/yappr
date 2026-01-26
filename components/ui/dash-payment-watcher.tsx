'use client'

import { ClockIcon, ArrowPathIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline'
import { CheckCircleIcon as CheckCircleSolidIcon } from '@heroicons/react/24/solid'
import { useDashTransactionWatcher, type WatcherStatus } from '@/hooks/use-dash-transaction-watcher'
import { isDashScheme } from '@/lib/services/insight-api-service'

interface DashPaymentWatcherProps {
  scheme: string
  address: string
  enabled?: boolean
  onDetected?: (txid: string, amountDash: number) => void
  onTimeout?: () => void
  onDone?: () => void
}

function WatcherStatusDisplay({
  status,
  detectedAmount,
  onRetry,
  onDone
}: {
  status: WatcherStatus
  detectedAmount: number | null
  onRetry: () => void
  onDone?: () => void
}) {
  switch (status) {
    case 'watching':
      return (
        <div className="flex items-center gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <div className="flex items-center gap-2 flex-1">
            <div className="relative">
              <ClockIcon className="w-5 h-5 text-blue-500" />
              <span className="absolute -top-1 -right-1 flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
            </div>
            <p className="text-sm font-medium text-blue-700 dark:text-blue-300">
              Waiting for payment...
            </p>
          </div>
          <div className="text-xs text-blue-500">
            Auto-detecting
          </div>
        </div>
      )

    case 'detected':
      return (
        <button
          onClick={onDone}
          className="w-full py-3 rounded-lg bg-green-500 hover:bg-green-600 text-white font-medium transition-colors flex items-center justify-center gap-2"
        >
          <CheckCircleSolidIcon className="w-5 h-5" />
          Done {detectedAmount !== null && `(${detectedAmount.toFixed(8)} DASH received)`}
        </button>
      )

    case 'timeout':
      return (
        <div className="p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ExclamationTriangleIcon className="w-5 h-5 text-yellow-500" />
              <p className="text-sm font-medium text-yellow-700 dark:text-yellow-300">
                No payment detected
              </p>
            </div>
            <button
              onClick={onRetry}
              className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-yellow-700 dark:text-yellow-300 hover:bg-yellow-100 dark:hover:bg-yellow-900/30 rounded-md transition-colors"
            >
              <ArrowPathIcon className="w-4 h-4" />
              Check Again
            </button>
          </div>
          <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-1">
            Already sent? Click Check Again to retry detection.
          </p>
        </div>
      )

    case 'error':
      return (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ExclamationTriangleIcon className="w-5 h-5 text-red-500" />
              <p className="text-sm font-medium text-red-700 dark:text-red-300">
                Detection error
              </p>
            </div>
            <button
              onClick={onRetry}
              className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-md transition-colors"
            >
              <ArrowPathIcon className="w-4 h-4" />
              Retry
            </button>
          </div>
        </div>
      )

    case 'idle':
      // Show watching UI while initializing
      return (
        <div className="flex items-center gap-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
          <div className="flex items-center gap-2 flex-1">
            <div className="relative">
              <ClockIcon className="w-5 h-5 text-blue-500" />
              <span className="absolute -top-1 -right-1 flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
            </div>
            <p className="text-sm font-medium text-blue-700 dark:text-blue-300">
              Waiting for payment...
            </p>
          </div>
          <div className="text-xs text-blue-500">
            Auto-detecting
          </div>
        </div>
      )

    default:
      return null
  }
}

export function DashPaymentWatcher({
  scheme,
  address,
  enabled = true,
  onDetected,
  onTimeout,
  onDone
}: DashPaymentWatcherProps) {
  const {
    status,
    detectedAmount,
    retry
  } = useDashTransactionWatcher({
    enabled: enabled && isDashScheme(scheme),
    scheme,
    address,
    onDetected,
    onTimeout
  })

  // Don't render anything if not a Dash scheme
  if (!isDashScheme(scheme)) {
    return null
  }

  return (
    <WatcherStatusDisplay
      status={status}
      detectedAmount={detectedAmount}
      onRetry={retry}
      onDone={onDone}
    />
  )
}

export { type WatcherStatus }
