'use client'

import { useEffect, useCallback } from 'react'
import { WasmSdk } from '@dashevo/evo-sdk'
import { Button } from '@/components/ui/button'
import { UsernameInputRow } from '../username-input-row'
import { useDpnsRegistration } from '@/hooks/use-dpns-registration'
import { useSdk } from '@/contexts/sdk-context'
import { dpnsService } from '@/lib/services/dpns-service'
import { Plus } from 'lucide-react'

interface UsernameEntryStepProps {
  onCheckAvailability: () => void
}

export function UsernameEntryStep({ onCheckAvailability }: UsernameEntryStepProps) {
  const { isReady: isSdkReady } = useSdk()
  const {
    usernames,
    addUsername,
    removeUsername,
    updateUsernameLabel,
    updateUsernameStatus,
  } = useDpnsRegistration()

  // Validate username format on input change (debounced)
  // This only checks format validity - availability is checked separately
  const validateUsername = useCallback(
    (id: string, label: string) => {
      const trimmedLabel = label.trim()
      const currentEntry = usernames.find((u) => u.id === id)
      const currentStatus = currentEntry?.status

      if (!trimmedLabel) {
        // Only update if status would actually change
        if (currentStatus !== 'pending') {
          updateUsernameStatus(id, 'pending')
        }
        return
      }

      // Only do client-side format validation
      const validationError = dpnsService.getUsernameValidationError(trimmedLabel)
      if (validationError) {
        // Only update if status would change or error message differs
        if (currentStatus !== 'invalid' || currentEntry?.validationError !== validationError) {
          updateUsernameStatus(id, 'invalid', validationError)
        }
      } else {
        // Valid format - keep as pending until availability check
        if (currentStatus !== 'pending') {
          updateUsernameStatus(id, 'pending')
        }
      }
    },
    [usernames, updateUsernameStatus]
  )

  // Debounce validation
  useEffect(() => {
    const timeouts: NodeJS.Timeout[] = []

    for (const entry of usernames) {
      if (entry.label && entry.status === 'pending') {
        const timeout = setTimeout(() => {
          validateUsername(entry.id, entry.label)
        }, 300)
        timeouts.push(timeout)
      }
    }

    return () => {
      timeouts.forEach((t) => clearTimeout(t))
    }
  }, [usernames, validateUsername])

  const handleLabelChange = (id: string, label: string) => {
    updateUsernameLabel(id, label)
  }

  // Use the WASM export from the same SDK initialized before isReady is set.
  // DPNS also treats o/0 and i/l/1 as the same label.
  const canonicalLabel = (label: string) => isSdkReady
    ? WasmSdk.dpnsConvertToHomographSafe(label.trim())
    : label.trim().toLowerCase()
  const seenLabels = new Set<string>()
  const duplicateLabels = new Set<string>()
  for (const entry of usernames) {
    const label = canonicalLabel(entry.label)
    if (!label) continue
    if (seenLabels.has(label)) duplicateLabels.add(label)
    seenLabels.add(label)
  }

  const hasValidUsernames = usernames.some(
    (u) => u.label.trim() && u.status !== 'invalid'
  )

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {usernames.map((entry) => (
          <UsernameInputRow
            key={entry.id}
            entry={duplicateLabels.has(canonicalLabel(entry.label))
              ? { ...entry, status: 'invalid', validationError: 'This username matches another entry' }
              : entry}
            onChange={(label) => handleLabelChange(entry.id, label)}
            onRemove={() => removeUsername(entry.id)}
            canRemove={usernames.length > 1}
          />
        ))}
      </div>

      <button
        type="button"
        onClick={addUsername}
        className="w-full border-2 border-dashed border-gray-300 dark:border-gray-600
          hover:border-green-500 dark:hover:border-green-500
          text-gray-500 hover:text-green-500
          rounded-lg p-3 transition-colors flex items-center justify-center gap-2"
      >
        <Plus className="w-4 h-4" />
        Add Another Username
      </button>

      <Button
        onClick={onCheckAvailability}
        disabled={!hasValidUsernames || duplicateLabels.size > 0 || !isSdkReady}
        className="w-full"
      >
        Check Availability
      </Button>
    </div>
  )
}
