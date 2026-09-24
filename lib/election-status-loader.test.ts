import { describe, expect, it, vi } from 'vitest'
import { createElectionStatusLoader } from './election-status-loader'

describe('election status loader', () => {
  it('shares one in-flight read between any number of concurrent loads (a re-render storm)', async () => {
    let resolve: (value: string) => void = () => {}
    const read = vi.fn(() => new Promise<string>((r) => { resolve = r }))
    const loader = createElectionStatusLoader(read)
    const calls = Array.from({ length: 50 }, () => loader.load())
    resolve('status')
    expect(await Promise.all(calls)).toEqual(Array(50).fill('status'))
    expect(read).toHaveBeenCalledTimes(1)
    expect(loader.started).toBe(1)
  })

  it('reads again only when asked after the previous read settled, success or failure', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('ok')
    const loader = createElectionStatusLoader(read)
    await expect(loader.load()).rejects.toThrow('offline')
    await expect(loader.load()).resolves.toBe('ok')
    expect(read).toHaveBeenCalledTimes(2)
  })
})
