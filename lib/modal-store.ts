import { create, type StoreApi, type UseBoundStore } from 'zustand'

interface ModalBase<A extends unknown[]> {
  isOpen: boolean
  open: (...args: A) => void
  /** Hide the modal and drop its payload. */
  close: () => void
}

/**
 * The payload and the extra actions may not reuse a base field name: the
 * spread in the factory would win silently, so make it a compile error.
 */
type WithoutBaseKeys<T> = keyof T & keyof ModalBase<never> extends never ? T : never

type ModalStore<P extends object, A extends unknown[], X extends object> = P & X & ModalBase<A>

/**
 * A global zustand store for a singleton modal: `isOpen`, the payload it was
 * opened with, `open(...)` and a `close()` that restores `closed`.
 *
 * @param closed   The payload while the modal is shut; `open` and `close` both
 *                 start from it, so nothing leaks between two openings. List
 *                 optional keys with an explicit `undefined`, or `close()`
 *                 will not clear them.
 * @param toPayload Maps `open`'s arguments onto the payload. Defaults to no
 *                 arguments, which also makes `open` safe as a bare `onClick`.
 * @param extend   Extra actions, given the store's `set`.
 */
export function createModalStore<P extends object, A extends unknown[] = [], X extends object = Record<never, never>>(
  closed: WithoutBaseKeys<P>,
  toPayload: (...args: A) => Partial<P> = () => ({}),
  extend?: (set: StoreApi<ModalStore<P, A, X>>['setState']) => WithoutBaseKeys<X>
): UseBoundStore<StoreApi<ModalStore<P, A, X>>> {
  type S = ModalStore<P, A, X>
  return create<S>(
    (set) =>
      ({
        ...closed,
        isOpen: false,
        open: (...args: A) => set({ ...closed, ...toPayload(...args), isOpen: true }),
        close: () => set({ ...closed, isOpen: false }),
        ...extend?.(set),
      }) as unknown as S
  )
}
