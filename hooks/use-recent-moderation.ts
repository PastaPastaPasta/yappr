import { useRef } from 'react'
import { create } from 'zustand'
import { shownMarks, type MarksWithRestriction, type RecordedMarks } from '@/lib/moderation-view'

interface RecentModeration {
  /** By document id: the last hide or unhide this tab made, and when. */
  marks: Record<string, RecordedMarks>
  /** `proved` false when the network did not confirm it in time. */
  record: (documentId: string, marks: MarksWithRestriction | null, proved?: boolean) => void
}

/**
 * The hides and unhides this tab made (one at a time from a post's menu, or
 * in bulk), for every post card on screen: a card's read still holds the
 * marks from before. The last one recorded wins until a read supersedes it
 * ({@link shownMarks}).
 */
export const useRecentModeration = create<RecentModeration>((set) => ({
  marks: {},
  record: (documentId, marks, proved = true) =>
    set((state) => ({ marks: { ...state.marks, [documentId]: { marks, at: Date.now(), proved } } })),
}))

/**
 * The marks to show for `documentId` given its `read`: the recorded change
 * unless the read supersedes it. An unproved change gives way to the first
 * read other than the one on screen when it was recorded.
 */
export function useShownModeration(documentId: string, read: MarksWithRestriction | undefined): MarksWithRestriction | undefined {
  const recorded = useRecentModeration((state) => state.marks[documentId])
  const basis = useRef<{ recorded: RecordedMarks | undefined; read: MarksWithRestriction | undefined }>({ recorded, read })
  if (basis.current.recorded !== recorded) basis.current = { recorded, read }
  return shownMarks(read, recorded, read !== basis.current.read)
}
