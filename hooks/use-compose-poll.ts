'use client'

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { pollrPollUrl } from '@/lib/poll-embed'
import { createPollDraft, type PollDraft } from '@/components/compose/poll-editor'

/**
 * A poll attached to the post being composed. `createdPollId` survives a
 * failed post attempt so the retry re-uses the poll that already landed
 * instead of paying for a second, orphaned one; `unconfirmed` marks a poll
 * whose broadcast succeeded but was never seen queryable.
 */
export function useComposePoll(canAttach: boolean) {
  const [draft, setDraft] = useState<PollDraft | null>(null)
  const [createdPollId, setCreatedPollId] = useState<string | null>(null)
  const [unconfirmed, setUnconfirmed] = useState(false)

  /** Drop the poll silently: after a successful post, where nothing is orphaned. */
  const forget = useCallback(() => {
    setDraft(null)
    setCreatedPollId(null)
    setUnconfirmed(false)
  }, [])

  /** Detach the poll; one that already landed is now orphaned, so say where it lives. */
  const clear = useCallback(() => {
    if (createdPollId) {
      const url = pollrPollUrl(createdPollId)
      toast(url ? `Your poll stays live on Pollr: ${url}` : 'Your poll document stays live on the Pollr contract.', { duration: 8000, icon: '📊' })
    }
    forget()
  }, [createdPollId, forget])

  const toggle = useCallback(() => {
    if (draft) clear()
    else setDraft(createPollDraft())
  }, [draft, clear])

  // A private visibility or a reply cannot carry a poll; drop it if one is attached.
  useEffect(() => {
    if (draft && !canAttach) clear()
  }, [draft, canAttach, clear])

  return { draft, setDraft, createdPollId, setCreatedPollId, unconfirmed, setUnconfirmed, forget, clear, toggle }
}
