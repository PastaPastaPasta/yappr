'use client'

import { useId, useState } from 'react'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { DmDialog, errorText } from './dm-ui'
import { UserPicker } from './user-picker'
import { resolveUserInput } from './use-user-search'

type StartUser = { id: string; username?: string; displayName?: string }

interface NewMessageDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  viewerId: string | undefined
  /** Open (or create the draft of) the 1:1 with this identity. Throws a user-facing error. */
  onStart: (user: StartUser) => Promise<void>
}

export function NewMessageDialog({ open, onOpenChange, viewerId, onStart }: NewMessageDialogProps) {
  const inputId = useId()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)

  const close = () => {
    setQuery('')
    onOpenChange(false)
  }

  const start = async (user: StartUser) => {
    if (busy) return
    if (user.id === viewerId) {
      toast.error("You can't message yourself")
      return
    }
    setBusy(true)
    try {
      await onStart(user)
      close()
    } catch (error) {
      toast.error(errorText(error, 'Failed to start conversation'))
    } finally {
      setBusy(false)
    }
  }

  const submitTyped = async () => {
    if (!query.trim() || busy) return
    try {
      await start(await resolveUserInput(query))
    } catch (error) {
      toast.error(errorText(error, 'Failed to start conversation'))
    }
  }

  return (
    <DmDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title="New Message"
      description="Choose a person to start an encrypted conversation."
      closeLabel="Close new message"
      className="max-h-[80vh]"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submitTyped().catch(() => undefined)
        }}
      >
        <UserPicker inputId={inputId} query={query} onQueryChange={setQuery} onPick={start} viewerId={viewerId} disabled={busy} />
        <div className="flex gap-3">
          <Button type="button" variant="outline" className="flex-1" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" className="flex-1" disabled={!query.trim() || busy}>
            {busy ? <Spinner size="sm" className="border-white" /> : 'Start Chat'}
          </Button>
        </div>
      </form>
    </DmDialog>
  )
}
