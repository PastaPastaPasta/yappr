'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useAuth } from '@/contexts/auth-context'
import { logger } from '@/lib/logger'
import type { SeatedTeam } from '@/lib/services/moderation-election-service'
import { charterService, type JoinRequest, type TeamRecord } from '@/lib/services/charter-service'
import type { CharterAction } from '@/lib/moderation-charters/refusals'
import { teamChanges } from '@/lib/moderation-charters/team-flow'
import { IdentityName, Notice, useCharterRun } from './shared'

/** A team change waiting for the leader to confirm it. */
interface PendingChange {
  title: string
  message: string
  confirmText: string
  variant: 'danger' | 'default'
  label: string
  action: CharterAction
  work: () => Promise<unknown>
}

const PAYOUT = 'The moderators pot is paid out to the team as it stands first, and the change costs a small fee.'
const TAKE_OFF = { title: 'Take this member off the team?', message: `They stop moderating as soon as this is recorded. You can put them back later. ${PAYOUT}`, confirmText: 'Take off', variant: 'danger' as const }

interface Records {
  additions: TeamRecord[]
  removals: TeamRecord[]
  resigning: string[]
}

/**
 * The seated leader's team changes: add a member from the proposal's join
 * requests (up to the contract's `maxAddedModerators` at a time), take a
 * member off, put a removed one back, and see who asked to leave. Every
 * change first pays the moderators pot out to the team as it was.
 */
export function TeamAdmin({ seated, requests, maxAdded, onChanged }: {
  seated: SeatedTeam
  requests: readonly JoinRequest[]
  maxAdded: number
  onChanged: () => Promise<void>
}) {
  const { user } = useAuth()
  const me = user?.identityId ?? null
  const [records, setRecords] = useState<Records | null>(null)
  const { busy, error, setError, run } = useCharterRun()
  // Each change is confirmed first: a session that holds its signing key signs on the click.
  const [pending, setPending] = useState<PendingChange | null>(null)

  const load = useCallback(async () => {
    try {
      const [additions, removals, resigning] = await Promise.all([
        charterService.teamRecords('addedModerator', seated.electedCharterId),
        charterService.teamRecords('removedModerator', seated.electedCharterId),
        charterService.pendingResignations(seated.electedCharterId),
      ])
      setRecords({ additions, removals, resigning })
    } catch (readError) {
      logger.warn('Moderation teams: team changes could not be read', readError)
      setError("The team's changes could not be read. Refresh to try again.")
    }
  }, [seated.electedCharterId, setError])

  useEffect(() => { load().catch(() => { /* reported inside */ }) }, [load])

  if (!me || me !== seated.leaderId) return null
  if (!records) return <p className="text-sm text-gray-500">{error ?? 'Loading your team…'}</p>

  const changes = teamChanges({
    seated,
    electedMembers: seated.electedMembers ?? seated.members,
    additions: records.additions.map((r) => r.memberId),
    removals: records.removals.map((r) => r.memberId),
    requested: requests.map((r) => r.ownerId),
    maxAddedModerators: maxAdded,
  })
  const changeOf = (list: TeamRecord[], memberId: string) => (
    { documentId: list.find((r) => r.memberId === memberId)?.id ?? '', electedCharterId: seated.electedCharterId, memberId })

  const act = (label: string, action: CharterAction, work: () => Promise<unknown>) => run(label, action, async () => {
    await work()
    await Promise.all([load(), onChanged()])
  })

  const row = (id: string, button: React.ReactNode, note?: string) => (
    <li key={id} className="flex items-center justify-between gap-2 text-sm">
      <span><IdentityName id={id} />{note && <span className="ml-2 text-xs text-gray-500">{note}</span>}</span>
      {button}
    </li>
  )

  return (
    <div className="space-y-4" data-testid="team-admin">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        You lead this team. Each change pays the moderators pot out to the team as it stood first.
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      {busy && <Notice>{busy}</Notice>}
      {records.resigning.length > 0 && (
        <Notice tone="warn">
          Asked to leave: {records.resigning.map((id, i) => <span key={id}>{i > 0 && ', '}<IdentityName id={id} /></span>)}. Take them off below.
        </Notice>
      )}
      <div>
        <h4 className="font-semibold text-sm mb-1">On the team</h4>
        <ul className="space-y-1">
          {changes.removable.map((id) => row(id,
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setPending({
              ...TAKE_OFF, label: 'Taking the member off…', action: 'remove-member', work: () => charterService.removeMember(me, seated.electedCharterId, id),
            })}>Take off</Button>,
            'elected'))}
          {changes.added.map((id) => row(id,
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setPending({
              ...TAKE_OFF, label: 'Taking the member off…', action: 'undo-team-change', work: () => charterService.undoTeamChange(me, 'addedModerator', changeOf(records.additions, id)),
            })}>Take off</Button>,
            'added'))}
          {changes.removable.length + changes.added.length === 0 && <li className="text-sm text-gray-500">Only you.</li>}
        </ul>
      </div>
      {changes.restorable.length > 0 && (
        <div>
          <h4 className="font-semibold text-sm mb-1">Taken off</h4>
          <ul className="space-y-1">
            {changes.restorable.map((id) => row(id,
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setPending({
                title: 'Put this member back on the team?', message: `They can moderate again as soon as this is recorded. ${PAYOUT}`, confirmText: 'Put back', variant: 'default',
                label: 'Putting the member back…', action: 'undo-team-change', work: () => charterService.undoTeamChange(me, 'removedModerator', changeOf(records.removals, id)),
              })}>Put back</Button>))}
          </ul>
        </div>
      )}
      <div>
        <h4 className="font-semibold text-sm mb-1">Asked to join ({changes.addable.length})</h4>
        {!changes.canAdd && <p className="text-xs text-gray-500">You have added {maxAdded} of {maxAdded} members this contract allows. Take one off to add another.</p>}
        <ul className="space-y-1">
          {changes.addable.map((id) => row(id,
            <Button size="sm" disabled={busy !== null || !changes.canAdd} onClick={() => setPending({
              title: 'Add this member to the team?', message: `They can moderate as soon as this is recorded, and you can take them off later. ${PAYOUT}`, confirmText: 'Add', variant: 'default',
              label: 'Adding the member…', action: 'add-member', work: () => charterService.addMember(me, seated, id),
            })}>Add</Button>))}
          {changes.addable.length === 0 && <li className="text-sm text-gray-500">Nobody else has asked to join.</li>}
        </ul>
      </div>
      <ConfirmDialog
        isOpen={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => {
          const change = pending
          setPending(null)
          if (change) act(change.label, change.action, change.work).catch(() => { /* reported inside */ })
        }}
        title={pending?.title ?? ''}
        message={pending?.message ?? ''}
        confirmText={pending?.confirmText}
        variant={pending?.variant}
      />
    </div>
  )
}
