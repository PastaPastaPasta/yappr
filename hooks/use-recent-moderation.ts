import { useEffect } from 'react'
import { create } from 'zustand'
import { readSupersedes, shownMarks, type MarksWithRestriction, type RecordedMarks } from '@/lib/moderation-view'

interface RecordOptions {
  /** False when the network did not confirm it in time. */
  proved?: boolean
  /** The change's block time (`$moderatedAt`) when known, so a later change by anyone orders after it exactly; this tab's clock otherwise. */
  at?: number
  /** For an unproved change: the read on screen when it was made, which only another read supersedes. */
  basis?: MarksWithRestriction
}

interface RecentModeration {
  /** By document id: the last hide or unhide this tab made, and when. */
  marks: Record<string, RecordedMarks>
  record: (documentId: string, marks: MarksWithRestriction | null, options?: RecordOptions) => void
  /** Drops `documentId`'s record once a read superseded it, unless a newer one replaced it since. */
  retire: (documentId: string, recorded: RecordedMarks) => void
}

/**
 * The hides and unhides this tab made (one at a time from a post's menu, or
 * in bulk), for every post card on screen: a card's read still holds the
 * marks from before. The last one recorded wins until a read supersedes it
 * ({@link readSupersedes}); then it is dropped for good.
 */
export const useRecentModeration = create<RecentModeration>((set) => ({
  marks: {},
  record: (documentId, marks, { proved = true, at = Date.now(), basis } = {}) =>
    set((state) => ({ marks: { ...state.marks, [documentId]: { marks, at, proved, ...(proved ? {} : { basis }) } } })),
  retire: (documentId, recorded) =>
    set((state) => {
      if (state.marks[documentId] !== recorded) return state
      const marks = { ...state.marks }
      delete marks[documentId]
      return { marks }
    }),
}))

/**
 * The marks to show for `documentId` given its `read`: the recorded change
 * unless the read supersedes it, which retires the record so it never comes
 * back. An unproved change gives way to any read but the one it was made over.
 */
export function useShownModeration(documentId: string, read: MarksWithRestriction | undefined): MarksWithRestriction | undefined {
  const recorded = useRecentModeration((state) => state.marks[documentId])
  const retire = useRecentModeration((state) => state.retire)
  const readIsNew = recorded !== undefined && read !== recorded.basis
  const superseded = recorded !== undefined && readSupersedes(read, recorded, readIsNew)
  useEffect(() => {
    if (superseded && recorded) retire(documentId, recorded)
  }, [superseded, recorded, retire, documentId])
  return shownMarks(read, recorded, readIsNew)
}
