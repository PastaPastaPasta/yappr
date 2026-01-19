'use client'

import { Input } from '@/components/ui/input'
import { CheckCircle2, AlertTriangle, XCircle, Loader2, X } from 'lucide-react'
import type { UsernameEntry, UsernameStatus } from '@/lib/types'
import { cn } from '@/lib/utils'

interface UsernameInputRowProps {
  entry: UsernameEntry
  onChange: (label: string) => void
  onRemove: () => void
  canRemove: boolean
  disabled?: boolean
}

function getStatusBorderClass(status: UsernameStatus): string {
  switch (status) {
    case 'invalid':
    case 'taken':
      return 'border-red-500 focus-visible:ring-red-500'
    case 'contested':
      return 'border-orange-500 focus-visible:ring-orange-500'
    case 'available':
      return 'border-green-500 focus-visible:ring-green-500'
    default:
      return ''
  }
}

function getStatusTextClass(status: UsernameStatus): string {
  switch (status) {
    case 'invalid':
    case 'taken':
      return 'text-red-500'
    case 'contested':
      return 'text-orange-500'
    case 'available':
      return 'text-green-500'
    default:
      return 'text-gray-500'
  }
}

export function UsernameInputRow({
  entry,
  onChange,
  onRemove,
  canRemove,
  disabled = false,
}: UsernameInputRowProps) {
  function getStatusIcon(): React.ReactNode {
    switch (entry.status) {
      case 'checking':
        return <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
      case 'available':
        return <CheckCircle2 className="w-5 h-5 text-green-500" />
      case 'contested':
        return <AlertTriangle className="w-5 h-5 text-orange-500" />
      case 'taken':
      case 'invalid':
        return <XCircle className="w-5 h-5 text-red-500" />
      default:
        return null
    }
  }

  function getStatusMessage(): string | null {
    if (entry.validationError) {
      return entry.validationError
    }
    switch (entry.status) {
      case 'checking':
        return 'Checking...'
      case 'available':
        return 'Available'
      case 'contested':
        return 'Available (contested)'
      case 'taken':
        return 'Already taken'
      case 'invalid':
        return 'Invalid'
      default:
        return null
    }
  }

  const statusMessage = getStatusMessage()
  const canRemoveUsername = canRemove && !disabled

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <div className="flex-1 relative">
          <Input
            type="text"
            value={entry.label}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
            placeholder="username"
            disabled={disabled}
            maxLength={20}
            className={cn('pr-16', getStatusBorderClass(entry.status))}
          />
          <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
            <span className="text-gray-400 text-sm mr-2">.dash</span>
            {getStatusIcon()}
          </div>
        </div>
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemoveUsername}
          className={cn(
            'p-2 rounded-md transition-colors',
            canRemoveUsername
              ? 'text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
              : 'text-gray-200 dark:text-gray-700 cursor-not-allowed'
          )}
        >
          <X className="w-5 h-5" />
        </button>
      </div>
      {statusMessage && entry.status !== 'pending' && (
        <p className={cn('text-xs ml-1', getStatusTextClass(entry.status))}>
          {statusMessage}
        </p>
      )}
    </div>
  )
}
