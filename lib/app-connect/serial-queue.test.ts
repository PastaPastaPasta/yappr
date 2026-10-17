import { describe, expect, it } from 'vitest'
import { serialQueue } from './serial-queue'

describe('serialQueue', () => {
  it('starts a task only once the previous one has settled, failed or not', async () => {
    const run = serialQueue()
    const order: string[] = []
    let releaseFirst: () => void = () => undefined
    const first = run(() => new Promise<void>((resolve) => { releaseFirst = resolve }).then(() => { order.push('first'); throw new Error('A lost') }))
    const second = run(async () => { order.push('second') })

    await Promise.resolve()
    expect(order).toEqual([])
    releaseFirst()
    await expect(first).rejects.toThrow('A lost')
    await second
    expect(order).toEqual(['first', 'second'])
  })
})
