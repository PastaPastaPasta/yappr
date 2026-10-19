'use client'

import { useRouter } from 'next/navigation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { NoSymbolIcon, ShieldExclamationIcon } from '@heroicons/react/24/outline'
import { IconButton } from '@/components/ui/icon-button'
import { useModerationAuthorization } from '@/hooks/use-moderation-authorization'
import { ModerationKeyNotice } from '@/components/moderation/moderation-key-notice'
import { useAuth } from '@/contexts/auth-context'
import { useModerationRole } from '@/hooks/use-is-moderator'
import { useModeratorRemoveModal, type ModeratorRemoveTarget } from '@/hooks/use-moderator-remove-modal'
import { moderationServiceFor } from '@/lib/services/moderation-service'
import { cn } from '@/lib/utils'

const MENU_ITEM = 'px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-900 cursor-pointer outline-none flex items-center gap-2'

/** Where the moderation settings open on one contract's panel, with a document's author and the document filled in. */
function moderateAuthorHref(target: ModeratorRemoveTarget, authorId: string): string {
  const params = new URLSearchParams({
    section: 'moderation',
    contract: target.contract,
    author: authorId,
    cite: `${target.docType}:${target.documentId}`,
  })
  return `/settings?${params.toString()}`
}

interface ModeratorContentMenuProps {
  target: ModeratorRemoveTarget
  /** The document's owner. Nothing is offered on the moderator's own documents, nor on a protected identity's (41102). */
  ownerId: string
  /** Runs once the removal landed, so the view drops the document. */
  onRemoved: () => void
  className?: string
}

/**
 * What a member of a contract's moderation team may do to one document of
 * it, beside the document: remove it (the same dialog as a post's, with the
 * deletion window and team rules its type declares), or open the moderation
 * settings on its author, to ban, suspend or warn them on that contract with
 * the document cited. Renders nothing for anyone else, so readers never see
 * it. Mirrors the moderator items of a post's menu.
 */
export function ModeratorContentMenu({ target, ownerId, onRemoved, className }: ModeratorContentMenuProps) {
  const router = useRouter()
  const { user } = useAuth()
  const { isModerator, protectedIds } = useModerationRole(target.contract)
  const canAuthorize = useModerationAuthorization(isModerator)
  const { open } = useModeratorRemoveModal()
  if (!isModerator || !user || !ownerId || ownerId === user.identityId || protectedIds.has(ownerId)) return null

  const settled = moderationServiceFor(target.contract).isSettled(target.docType, target.createdAt)
  const label = `Moderate this ${target.noun}`
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton
          data-testid={`moderator-menu-${target.documentId}`}
          aria-label={label}
          title={label}
          variant="danger"
          className={cn('h-8 w-8', className)}
          onClick={(e) => e.stopPropagation()}
        >
          <ShieldExclamationIcon className="h-5 w-5" />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="min-w-[220px] max-w-[min(24rem,calc(100vw-2rem))] bg-white dark:bg-neutral-900 rounded-xl shadow-lg border border-gray-200 dark:border-gray-800 py-2 z-50" sideOffset={5}>
          <ModerationKeyNotice authorized={canAuthorize} />
          <DropdownMenu.Item
            disabled={!canAuthorize}
            data-testid={`moderator-remove-${target.documentId}`}
            onClick={(e) => {
              e.stopPropagation()
              if (!canAuthorize) return
              open(target, onRemoved)
            }}
            className={cn(MENU_ITEM, 'text-red-500')}
          >
            <ShieldExclamationIcon className="h-4 w-4" />
            {settled ? `Remove ${target.noun} (settled: team only)` : `Remove ${target.noun}`}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={!canAuthorize}
            data-testid={`moderator-author-${target.documentId}`}
            onClick={(e) => {
              e.stopPropagation()
              if (!canAuthorize) return
              router.push(moderateAuthorHref(target, ownerId))
            }}
            className={MENU_ITEM}
          >
            <NoSymbolIcon className="h-4 w-4" />
            Ban, suspend or warn the author
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
