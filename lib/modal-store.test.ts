import { describe, expect, it } from 'vitest'
import { createModalStore } from './modal-store'

describe('createModalStore', () => {
  it('starts closed with the closed payload', () => {
    const store = createModalStore({ reason: null as string | null })
    expect(store.getState().isOpen).toBe(false)
    expect(store.getState().reason).toBeNull()
  })

  it('open() with no mapper only flips isOpen', () => {
    const store = createModalStore({})
    store.getState().open()
    expect(store.getState().isOpen).toBe(true)
  })

  it('open() maps its arguments onto the payload and close() restores the closed payload', () => {
    const store = createModalStore<{ id: string | null; extra: number }, [id: string]>(
      { id: null, extra: 0 },
      (id) => ({ id })
    )
    store.getState().open('abc')
    expect(store.getState()).toMatchObject({ isOpen: true, id: 'abc', extra: 0 })
    store.getState().close()
    expect(store.getState()).toMatchObject({ isOpen: false, id: null, extra: 0 })
  })

  it('a second open() does not inherit state from the first', () => {
    const store = createModalStore<{ a?: string; b?: string }, [a?: string, b?: string]>({}, (a, b) => ({ a, b }))
    store.getState().open('x', 'y')
    store.getState().open('z')
    expect(store.getState()).toMatchObject({ isOpen: true, a: 'z', b: undefined })
  })

  it('extend() adds actions that see the same state', () => {
    const store = createModalStore<{ busy: boolean }, [], { setBusy: (busy: boolean) => void }>(
      { busy: false },
      () => ({}),
      (set) => ({ setBusy: (busy) => set({ busy }) })
    )
    store.getState().open()
    store.getState().setBusy(true)
    expect(store.getState()).toMatchObject({ isOpen: true, busy: true })
    store.getState().close()
    expect(store.getState().busy).toBe(false)
  })
})
