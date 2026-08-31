import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { scopedKey } from '@/lib/storage-scope'
import type { InspectorFacade, QueryRecord } from './types'

const MAX_ENTRIES = 300

export type FacadeFilter = InspectorFacade | 'all' | 'writes'

interface QueryInspectorState {
  /** Master switch, persisted. Everything else resets on reload. */
  enabled: boolean
  setEnabled: (enabled: boolean) => void
  panelOpen: boolean
  setPanelOpen: (open: boolean) => void
  paused: boolean
  setPaused: (paused: boolean) => void
  selectedId: string | null
  setSelectedId: (id: string | null) => void
  facadeFilter: FacadeFilter
  setFacadeFilter: (filter: FacadeFilter) => void
  entries: QueryRecord[]
  totalCaptured: number
  provenCaptured: number
  latestHeight: string | null
  latestEpoch: number | null
  lastMethod: string | null
  record: (entry: QueryRecord) => void
  clear: () => void
}

export const useQueryInspectorStore = create<QueryInspectorState>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
      panelOpen: false,
      setPanelOpen: (panelOpen) => set({ panelOpen }),
      paused: false,
      setPaused: (paused) => set({ paused }),
      selectedId: null,
      setSelectedId: (selectedId) => set({ selectedId }),
      facadeFilter: 'all',
      setFacadeFilter: (facadeFilter) => set({ facadeFilter }),
      entries: [],
      totalCaptured: 0,
      provenCaptured: 0,
      latestHeight: null,
      latestEpoch: null,
      lastMethod: null,
      record: (entry) =>
        set((state) => ({
          entries: [entry, ...state.entries].slice(0, MAX_ENTRIES),
          totalCaptured: state.totalCaptured + 1,
          provenCaptured: state.provenCaptured + (entry.proofStatus === 'proven' ? 1 : 0),
          latestHeight: entry.metadata?.height ?? state.latestHeight,
          latestEpoch: entry.metadata?.epoch ?? state.latestEpoch,
          lastMethod: entry.method,
        })),
      clear: () =>
        set({
          entries: [],
          totalCaptured: 0,
          provenCaptured: 0,
          latestHeight: null,
          latestEpoch: null,
          lastMethod: null,
          selectedId: null,
        }),
    }),
    {
      name: scopedKey('yappr-query-inspector'),
      partialize: (state) => ({ enabled: state.enabled }),
    }
  )
)

/**
 * Non-React accessors for the capture layer, which runs inside SDK calls and
 * must stay off the React render path.
 */
export function inspectorIsCapturing(): boolean {
  const state = useQueryInspectorStore.getState()
  return state.enabled && !state.paused
}

export function recordQuery(entry: QueryRecord): void {
  useQueryInspectorStore.getState().record(entry)
}
