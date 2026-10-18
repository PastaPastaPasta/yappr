'use client'

import { Button } from '@/components/ui/button'
import { UsernameInputRow } from '../username-input-row'
import { canonicalDpnsLabel } from '../canonical-label'
import { useDpnsRegistration } from '@/hooks/use-dpns-registration'
import { useSdk } from '@/contexts/sdk-context'
import { dpnsService } from '@/lib/services/dpns-service'
import { findDuplicateLabels } from '@/lib/utils/duplicate-labels'
import type { UsernameEntry } from '@/lib/types'
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

  const handleLabelChange = (id: string, label: string) => {
    updateUsernameLabel(id, label)
    const error = label.trim() ? dpnsService.getUsernameValidationError(label.trim()) : null
    if (error) updateUsernameStatus(id, 'invalid', error)
  }

  // Rows that already fail the format check keep that error and are skipped by
  // Check Availability, so only the remaining rows can form a duplicate group.
  const canonical = (label: string) => canonicalDpnsLabel(label, isSdkReady)
  const duplicateLabels = findDuplicateLabels(
    usernames.filter((u) => u.status !== 'invalid').map((u) => u.label),
    canonical
  )
  const isDuplicate = (entry: UsernameEntry) =>
    entry.status !== 'invalid' && duplicateLabels.has(canonical(entry.label))

  const hasValidUsernames = usernames.some(
    (u) => u.label.trim() && !dpnsService.getUsernameValidationError(u.label.trim())
  )

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {usernames.map((entry) => (
          <UsernameInputRow
            key={entry.id}
            entry={isDuplicate(entry)
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
