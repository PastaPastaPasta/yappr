import { describe, expect, it, vi } from 'vitest'

// The settings store persists through localStorage, which the node test
// environment lacks. It must exist before the store module is evaluated.
vi.hoisted(() => {
  const items = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => { items.set(key, value) },
      removeItem: (key: string) => { items.delete(key) },
    },
    configurable: true,
  })
})
import { useAppStore } from './store'

describe('app store actions', () => {
  // A component that selects only these (PostCard) re-renders when the
  // selected value changes, so a draft edit must leave them untouched.
  it('keep the same identity while a draft changes', () => {
    const selected = () => [
      useAppStore.getState().setReplyingTo,
      useAppStore.getState().setComposeOpen,
      useAppStore.getState().setQuotingPost,
    ]
    const before = selected()
    const { threadPosts, updateThreadPost } = useAppStore.getState()
    updateThreadPost(threadPosts[0].id, 'a draft, one keystroke at a time')
    const after = selected()
    expect(useAppStore.getState().threadPosts[0].content).toBe('a draft, one keystroke at a time')
    after.forEach((action, i) => expect(action).toBe(before[i]))
  })
})
