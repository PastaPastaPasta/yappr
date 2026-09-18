'use client'

import { useCallback, useEffect, useState } from 'react'
import { Modal, ModalTitle } from '@/components/ui/modal'
import { YAPPR_BLOG_CONTRACT_ID } from '@/lib/constants'
import { logger } from '@/lib/logger'

interface Revision {
  revision: number
  /** Platform's history key: the ms timestamp the revision was committed at. */
  at: Date
  title: string
}

/**
 * Every revision of a post, newest first. `blogPost` is history-keeping on
 * both contract versions, so this works everywhere — the data has always been
 * stored, nothing read it.
 */
async function loadRevisions(postId: string): Promise<Revision[]> {
  const { getEvoSdk } = await import('@/lib/services/evo-sdk-service')
  const sdk = await getEvoSdk()
  // Map<bigint timestampMs, Document>.
  const history = await sdk.documents.history({
    dataContractId: YAPPR_BLOG_CONTRACT_ID,
    documentTypeName: 'blogPost',
    documentId: postId,
  })
  return Array.from(history.entries())
    .map(([timestampMs, document]) => {
      const data = document.toObject() as Record<string, unknown>
      return {
        revision: Number(data.$revision ?? 0),
        at: new Date(Number(timestampMs)),
        title: (data.title as string) || '',
      }
    })
    .sort((a, b) => b.revision - a.revision)
}

/**
 * The "Edited · view history" affordance: shown once a post has been replaced
 * at least once, opening a list of its stored revisions.
 */
export function BlogPostHistory({ postId, revision }: { postId: string; revision?: number }) {
  const [open, setOpen] = useState(false)
  const [revisions, setRevisions] = useState<Revision[] | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(() => {
    setError(false)
    loadRevisions(postId)
      .then(setRevisions)
      .catch((e) => {
        logger.error('BlogPostHistory: failed to load revisions', e)
        setError(true)
      })
  }, [postId])

  useEffect(() => {
    if (open && revisions === null && !error) load()
  }, [open, revisions, error, load])

  if (!revision || revision < 2) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="underline-offset-2 hover:underline"
        style={{ color: 'var(--blog-text)', opacity: 0.6 }}
      >
        Edited · view history
      </button>

      <Modal open={open} onOpenChange={setOpen} className="w-[420px] max-w-[90vw]">
        <ModalTitle>Revision history</ModalTitle>
        {error ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Failed to load revisions.</p>
        ) : revisions === null ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Loading…</p>
        ) : revisions.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No stored revisions.</p>
        ) : (
          <ol className="mt-2 space-y-2">
            {revisions.map((entry) => (
              <li
                key={entry.revision}
                className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-800"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium">Revision {entry.revision}</span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {entry.at.toLocaleString()}
                  </span>
                </div>
                <p className="mt-1 break-words text-gray-600 dark:text-gray-300">{entry.title}</p>
              </li>
            ))}
          </ol>
        )}
      </Modal>
    </>
  )
}
