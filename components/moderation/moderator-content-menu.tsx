'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ExclamationTriangleIcon, EyeIcon, EyeSlashIcon, LockOpenIcon, NoSymbolIcon, ShieldExclamationIcon } from '@heroicons/react/24/outline'
import { IconButton } from '@/components/ui/icon-button'
import { useAuth } from '@/contexts/auth-context'
import { useAuthorRestricted } from '@/hooks/use-author-restriction'
import { useModerationRole } from '@/hooks/use-is-moderator'
import { useModeratorHideModal, type ModeratorHideAction, type ModeratorHideOutcome } from '@/hooks/use-moderator-hide-modal'
import { useModeratorRemoveModal, type ModeratorRemoveTarget } from '@/hooks/use-moderator-remove-modal'
import { isHidden } from '@/lib/moderation-view'
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
  /** Runs once the removal (or, on a hide cut without `onChanged`, the hide) landed, so the view drops the document. */
  onRemoved: () => void
  /**
   * On a hide cut: runs after a hide, an unhide, a restriction or a lift,
   * with what changed, for a view that keeps the document and relabels it
   * (a detail page). Without it a hide drops the document (`onRemoved`).
   */
  onChanged?: (outcome: ModeratorHideOutcome) => void
  className?: string
}

/**
 * What a member of a contract's moderation team may do to one document of
 * it, beside the document. Renders nothing for anyone else, so readers never
 * see it. Mirrors the moderator items of a post's menu.
 *
 * - Before the "hide, don't delete" cuts: remove it (the same dialog as a
 *   post's, with the deletion window and team rules its type declares), or
 *   open the moderation settings on its author to ban, suspend or warn them.
 * - On social v18, blog v10 and storefront v11: hide or unhide it, restrict
 *   its author or lift the restriction (social and blog), or warn the author
 *   from the moderation settings with the document cited.
 */
export function ModeratorContentMenu({ target, ownerId, onRemoved, onChanged, className }: ModeratorContentMenuProps) {
  const router = useRouter()
  const { user } = useAuth()
  const { isModerator, protectedIds } = useModerationRole(target.contract)
  const { open } = useModeratorRemoveModal()
  const { open: openHide } = useModeratorHideModal()
  const service = moderationServiceFor(target.contract)
  const hides = service.hidesInsteadOfDeleting()
  const shown = isModerator && !!user && !!ownerId && ownerId !== user.identityId && !protectedIds.has(ownerId)
  const readRestricted = useAuthorRestricted(target.contract, ownerId, shown && hides && service.canRestrict())
  /** Set by this menu's own restriction or lift, until the next read. */
  const [restrictedHere, setRestrictedHere] = useState<boolean | null>(null)
  const [hiddenHere, setHiddenHere] = useState<boolean | null>(null)
  if (!shown) return null

  const label = `Moderate this ${target.noun}`
  const hidden = hiddenHere ?? isHidden(target.moderation)
  const restricted = restrictedHere ?? readRestricted
  const openAction = (action: ModeratorHideAction) => {
    openHide({ action, contract: target.contract, docType: target.docType, documentId: target.documentId, authorId: ownerId, noun: target.noun, preview: target.preview }, (outcome) => {
      if (outcome.restricted !== undefined) setRestrictedHere(outcome.restricted)
      if (outcome.moderation !== undefined) setHiddenHere(isHidden(outcome.moderation))
      // A list drops what was just hidden; a detail page (`onChanged`) keeps it and relabels it.
      if (action === 'hide' && !onChanged) onRemoved()
      else onChanged?.(outcome)
    })
  }
  const item = (testId: string, onSelect: () => void, children: React.ReactNode, tone?: string) => (
    <DropdownMenu.Item
      data-testid={`${testId}-${target.documentId}`}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
      className={cn(MENU_ITEM, tone)}
    >
      {children}
    </DropdownMenu.Item>
  )

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
          {hides ? (
            <>
              {service.canHide(target.docType) && (hidden
                ? item('moderator-unhide', () => openAction('unhide'), <><EyeIcon className="h-4 w-4" />Unhide {target.noun}</>)
                : item('moderator-hide', () => openAction('hide'), <><EyeSlashIcon className="h-4 w-4" />Hide {target.noun}</>, 'text-red-500'))}
              {/* Holds its place while the author's standing is read, so nothing shifts under the pointer. */}
              {service.canRestrict() && (restricted === null
                ? (
                  <DropdownMenu.Item disabled aria-busy data-testid={`moderator-restrict-${target.documentId}`} className={cn(MENU_ITEM, 'opacity-50')}>
                    <NoSymbolIcon className="h-4 w-4" />Restrict the author
                  </DropdownMenu.Item>
                )
                : restricted
                  ? item('moderator-lift', () => openAction('lift'), <><LockOpenIcon className="h-4 w-4" />Lift the author&apos;s restriction</>)
                  : item('moderator-restrict', () => openAction('restrict'), <><NoSymbolIcon className="h-4 w-4" />Restrict the author</>, 'text-red-500'))}
              {service.canWarn() && item('moderator-author', () => router.push(moderateAuthorHref(target, ownerId)), <><ExclamationTriangleIcon className="h-4 w-4" />Warn the author</>)}
            </>
          ) : (
            <>
              {item('moderator-remove', () => open(target, onRemoved), (
                <>
                  <ShieldExclamationIcon className="h-4 w-4" />
                  {service.isSettled(target.docType, target.createdAt) ? `Remove ${target.noun} (settled: team only)` : `Remove ${target.noun}`}
                </>
              ), 'text-red-500')}
              {item('moderator-author', () => router.push(moderateAuthorHref(target, ownerId)), <><NoSymbolIcon className="h-4 w-4" />Ban, suspend or warn the author</>)}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
