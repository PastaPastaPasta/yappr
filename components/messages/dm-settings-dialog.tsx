'use client'

import * as RadioGroup from '@radix-ui/react-radio-group'
import { Button } from '@/components/ui/button'
import type { RetentionSetting } from '@/lib/dm/types'
import type { UserDetails } from '@/lib/utils/resolve-user-details'
import { DmDialog } from './dm-ui'
import { displayNameOf } from './use-dm-engine'

const RETENTION_OPTIONS: Array<{ value: RetentionSetting; label: string }> = [
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: '1y', label: '1 year' },
  { value: 'never', label: 'Never' },
]

/** The period in the §5.6 sentence. "Never" keeps the default's wording: it describes what the option does. */
const PERIOD: Record<RetentionSetting, string> = { '30d': '30 days', '90d': '90 days', '1y': '1 year', never: '30 days' }

interface DmSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  retention: RetentionSetting
  onRetention: (retention: RetentionSetting) => void
  blocked: string[]
  details: ReadonlyMap<string, UserDetails>
  onUnblock: (id: string) => void
}

/**
 * Message settings: the retention sweep (docs/DM_V5.md §5.6, worded exactly
 * as the spec requires: fee saving, never "disappearing") and the block list.
 */
export function DmSettingsDialog({ open, onOpenChange, retention, onRetention, blocked, details, onUnblock }: DmSettingsDialogProps) {
  return (
    <DmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Message settings"
      description="Message fee reclaiming and blocked people."
      closeLabel="Close message settings"
    >
      <section className="mb-6">
        <h3 className="font-semibold mb-1">Reclaim message fees</h3>
        {/* The wording is fixed by docs/DM_V5.md §5.6 (fee saving, never "disappearing"); only the period follows the choice. */}
        <p className="text-sm text-gray-500 mb-3">
          Delete your sent messages from Dash Platform after {PERIOD[retention]} and get most of their storage fee back. This saves money. It does not
          make old messages private: copies remain in the blockchain&apos;s history, and the people you messaged keep what they have.
        </p>
        <RadioGroup.Root value={retention} onValueChange={(value) => onRetention(value as RetentionSetting)} className="space-y-2" aria-label="Reclaim message fees after">
          {RETENTION_OPTIONS.map((option) => (
            <label key={option.value} className="flex items-center gap-3 cursor-pointer">
              <RadioGroup.Item
                value={option.value}
                className="h-4 w-4 rounded-full border border-gray-400 data-[state=checked]:border-yappr-500 flex items-center justify-center"
              >
                <RadioGroup.Indicator className="h-2 w-2 rounded-full bg-yappr-500" />
              </RadioGroup.Item>
              <span className="text-sm">{option.value === 'never' ? 'Never (keep paying for storage)' : `After ${option.label}`}</span>
            </label>
          ))}
        </RadioGroup.Root>
      </section>

      <section>
        <h3 className="font-semibold mb-2">Blocked</h3>
        {blocked.length === 0 ? (
          <p className="text-sm text-gray-500">Nobody. Blocked people&apos;s messages and group invitations are ignored.</p>
        ) : (
          <ul className="border border-gray-200 dark:border-gray-700 rounded-xl divide-y divide-gray-100 dark:divide-gray-800">
            {blocked.map((id) => (
              <li key={id} className="flex items-center justify-between gap-3 p-3">
                <span className="truncate">{displayNameOf(details, id)}</span>
                <Button size="sm" variant="outline" onClick={() => onUnblock(id)}>Unblock</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </DmDialog>
  )
}
