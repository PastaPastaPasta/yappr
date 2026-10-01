'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ShieldExclamationIcon, UserGroupIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/contexts/auth-context'
import { useModeratorRemoveModal } from '@/hooks/use-moderator-remove-modal'
import { logger } from '@/lib/logger'
import { moderatorDeleteWindowSeconds, targetKindOf } from '@/lib/contract-topology'
import { countedSigners, moderationService, type RemovalRoute, type TeamAction } from '@/lib/services/moderation-service'
import { CharterReasonPicker, useSeatedReasons } from './charter-reason-picker'

/** "7 days" for a window of 604800 seconds; hours below a day. */
function windowLabel(seconds: number | null): string {
  if (seconds === null) return 'deletion window'
  const days = Math.round(seconds / 86_400)
  if (days >= 1) return `${days}-day window`
  return `${Math.max(1, Math.round(seconds / 3600))}-hour window`
}

/**
 * A moderator's takedown of a post or reply. Unlike the owner's tombstone,
 * this DELETES the document: it stops resolving everywhere, every reference
 * at it dangles, and a removal record with the reason stays under the
 * contract for anyone to read.
 *
 * On v11 a post or reply settles a week after it was written: past that no
 * moderator removes it alone (41116). A member of the seated team proposes a
 * team removal instead, which runs once the leader and enough members
 * approve, and which can never be undone (41209). Before a team is seated
 * nobody removes a settled post (41205).
 */
export function ModeratorRemoveModal() {
  const { user } = useAuth()
  const { isOpen, post, onRemoved, close } = useModeratorRemoveModal()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  /**
   * A seated elected team must cite one of its charter's reasons on every
   * deletion (41203). Read only while the modal is open (only moderators can
   * open it), and again on every open, so a team seated mid-session is seen.
   */
  const seatedReasons = useSeatedReasons(isOpen)
  const [reasonDocumentId, setReasonDocumentId] = useState('')
  /** How this viewer may remove the post: null while it is being worked out (a settled post reads the seated team). */
  const [route, setRoute] = useState<RemovalRoute | null>(null)
  const [routeFailed, setRouteFailed] = useState(false)
  /**
   * On the team route: the active proposal already naming this document,
   * which a member approves rather than proposing again, with its approvals
   * still on the team and whether the viewer gave one (a second is 41208).
   */
  const [existing, setExisting] = useState<(TeamAction & { approvals: number; viewerSigned: boolean }) | null>(null)
  /** Bumped on every open and reroute, so a late answer for an earlier post or route is dropped. */
  const routeRequest = useRef(0)
  const kind = post ? targetKindOf(post) : 'post'
  const noun = kind === 'reply' ? 'reply' : 'post'
  const viewerId = user?.identityId
  const postId = post?.id
  const createdAtMs = post?.createdAt ? new Date(post.createdAt).getTime() : Number.NaN
  /** No deletion window (v2, v9, v10): always the single removal, known without reading anything. */
  const windowless = moderatorDeleteWindowSeconds(kind) === null

  /**
   * Works out the route (and, for the team route, any proposal already
   * naming this document: a second one would split the team's approvals).
   * `now` past the window forces the settled route once the node said so.
   */
  const loadRoute = useCallback((now?: number) => {
    if (!postId || !viewerId || windowless) return
    const request = ++routeRequest.current
    setRoute(null)
    setRouteFailed(false)
    setExisting(null)
    // A post whose time is unknown is routed as written at 0 once the node says it settled.
    const createdAt = now !== undefined && !Number.isFinite(createdAtMs) ? 0 : createdAtMs
    moderationService.removalRoute(viewerId, kind, createdAt, now).then(async (next) => {
      const proposed = next.route === 'team' ? await moderationService.findActiveTeamAction(postId) : null
      const [signers, seated] = proposed
        ? await Promise.all([moderationService.teamActionSigners(proposed.actionId, 'active'), moderationService.getSeatedTeam()])
        : [[], null]
      if (routeRequest.current !== request) return
      setExisting(proposed && {
        ...proposed,
        approvals: countedSigners(signers, seated).length,
        viewerSigned: proposed.proposerId === viewerId || signers.includes(viewerId),
      })
      setRoute(next)
    }).catch((error: unknown) => {
      logger.warn('ModeratorRemoveModal: could not read the seated team or its actions', error)
      if (routeRequest.current === request) setRouteFailed(true)
    })
  }, [postId, viewerId, kind, createdAtMs, windowless])

  useEffect(() => {
    if (isOpen) {
      loadRoute()
      return
    }
    // Closed: forget the last post's route, so a reopen for another post
    // never paints the old one (or its Approve) before the read lands.
    routeRequest.current++
    setRoute(null)
    setExisting(null)
    setRouteFailed(false)
  }, [isOpen, loadRoute])

  const reset = () => {
    setReason('')
    setReasonDocumentId('')
  }

  const handleClose = () => {
    if (busy) return
    reset()
    close()
  }

  /** The charter reason gate both routes share; false (with a toast) when the action must wait. */
  const reasonReady = (): boolean => {
    if (seatedReasons.loading) return false
    if (seatedReasons.failed) {
      toast.error('Could not read the elected team\'s charter; try again')
      return false
    }
    if (seatedReasons.required && !reasonDocumentId) {
      toast.error('Choose the charter reason this removal is taken on')
      return false
    }
    return true
  }

  const handleRemove = async () => {
    if (!post || !user || busy || !reasonReady()) return
    setBusy(true)
    const result = await moderationService.removeDocument(user.identityId, kind, post.id, {
      text: reason.trim(),
      ...(seatedReasons.required && reasonDocumentId ? { reasonDocumentId } : {}),
    })
    setBusy(false)
    if (result.errorCode === 'MAYBE_APPLIED') {
      // The DAPI gateway often times out on a delete that landed: say so, keep
      // the dialog closed, and do not drop the card until it is checked.
      toast(`This ${noun} may have been removed — the network did not confirm in time. Check again before retrying.`
        + (result.snapshotSaved ? ' A copy is kept on this device in case it needs restoring.' : ''), { duration: 8000 })
      reset()
      close()
      return
    }
    if (result.errorCode === 'DELETE_WINDOW_ELAPSED') {
      // Block time says it settled while this device's clock did not: route
      // it as settled, so a team member can propose from the same dialog.
      toast.error(result.error || 'This has settled')
      loadRoute(Number.POSITIVE_INFINITY)
      return
    }
    if (result.errorCode === 'DOCUMENT_GONE') {
      // Already removed (by another moderator, or an earlier attempt whose
      // answer was lost): what was asked for holds.
      toast(result.error ?? `This ${noun} is already gone`, { duration: 6000 })
      onRemoved?.()
      reset()
      close()
      return
    }
    if (!result.success) {
      toast.error(result.error || 'Removal failed')
      return
    }
    const removed = `${noun === 'reply' ? 'Reply' : 'Post'} removed`
    toast.success(result.snapshotSaved
      ? `${removed}. A copy is kept on this device for a week, so it can be restored from the moderation settings.`
      : `${removed}. No copy could be kept on this device, so it cannot be restored.`)
    onRemoved?.()
    reset()
    close()
  }

  const handlePropose = async () => {
    if (!post || !user || busy || route?.route !== 'team' || !route.reachable || !reasonReady()) return
    if (!reasonDocumentId) {
      toast.error('Choose the charter reason this removal is taken on')
      return
    }
    setBusy(true)
    const result = await moderationService.proposeSettledDeletion(user.identityId, kind, post.id, { text: reason.trim(), reasonDocumentId })
    setBusy(false)
    if (result.errorCode === 'MAYBE_APPLIED') {
      toast(result.error ?? 'The proposal may have gone through. Check the team actions before proposing again.', { duration: 8000 })
      reset()
      close()
      return
    }
    if (result.errorCode === 'NOT_SETTLED') {
      // Block time says it is still open while this device's clock ran
      // ahead: offer the single removal the node asks for.
      toast.error(result.error || 'This has not settled yet')
      routeRequest.current++
      setExisting(null)
      setRoute({ route: 'single', closing: true })
      return
    }
    if (!result.success) {
      toast.error(result.error || 'Proposal failed')
      return
    }
    if (result.status === 'closed') {
      toast.success(`${noun === 'reply' ? 'Reply' : 'Post'} removed by the team. A team removal cannot be undone.`)
      onRemoved?.()
    } else {
      const more = route.needed - 1
      toast.success(`Team removal proposed. It needs ${more} more approval${more === 1 ? '' : 's'}${route.leaderRequired && !route.viewerIsLeader ? ', the leader\'s among them' : ''}; members approve it from the moderation settings.`, { duration: 8000 })
    }
    reset()
    close()
  }

  /** Approves the proposal another member already made for this document, rather than splitting the team's approvals. */
  const handleApproveExisting = async () => {
    if (!user || busy || !existing || existing.viewerSigned) return
    setBusy(true)
    const result = await moderationService.approveTeamAction(user.identityId, existing.actionId)
    setBusy(false)
    if (result.errorCode === 'MAYBE_APPLIED') {
      toast(result.error ?? 'Your approval may have gone through. Check again before retrying.', { duration: 8000 })
    } else if (!result.success) {
      toast.error(result.error || 'Approval failed')
      return
    } else if (result.status === 'closed') {
      toast.success(`${noun === 'reply' ? 'Reply' : 'Post'} removed by the team. A team removal cannot be undone.`)
      onRemoved?.()
    } else {
      toast.success('Approved. The removal runs once the rest of the team approves it.')
    }
    reset()
    close()
  }

  const windowText = windowLabel(moderatorDeleteWindowSeconds(kind))
  const effectiveRoute: RemovalRoute | null = windowless ? { route: 'single', closing: false } : route
  const team = effectiveRoute?.route === 'team' ? effectiveRoute : null
  const blocked = effectiveRoute?.route === 'none' ? effectiveRoute : null

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && handleClose()} className="w-[420px] max-w-[90vw]">
      <ModalTitle>
        {team ? <UserGroupIcon className="h-6 w-6 text-red-500" /> : <ShieldExclamationIcon className="h-6 w-6 text-red-500" />}
        {team ? `Propose team removal of this ${noun}?` : `Remove ${noun} as a moderator?`}
      </ModalTitle>
      <Dialog.Description className="text-gray-600 dark:text-gray-400 mb-4">
        {team ? (
          <>
            This {noun} is past its {windowText}, so it has settled: no moderator removes it alone. Your proposal counts as
            your approval, and it is removed once {team.needed} members of the seated team have approved it
            {team.leaderRequired ? ', the leader among them' : ''}. A team removal is public, cannot be undone, and keeps a
            removal record with the charter reason.
            {!team.reachable && (
              <span data-testid="moderator-remove-unreachable" className="block mt-2 text-red-600 dark:text-red-400">
                The team has fewer people than the {team.needed} approvals a team removal needs, so a proposal could never
                run. The team must add a member before it can remove settled posts.
              </span>
            )}
            {existing && (
              <span data-testid="moderator-remove-existing" className="block mt-2 text-amber-600 dark:text-amber-400">
                {existing.viewerSigned
                  ? `You already approved its removal (${existing.approvals} of ${existing.neededApprovals ?? team.needed} approvals). It runs once the rest of the team approves it.`
                  : `A member already proposed its removal (${existing.approvals} of ${existing.neededApprovals ?? team.needed} approvals${existing.reason ? `, reason: ${existing.reason}` : ''}). Approve that proposal rather than proposing again, which would split the team's approvals.`}
              </span>
            )}
          </>
        ) : blocked ? (
          blocked.why === 'noTeamSeated'
            ? `This ${noun} is past its ${windowText}, so it has settled. Only a seated moderation team removes a settled ${noun}, together, and no team is seated yet.`
            : blocked.why === 'notOnTeam'
              ? `This ${noun} is past its ${windowText}, so it has settled. Only the seated moderation team removes it, together.`
              : `This ${noun} is past its ${windowText}, and nobody may remove it once settled.`
        ) : (
          <>
            The {noun} is deleted from the contract for everyone. Its author is not refunded, the id can never be reused,
            and a public removal record with your reason stays on-chain. This device will try to keep a copy for a week,
            so the removal can be undone from here.
            {effectiveRoute?.route === 'single' && effectiveRoute.closing && (
              <span className="block mt-2 text-amber-600 dark:text-amber-400">
                Its {windowText} is about to close. If the network says it has settled, a member of the seated team can
                propose a team removal instead.
              </span>
            )}
          </>
        )}
      </Dialog.Description>
      {post && (
        <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
          <p className="text-sm text-gray-600 dark:text-gray-400 line-clamp-3">{post.content}</p>
        </div>
      )}
      {routeFailed && (
        <p role="alert" className="mb-4 text-sm text-red-500">Could not read the moderation team; close and try again.</p>
      )}
      {!blocked && !routeFailed && !existing && (
        <>
          <label htmlFor="moderator-remove-reason" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Reason (public, recorded on-chain)
          </label>
          <input
            id="moderator-remove-reason"
            type="text"
            value={reason}
            maxLength={1024}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why this is being removed"
            className="w-full mb-4 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-neutral-800 text-sm focus:outline-none focus:ring-2 focus:ring-yappr-500"
          />
          {(seatedReasons.required || seatedReasons.failed) && (
            <div className="mb-4">
              <CharterReasonPicker id="moderator-remove-charter-reason" state={seatedReasons} value={reasonDocumentId} onChange={setReasonDocumentId} />
            </div>
          )}
        </>
      )}
      <div className="flex flex-col gap-3">
        {team && existing ? (
          !existing.viewerSigned && (
            <Button onClick={handleApproveExisting} disabled={busy} className="w-full bg-red-500 hover:bg-red-600 text-white">
              {busy ? 'Approving…' : 'Approve the proposed removal'}
            </Button>
          )
        ) : team ? (
          <Button onClick={handlePropose} disabled={busy || seatedReasons.loading || !team.reachable} className="w-full bg-red-500 hover:bg-red-600 text-white">
            {busy ? 'Proposing…' : 'Propose team removal'}
          </Button>
        ) : !blocked && !routeFailed && (
          <Button onClick={handleRemove} disabled={busy || seatedReasons.loading || effectiveRoute === null} className="w-full bg-red-500 hover:bg-red-600 text-white">
            {busy ? 'Removing…' : effectiveRoute === null ? 'Checking…' : `Remove ${noun}`}
          </Button>
        )}
        <Button onClick={handleClose} variant="outline" disabled={busy} className="w-full">
          {blocked ? 'Close' : 'Cancel'}
        </Button>
      </div>
    </Modal>
  )
}
