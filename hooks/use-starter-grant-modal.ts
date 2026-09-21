import { createModalStore } from '@/lib/modal-store'

/** The one-time "claim your starter YAPP" prompt. */
export const useStarterGrantModal = createModalStore<Record<never, never>>({})
