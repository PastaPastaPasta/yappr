import { create, type StoreApi, type UseBoundStore } from 'zustand'

export type ModalStore<P extends object, A extends unknown[], X extends object> = P &
  X & {
    isOpen: boolean
    open: (...args: A) => void
    /** Hide the modal and drop its payload. */
    close: () => void
  }

type Setter<S> = StoreApi<S>['setState']
type Getter<S> = StoreApi<S>['getState']

/**
 * A global zustand store for a singleton modal: `isOpen`, the payload it was
 * opened with, `open(...)` and a `close()` that restores `closed`.
 *
 * @param closed   The payload while the modal is shut; `open` and `close` both
 *                 start from it, so nothing leaks between two openings.
 * @param toPayload Maps `open`'s arguments onto the payload. Defaults to no
 *                 arguments, which also makes `open` safe as a bare `onClick`.
 * @param extend   Extra actions, given the store's `set`/`get`.
 */
export function createModalStore<P extends object, A extends unknown[] = [], X extends object = Record<never, never>>(
  closed: P,
  toPayload: (...args: A) => Partial<P> = () => ({}),
  extend?: (set: Setter<ModalStore<P, A, X>>, get: Getter<ModalStore<P, A, X>>) => X
): UseBoundStore<StoreApi<ModalStore<P, A, X>>> {
  type S = ModalStore<P, A, X>
  return create<S>()((set, get) => {
    const base = {
      ...closed,
      isOpen: false,
      open: (...args: A) => set({ ...closed, ...toPayload(...args), isOpen: true } as Partial<S>),
      close: () => set({ ...closed, isOpen: false } as Partial<S>),
    }
    return { ...base, ...(extend ? extend(set, get) : {}) } as S
  })
}
