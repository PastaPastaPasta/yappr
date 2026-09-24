'use client'

import { useId, useState } from 'react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { MAX_GROUP_MEMBERS } from '@/lib/services/dm-v5'
import { DmDialog, errorText } from './dm-ui'
import { UserPicker } from './user-picker'
import type { UserSearchResult } from './use-user-search'

interface NewGroupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  viewerId: string | undefined
  onCreate: (name: string, memberIds: string[]) => Promise<void>
}

export function NewGroupDialog({ open, onOpenChange, viewerId, onCreate }: NewGroupDialogProps) {
  const nameId = useId()
  const pickerId = useId()
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<UserSearchResult[]>([])
  const [busy, setBusy] = useState(false)
  const pickedIds = new Set(picked.map((p) => p.id))
  // The owner counts toward the limit.
  const full = picked.length + 1 >= MAX_GROUP_MEMBERS

  const close = () => {
    setName('')
    setQuery('')
    setPicked([])
    onOpenChange(false)
  }

  const toggle = (user: UserSearchResult) => {
    if (pickedIds.has(user.id)) setPicked((list) => list.filter((p) => p.id !== user.id))
    else if (!full) setPicked((list) => [...list, user])
    else toast.error(`A group can have at most ${MAX_GROUP_MEMBERS} members.`)
  }

  const create = async () => {
    if (busy || !name.trim() || picked.length === 0) return
    setBusy(true)
    try {
      await onCreate(name.trim(), picked.map((p) => p.id))
      close()
    } catch (error) {
      toast.error(errorText(error, 'Could not create the group'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DmDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title="New Group"
      description="Name the group and pick its members."
      closeLabel="Close new group"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          create().catch(() => undefined)
        }}
      >
        <div className="mb-4">
          <label htmlFor={nameId} className="block text-sm font-medium mb-2 text-gray-700 dark:text-gray-300">Group name</label>
          <Input id={nameId} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} disabled={busy} placeholder="Name" />
        </div>
        {picked.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2" aria-label="Members">
            {picked.map((p) => (
              <button key={p.id} type="button" onClick={() => toggle(p)} className="flex items-center gap-1 rounded-full bg-gray-100 dark:bg-gray-800 px-3 py-1 text-sm">
                {p.displayName}
                <XMarkIcon className="h-4 w-4" aria-label={`Remove ${p.displayName}`} />
              </button>
            ))}
          </div>
        )}
        <UserPicker
          inputId={pickerId}
          query={query}
          onQueryChange={setQuery}
          onPick={toggle}
          viewerId={viewerId}
          disabled={busy}
          selectedIds={pickedIds}
          hint={`${picked.length + 1} of ${MAX_GROUP_MEMBERS} members, including you`}
        />
        <p className="text-xs text-gray-500 mb-4">
          Each member gets the group key in a private message from you. Nobody outside the group can see who is in it.
        </p>
        <div className="flex gap-3">
          <Button type="button" variant="outline" className="flex-1" onClick={close}>Cancel</Button>
          <Button type="submit" className="flex-1" disabled={busy || !name.trim() || picked.length === 0}>
            {busy ? <Spinner size="sm" className="border-white" /> : 'Create group'}
          </Button>
        </div>
      </form>
    </DmDialog>
  )
}
