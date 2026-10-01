import { describe, expect, it, vi } from 'vitest'
import { createDispatcher, resolveMethod } from '../../src/rpc/dispatcher'
import { createEngineClient, type ClientOptions } from '../../src/rpc/client'
import { createHandlerSet, createInProcessPair, createWebViewTransport, type Transport } from '../../src/rpc/transport'
import { PROTOCOL_VERSION } from '../../src/protocol/envelope'
import { parse, stringify } from '../../src/protocol/codec'

const api = {
  math: {
    async add(a: number, b: number) { return a + b },
    async big(n: bigint) { return { doubled: n * 2n, at: new Date(0), bytes: new Uint8Array([n > 0n ? 1 : 0]) } },
  },
  async fail() { throw Object.assign(new Error('Identity not found'), { code: 'NOT_FOUND' }) },
  async slow(ms: number) { await new Promise(resolve => setTimeout(resolve, ms)); return ms },
  async cyclic() { const o: Record<string, unknown> = {}; o.o = o; return o },
}
type Api = typeof api

function connect(options: { hello?: boolean; onLog?: ClientOptions['onLog'] } = {}) {
  const [host, engine] = createInProcessPair()
  const dispatcher = createDispatcher({ api, transport: engine })
  const client = createEngineClient<Api>(host, { onLog: options.onLog })
  if (options.hello !== false) dispatcher.hello({ bundleHash: 'test' })
  return { client, dispatcher, host, engine }
}

describe('resolveMethod', () => {
  it('walks own properties only', () => {
    expect(resolveMethod(api, 'math.add')).toBe(api.math.add)
    for (const path of ['math', 'math.nope', '__proto__.toString', 'constructor', 'math.add.call', 'toString']) {
      expect(() => resolveMethod(api, path), path).toThrow(/Unknown engine method/)
    }
  })
})

describe('dispatcher + client', () => {
  it('calls nested methods through the typed proxy', async () => {
    const { client } = connect()
    expect(await client.api.math.add(2, 3)).toBe(5)
  })

  it('carries codec types both ways', async () => {
    const { client } = connect()
    const result = await client.api.math.big(21n)
    expect(result.doubled).toBe(42n)
    expect(result.at).toEqual(new Date(0))
    expect(Array.from(result.bytes)).toEqual([1])
  })

  it('rejects with the engine error, message verbatim and code kept', async () => {
    const { client } = connect()
    await expect(client.api.fail()).rejects.toMatchObject({ message: 'Identity not found', code: 'NOT_FOUND' })
  })

  it('reports unknown methods', async () => {
    const { client } = connect()
    const loose = client.api as unknown as { nope: { deeper(): Promise<unknown> } }
    await expect(loose.nope.deeper()).rejects.toMatchObject({ code: 'UNKNOWN_METHOD' })
  })

  it('settles a call whose result cannot be encoded', async () => {
    const { client } = connect()
    await expect(client.api.cyclic()).rejects.toThrow(/cycle/)
  })

  it('matches out-of-order responses to their calls', async () => {
    const { client } = connect()
    const results = await Promise.all([client.api.slow(30), client.api.slow(1), client.api.math.add(1, 1)])
    expect(results).toEqual([30, 1, 2])
  })

  it('queues calls until engine.hello arrives', async () => {
    const { client, dispatcher } = connect({ hello: false })
    let settled = false
    const call = client.api.math.add(1, 2).then((value) => { settled = true; return value })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    dispatcher.hello({ bundleHash: 'late' })
    expect(await call).toBe(3)
    expect((await client.ready).bundleHash).toBe('late')
  })

  it('refuses an engine that speaks another protocol', async () => {
    const [host, engine] = createInProcessPair()
    const client = createEngineClient<Api>(host)
    engine.send(stringify({ t: 'evt', v: PROTOCOL_VERSION + 1, event: 'engine.hello', payload: { protocol: PROTOCOL_VERSION + 1, bundleHash: 'x' } }))
    await expect(client.api.math.add(1, 1)).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
  })

  it('makes the engine refuse requests from another protocol version', async () => {
    const [host, engine] = createInProcessPair()
    createDispatcher({ api, transport: engine })
    const replies: unknown[] = []
    host.onMessage(message => replies.push(parse(message)))
    host.send(stringify({ t: 'req', v: PROTOCOL_VERSION + 1, id: '1', path: 'math.add', args: [1, 2] }))
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0]).toMatchObject({ t: 'res', ok: false, error: { code: 'PROTOCOL_MISMATCH' } })
  })

  it('times out a call the engine never answers', async () => {
    const inbound = createHandlerSet()
    const silent: Transport = { send: () => undefined, onMessage: inbound.onMessage }
    const client = createEngineClient<Api>(silent, { timeoutMs: 20 })
    inbound.deliver(stringify({ t: 'evt', v: PROTOCOL_VERSION, event: 'engine.hello', payload: { protocol: PROTOCOL_VERSION, bundleHash: 'x' } }))
    await expect(client.api.math.add(1, 1)).rejects.toMatchObject({ code: 'RPC_TIMEOUT' })
  })

  it('rejects pending calls and refuses new ones after close', async () => {
    const { client } = connect()
    const pending = client.api.slow(1_000)
    client.close('engine process terminated')
    await expect(pending).rejects.toMatchObject({ code: 'ENGINE_DISCONNECTED', message: 'engine process terminated' })
    await expect(client.api.math.add(1, 1)).rejects.toMatchObject({ code: 'ENGINE_DISCONNECTED' })
  })

  it('delivers events and log lines', async () => {
    const logs: string[] = []
    const { client, dispatcher } = connect({ onLog: (level, message) => logs.push(`${level}:${message}`) })
    const events: unknown[] = []
    const off = client.on('storage.change', payload => events.push(payload))
    dispatcher.emit('storage.change', { area: 'local', key: 'k', value: 'v' })
    dispatcher.log('warn', 'quorum refresh')
    await vi.waitFor(() => expect(events).toEqual([{ area: 'local', key: 'k', value: 'v' }]))
    await vi.waitFor(() => expect(logs).toEqual(['warn:quorum refresh']))
    off()
    dispatcher.emit('storage.change', { area: 'local', key: 'k', value: null })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(events).toHaveLength(1)
  })

  it('is not thenable, so awaiting the proxy does not send a call', async () => {
    const { client, host } = connect()
    const sent = vi.spyOn(host, 'send')
    expect(await (client.api as unknown as Promise<unknown>)).toBe(client.api)
    expect(sent).not.toHaveBeenCalled()
  })
})

describe('WebView transport', () => {
  it('posts through ReactNativeWebView and receives through __yapprEngineReceive', () => {
    const posted: string[] = []
    const fakeWindow = { ReactNativeWebView: { postMessage: (m: string) => posted.push(m) } } as unknown as Window
    const transport = createWebViewTransport(fakeWindow)
    const received: string[] = []
    transport.onMessage(m => received.push(m))
    transport.send('out')
    fakeWindow.__yapprEngineReceive?.('in')
    expect(posted).toEqual(['out'])
    expect(received).toEqual(['in'])
  })

  it('throws when the bridge is missing', () => {
    expect(() => createWebViewTransport({} as Window).send('x')).toThrow(/ReactNativeWebView/)
  })
})
