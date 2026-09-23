'use client'

import { useId, useState } from 'react'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { UserAvatar } from '@/components/ui/avatar-image'
import { MAX_GROUP_MEMBERS, type ConversationView } from '@/lib/services/dm-v5'
import type { UserDetails } from '@/lib/utils/resolve-user-details'
import { DmDialog, errorText } from './dm-ui'
import { UserPicker } from './user-picker'
import { displayNameOf } from './use-dm-engine'

export interface GroupActions {
  rename: (name: string) => Promise<void>
  add: (memberId: string) => Promise<void>
  remove: (memberId: string) => Promise<void>
  resendKeys: (memberId: string) => Promise<void>
  leave: () => Promise<void>
  end: () => Promise<void>
}

interface GroupSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  group: ConversationView
  viewerId: string
  details: ReadonlyMap<string, UserDetails>
  actions: GroupActions
}

type Confirm = { title: string; message: string; confirmText: string; run: () => Promise<void> } | null

/**
 * Members, and the owner's controls: rename, add, remove, "Resend keys" per
 * member, end the group. Members can leave. Each action is one or two writes
 * by the owner (docs/DM_V5.md §6.4).
 */
export function GroupSettingsDialog({ open, onOpenChange, group, viewerId, details, actions }: GroupSettingsDialogProps) {
  const nameId = useId()
  const pickerId = useId()
  const [name, setName] = useState(group.name)
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const owner = group.isOwner
  const inactive = group.ended || group.removed

  const run = async (label: string, task: () => Promise<void>, done: string) => {
    setBusy(label)
    try {
      await task()
      toast.success(done)
    } catch (error) {
      toast.error(errorText(error, 'Something went wrong'))
    } finally {
      setBusy(null)
    }
  }

  const members = group.memberIds.filter((id) => id !== group.peerId)

  return (
    <>
      <DmDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Group settings"
        description="Members and settings of this group."
        closeLabel="Close group settings"
      >
        {group.ended && <p className="mb-4 text-sm text-gray-500">This group has ended.</p>}
        {group.removed && <p className="mb-4 text-sm text-gray-500">You are no longer a member of this group.</p>}

        {owner && !inactive ? (
          <form
            className="mb-6 flex gap-2 items-end"
            onSubmit={(e) => {
              e.preventDefault()
              run('rename', () => actions.rename(name), 'Group renamed').catch(() => undefined)
            }}
          >
            <div className="flex-1">
              <label htmlFor={nameId} className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Name</label>
              <Input id={nameId} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} disabled={busy !== null} />
            </div>
            <Button type="submit" variant="outline" disabled={busy !== null || !name.trim() || name.trim() === group.name}>
              {busy === 'rename' ? <Spinner size="sm" /> : 'Rename'}
            </Button>
          </form>
        ) : (
          <p className="mb-6 font-semibold">{group.name || 'Group'}</p>
        )}

        <h3 className="text-sm font-semibold mb-2">
          Members ({group.memberIds.length}/{MAX_GROUP_MEMBERS})
        </h3>
        <ul className="mb-4 border border-gray-200 dark:border-gray-700 rounded-xl divide-y divide-gray-100 dark:divide-gray-800">
          {[group.peerId, ...members].map((id) => (
            <li key={id} className="flex items-center gap-3 p-3">
              <div className="h-9 w-9 rounded-full overflow-hidden bg-gray-100 dark:bg-gray-800 flex-shrink-0">
                <UserAvatar userId={id} size="md" alt="" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">
                  {displayNameOf(details, id)}
                  {id === viewerId && ' (you)'}
                </p>
                {id === group.peerId && <p className="text-xs text-gray-500">Owner</p>}
              </div>
              {owner && !inactive && id !== viewerId && (
                <div className="flex gap-1 flex-shrink-0">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => run(`resend:${id}`, () => actions.resendKeys(id), 'Keys sent').catch(() => undefined)}
                  >
                    {busy === `resend:${id}` ? <Spinner size="sm" /> : 'Resend keys'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red-600"
                    disabled={busy !== null}
                    onClick={() =>
                      setConfirm({
                        title: 'Remove member?',
                        message: `${displayNameOf(details, id)} will not be able to read new messages. This writes a new group key for everyone else.`,
                        confirmText: 'Remove',
                        run: () => run(`remove:${id}`, () => actions.remove(id), 'Member removed'),
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>

        {owner && !inactive && (
          adding ? (
            <div className="mb-4">
              <UserPicker
                inputId={pickerId}
                query={query}
                onQueryChange={setQuery}
                viewerId={viewerId}
                disabled={busy !== null}
                excludeIds={new Set(group.memberIds)}
                onPick={(user) => {
                  run('add', () => actions.add(user.id), `${user.displayName} added`)
                    .then(() => {
                      setAdding(false)
                      setQuery('')
                    })
                    .catch(() => undefined)
                }}
                hint="New members can read messages sent after they join."
              />
              <Button variant="outline" className="w-full" onClick={() => setAdding(false)}>Cancel</Button>
            </div>
          ) : (
            <Button variant="outline" className="w-full mb-4" disabled={busy !== null || group.memberIds.length >= MAX_GROUP_MEMBERS} onClick={() => setAdding(true)}>
              Add member
            </Button>
          )
        )}

        {!inactive && (
          <Button
            variant="destructive"
            className="w-full"
            disabled={busy !== null}
            onClick={() =>
              setConfirm(
                owner
                  ? { title: 'End this group?', message: 'Nobody will be able to send messages to it any more. This cannot be undone.', confirmText: 'End group', run: () => run('end', actions.end, 'Group ended') }
                  : { title: 'Leave this group?', message: 'The owner removes you the next time they open the app. Until then you can still read new messages.', confirmText: 'Leave', run: () => run('leave', actions.leave, 'You left the group') }
              )
            }
          >
            {owner ? 'End group' : 'Leave group'}
          </Button>
        )}
      </DmDialog>
      <ConfirmDialog
        isOpen={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const pending = confirm
          setConfirm(null)
          pending?.run().catch(() => undefined)
        }}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmText={confirm?.confirmText}
      />
    </>
  )
}
