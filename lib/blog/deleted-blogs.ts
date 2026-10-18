import { create } from 'zustand'

/** Confirmed deletions outlive mounted lists and lagging reads in this page session. */
export const useDeletedBlogs = create<{ ids: ReadonlySet<string>; mark: (id: string) => void }>((set) => ({
  ids: new Set(),
  mark: (id) => set((state) => ({ ids: new Set([...state.ids, id]) })),
}))
