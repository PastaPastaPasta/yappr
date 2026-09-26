import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type EffectCallback } from 'react'
import { renderToString } from 'react-dom/server'
import type { BlockProvenance } from './block-service'

const mocks = vi.hoisted(() => ({
  state: [] as unknown[], slot: 0, refs: [] as { current: unknown }[], refSlot: 0,
  effect: null as EffectCallback | null, cleanup: null as (() => void) | null,
  getBlockProvenance: vi.fn(), unblockUser: vi.fn(), cacheSet: vi.fn(),
  toastSuccess: vi.fn(), toastError: vi.fn(),
}))
// Run the real hook outside a renderer: useState/useRef keep slots across
// renders (keyed by call order, like React's hook slots), and the one effect
// is committed by hand so a target change can race an in-flight resolve.
// This targets hooks/use-block.ts but lives beside block-service so vitest's
// lib/**/*.test.ts include picks it up.
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useCallback: <T>(fn: T) => fn,
  useEffect: (effect: EffectCallback) => { mocks.effect = effect },
  useState: (initial: unknown) => {
    const slot = mocks.slot++
    if (!(slot in mocks.state)) mocks.state[slot] = initial
    const set = (update: unknown) => {
      mocks.state[slot] = typeof update === 'function' ? update(mocks.state[slot]) : update
    }
    return [mocks.state[slot], set]
  },
  useRef: (initial: unknown) => {
    const slot = mocks.refSlot++
    mocks.refs[slot] ??= { current: initial }
    return mocks.refs[slot]
  },
}))
vi.mock('react-hot-toast', () => ({ default: { success: mocks.toastSuccess, error: mocks.toastError } }))
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ user: { identityId: 'viewer' } }) }))
vi.mock('@/hooks/use-toggle-relation', () => ({ useToggleRelation: vi.fn() }))
vi.mock('@/lib/caches/user-status-cache', () => ({ blockStatusCache: { set: mocks.cacheSet } }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/services/block-service', () => ({
  blockService: { getBlockProvenance: mocks.getBlockProvenance, unblockUser: mocks.unblockUser },
}))
import { useBlockProvenance } from '@/hooks/use-block'

function render(targetUserId: string) {
  let result!: ReturnType<typeof useBlockProvenance>
  function Probe() { result = useBlockProvenance(targetUserId); return null }
  mocks.slot = 0
  mocks.refSlot = 0
  renderToString(createElement(Probe))
  return result
}

/** Commit the effect from the latest render, cleaning up the previous one. */
function commit() {
  mocks.cleanup?.()
  const cleanup = mocks.effect?.()
  mocks.cleanup = typeof cleanup === 'function' ? cleanup : null
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

const ownAndInherited: BlockProvenance = { isBlocked: true, isOwnBlock: true, inheritedFrom: 'list-owner' }
const inheritedOnly: BlockProvenance = { isBlocked: true, isOwnBlock: false, inheritedFrom: 'list-owner' }
const notBlocked: BlockProvenance = { isBlocked: false, isOwnBlock: false, inheritedFrom: null }

beforeEach(() => {
  mocks.state = []
  mocks.refs = []
  mocks.effect = null
  mocks.cleanup = null
  for (const fn of [mocks.getBlockProvenance, mocks.unblockUser, mocks.cacheSet, mocks.toastSuccess, mocks.toastError]) {
    fn.mockReset()
  }
  mocks.unblockUser.mockResolvedValue({ success: true })
})

describe('useBlockProvenance', () => {
  it('keeps an inherited block after removing the own block and says why', async () => {
    mocks.getBlockProvenance.mockResolvedValueOnce(ownAndInherited).mockResolvedValueOnce(inheritedOnly)
    render('target')
    commit()
    await flush()
    const loaded = render('target')
    expect(loaded).toMatchObject({ ...ownAndInherited, isLoading: false })

    await loaded.unblock()
    expect(mocks.unblockUser).toHaveBeenCalledWith('viewer', 'target')
    expect(render('target')).toMatchObject({ ...inheritedOnly, isLoading: false })
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Your block was removed, but a block list you follow still blocks this user')
    expect(mocks.cacheSet).toHaveBeenLastCalledWith('viewer', 'target', true)
  })

  it('falls back to the known inherited block when the re-check after unblock fails', async () => {
    mocks.getBlockProvenance.mockResolvedValueOnce(ownAndInherited).mockRejectedValueOnce(new Error('StaleNode'))
    render('target')
    commit()
    await flush()

    await render('target').unblock()
    expect(render('target')).toMatchObject({ ...inheritedOnly, isLoading: false })
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Your block was removed, but a block list you follow still blocks this user')
  })

  it('reports a plain unblock when only the own block applied', async () => {
    mocks.getBlockProvenance
      .mockResolvedValueOnce({ isBlocked: true, isOwnBlock: true, inheritedFrom: null })
      .mockResolvedValueOnce(notBlocked)
    render('target')
    commit()
    await flush()

    await render('target').unblock()
    expect(render('target')).toMatchObject({ ...notBlocked, isLoading: false })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('User unblocked')
  })

  it('ignores a slow resolve for a previous target', async () => {
    const first = deferred<BlockProvenance>()
    mocks.getBlockProvenance.mockReturnValueOnce(first.promise).mockResolvedValueOnce(notBlocked)
    render('first')
    commit()
    await flush()

    // The target changes before the first target's check returns.
    render('second')
    commit()
    await flush()
    expect(render('second')).toMatchObject({ ...notBlocked, isLoading: false })

    first.resolve(ownAndInherited)
    await flush()
    expect(render('second')).toMatchObject({ ...notBlocked, isLoading: false })
    expect(mocks.cacheSet).not.toHaveBeenCalledWith('viewer', 'first', true)
  })
})
