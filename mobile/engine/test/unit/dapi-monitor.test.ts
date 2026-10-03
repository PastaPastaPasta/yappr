import { describe, expect, it, vi } from 'vitest'
import { createDapiMonitor, dapiOrigin } from '../../src/dapi-monitor'

const NODE_A = 'https://68.67.122.1:1443'
const NODE_B = 'https://68.67.122.2:1443'
const call = (origin: string) => `${origin}/org.dash.platform.dapi.v0.Platform/getStatus`

describe('dapiOrigin', () => {
  it('is the origin of gRPC-web DAPI requests, either slash form, and null otherwise', () => {
    expect(dapiOrigin(call(NODE_A))).toBe(NODE_A)
    expect(dapiOrigin(`${NODE_A}//org.dash.platform.dapi.v0.Platform/getDocuments`)).toBe(NODE_A)
    expect(dapiOrigin('https://quorums.testnet.networks.dash.org/quorums')).toBeNull()
    expect(dapiOrigin('not a url')).toBeNull()
  })
})

describe('the DAPI monitor (Engine diagnostics, SET-08)', () => {
  it('counts each endpoint\'s answers and failures, passes everything through, and leaves other requests alone', async () => {
    let clock = 1_000
    const monitor = createDapiMonitor(() => clock)
    const answers = new Map<string, Response | Error>([
      [call(NODE_A), new Response('ok', { status: 200 })],
      [call(NODE_B), new Response('', { status: 200, headers: { 'grpc-status': '14' } })],
    ])
    const original = vi.fn(async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input)
      const answer = answers.get(url) ?? new Response('other', { status: 200 })
      if (answer instanceof Error) throw answer
      return answer
    })
    const fetch = monitor.wrap(original as unknown as typeof globalThis.fetch)

    expect(await (await fetch(call(NODE_A))).text()).toBe('ok')
    clock = 2_000
    await fetch(call(NODE_B))
    await fetch('https://example.com/image.png')
    answers.set(call(NODE_A), new TypeError('Failed to fetch'))
    clock = 3_000
    await expect(fetch(new Request(call(NODE_A), { method: 'POST', body: 'x' }))).rejects.toThrow('Failed to fetch')

    expect(original).toHaveBeenCalledTimes(4)
    expect(monitor.status(5)).toEqual({
      configured: 5,
      lastOkAt: 1_000,
      endpoints: [
        { origin: NODE_A, requests: 2, failures: 1, lastOkAt: 1_000, lastErrorAt: 3_000 },
        { origin: NODE_B, requests: 1, failures: 1, lastOkAt: null, lastErrorAt: 2_000 },
      ],
    })
  })

  it('reports no last answer before any request', () => {
    expect(createDapiMonitor().status(0)).toEqual({ configured: 0, endpoints: [], lastOkAt: null })
  })
})
