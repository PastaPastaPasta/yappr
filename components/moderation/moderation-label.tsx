'use client'

import { EyeSlashIcon, NoSymbolIcon } from '@heroicons/react/24/outline'
import { cn } from '@/lib/utils'
import { useIsModerator } from '@/hooks/use-is-moderator'
import { useModerationReasonText, useModeratorHandle } from '@/hooks/use-moderation-label'
import { hiddenStubText, moderationLabelLines } from '@/lib/moderation-labels'
import { isHidden, moderationViewAll, type ModerationMarks } from '@/lib/moderation-view'
import type { ModeratedContractKey } from '@/lib/moderated-contracts'

/**
 * Whether the viewer sees hidden content in full (with a label) rather than a
 * stub: the contract's moderators, and everyone on an archival build
 * (`NEXT_PUBLIC_MODERATION_VIEW=all`).
 */
export function useSeesHidden(contract: ModeratedContractKey = 'social'): boolean {
  const isModerator = useIsModerator(contract)
  return moderationViewAll() || isModerator
}

interface ModerationLabelProps {
  contract?: ModeratedContractKey
  /** The item's moderator marks (`post.moderation`, or a blog or store object's `moderation`). */
  moderation?: ModerationMarks | null
  /** Written while its author was restricted (`live: 2`). */
  restricted?: boolean
  className?: string
}

/**
 * The one label every hidden or restricted item carries where it is shown in
 * full (to its contract's moderators, and to everyone on an archival build):
 * "Hidden · Spam or scam · by @alice · 2h ago", and "Restricted account".
 * Renders nothing for an item with neither.
 */
export function ModerationLabel({ contract = 'social', moderation, restricted = false, className }: ModerationLabelProps) {
  const seesHidden = useSeesHidden(contract)
  const hidden = isHidden(moderation) && seesHidden
  const reasonText = useModerationReasonText(contract, hidden ? moderation?.modLabel : null)
  const moderatorName = useModeratorHandle(hidden ? moderation?.moderatedBy : null)
  const lines = seesHidden ? moderationLabelLines({ marks: moderation, restricted, reasonText, moderatorName }) : []
  if (lines.length === 0) return null
  return (
    <div
      data-testid="moderation-label"
      role="note"
      className={cn('flex flex-col gap-0.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-300', className)}
    >
      {lines.map((line) => (
        <span key={line} className="flex items-center gap-1.5">
          {line === 'Restricted account' ? <NoSymbolIcon className="h-3.5 w-3.5 shrink-0" /> : <EyeSlashIcon className="h-3.5 w-3.5 shrink-0" />}
          {line}
        </span>
      ))}
    </div>
  )
}

interface HiddenContentStubProps {
  contract?: ModeratedContractKey
  /** "post", "reply", "comment", "review"… */
  noun: string
  moderation?: ModerationMarks | null
  documentId: string
  /** `card` renders as a feed item; `embed` as an inline box. */
  variant?: 'card' | 'embed'
  className?: string
  /** Fixed wording, for a placeholder that knows no reason (a hidden thread parent). */
  text?: string
}

/**
 * What someone who does not moderate sees in place of a hidden item they
 * reached by link: "This post is hidden by the moderators for spam or scam."
 * No content, nothing to interact with.
 */
export function HiddenContentStub({ contract = 'social', noun, moderation, documentId, variant = 'card', className, text }: HiddenContentStubProps) {
  const reasonText = useModerationReasonText(contract, moderation?.modLabel)
  return (
    <div
      data-testid={`hidden-${noun.replace(/\s+/g, '-')}-${documentId}`}
      className={cn(
        'text-sm text-gray-500 dark:text-gray-400',
        variant === 'embed'
          ? 'mt-3 border border-gray-200 dark:border-gray-700 rounded-xl p-3'
          : 'px-4 py-3 border-b border-gray-200 dark:border-gray-800',
        className
      )}
    >
      <p className="flex items-center gap-2">
        <EyeSlashIcon className="h-4 w-4 shrink-0" />
        {text ?? hiddenStubText(noun, reasonText, moderation?.mod === 2)}
      </p>
    </div>
  )
}
