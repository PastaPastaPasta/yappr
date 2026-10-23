import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { readSupersedes, shownMarks, type MarksWithRestriction, type RecordedMarks } from '@/lib/moderation-view'

interface RecentModeration {
  /** By document id: the last hide or unhide this tab made, and when. */
  marks: Record<string, RecordedMarks>
  /**
   * `proved` false when the network did not confirm it in time; `at` the
   * change's block time (`$moderatedAt`) when known, so a later change by
   * anyone orders after it exactly; this tab's clock otherwise.
   */
  record: (documentId: string, marks: MarksWithRestriction | null, proved?: boolean, at?: number) => void
  /** Drops `documentId`'s record once a read superseded it, unless a newer one replaced it since. */
  retire: (documentId: string, recorded: RecordedMarks) => void
}

/**
 * The hides and unhides this tab made (one at a time from a post's menu, or
 * in bulk), for every post card on screen: a card's read still holds the
 * marks from before. The last one recorded wins until a read supersedes it
 * ({@link shownMarks}); then it is dropped for good.
 */
export const useRecentModeration = create<RecentModeration>((set) => ({
  marks: {},
  record: (documentId, marks, proved = true, at = Date.now()) =>
    set((state) => ({ marks: { ...state.marks, [documentId]: { marks, at, proved } } })),
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
 * back. An unproved change gives way to the first read other than the one on
 * screen when it was recorded.
 */
export function useShownModeration(documentId: string, read: MarksWithRestriction | undefined): MarksWithRestriction | undefined {
  const recorded = useRecentModeration((state) => state.marks[documentId])
  const retire = useRecentModeration((state) => state.retire)
  const basis = useRef<{ recorded: RecordedMarks | undefined; read: MarksWithRestriction | undefined }>({ recorded, read })
  if (basis.current.recorded !== recorded) basis.current = { recorded, read }
  const readIsNew = read !== basis.current.read
  const superseded = recorded !== undefined && readSupersedes(read, recorded, readIsNew)
  useEffect(() => {
    if (superseded && recorded) retire(documentId, recorded)
  }, [superseded, recorded, retire, documentId])
  return shownMarks(read, recorded, readIsNew)
}
