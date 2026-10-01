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

function connect(options: { hello?: boolean } & ClientOptions = {}) {
  const [host, engine] = createInProcessPair()
  const dispatcher = createDispatcher({ api, transport: engine })
  const client = createEngineClient<Api>(host, options)
  if (options.hello !== false) dispatcher.hello({ bundleHash: 'test' })
  return { client, dispatcher, host, engine }
}

const helloMessage = (protocol = PROTOCOL_VERSION, instanceId = 'i1') =>
  stringify({ t: 'evt', v: protocol, event: 'engine.hello', payload: { protocol, bundleHash: 'x', instanceId } })

/** A host transport whose engine side is driven by hand: `deliver` feeds the client, `sent` records requests. */
function manualEngine() {
  const inbound = createHandlerSet()
  const sent: Record<string, unknown>[] = []
  const transport: Transport = { send: message => { sent.push(JSON.parse(message)) }, onMessage: inbound.onMessage }
  return { transport, deliver: inbound.deliver, sent, requests: () => sent.filter(m => m.t === 'req') }
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

  it('completes the handshake for a client created after the engine said hello (ping)', async () => {
    const [host, engine] = createInProcessPair()
    const dispatcher = createDispatcher({ api, transport: engine })
    dispatcher.hello({ bundleHash: 'early' })
    await new Promise(resolve => setTimeout(resolve, 5))
    const late = createEngineClient<Api>(host)
    expect(await late.api.math.add(2, 2)).toBe(4)
  })

  it('refuses an engine that speaks another protocol', async () => {
    const { transport, deliver } = manualEngine()
    const client = createEngineClient<Api>(transport)
    const call = client.api.math.add(1, 1)
    deliver(helloMessage(PROTOCOL_VERSION + 1))
    await expect(call).rejects.toMatchObject({ code: 'PROTOCOL_MISMATCH' })
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

  it('answers an undecodable request with BAD_ENVELOPE', async () => {
    const [host, engine] = createInProcessPair()
    createDispatcher({ api, transport: engine })
    const replies: unknown[] = []
    host.onMessage(message => replies.push(parse(message)))
    host.send(JSON.stringify({ t: 'req', v: PROTOCOL_VERSION, id: '7', path: 'math.add', args: [{ $t: 'nope' }] }))
    host.send(JSON.stringify({ t: 'req', v: PROTOCOL_VERSION, id: '8', path: 42, args: [] }))
    await vi.waitFor(() => expect(replies).toHaveLength(2))
    expect(replies).toEqual([
      expect.objectContaining({ id: '7', ok: false, error: expect.objectContaining({ code: 'BAD_ENVELOPE' }) }),
      expect.objectContaining({ id: '8', ok: false, error: expect.objectContaining({ code: 'BAD_ENVELOPE' }) }),
    ])
  })

  it('rejects a call whose response cannot be decoded with BAD_ENVELOPE', async () => {
    const { transport, deliver, requests } = manualEngine()
    const client = createEngineClient<Api>(transport)
    deliver(helloMessage())
    const call = client.api.math.add(1, 1)
    await vi.waitFor(() => expect(requests()).toHaveLength(1))
    deliver(JSON.stringify({ t: 'res', v: PROTOCOL_VERSION, id: requests()[0].id, ok: true, value: { $t: 'bytes', v: '!!' } }))
    await expect(call).rejects.toMatchObject({ code: 'BAD_ENVELOPE' })
  })

  it('times out a call the engine never answers', async () => {
    const { transport, deliver } = manualEngine()
    const client = createEngineClient<Api>(transport, { timeoutMs: 20 })
    deliver(helloMessage())
    await expect(client.api.math.add(1, 1)).rejects.toMatchObject({ code: 'RPC_TIMEOUT' })
  })

  it('counts the call deadline from the call, not from the hello', async () => {
    const { transport, sent } = manualEngine()
    const client = createEngineClient<Api>(transport, { timeoutMs: 20, helloTimeoutMs: 0 })
    await expect(client.api.math.add(1, 1)).rejects.toMatchObject({ code: 'RPC_TIMEOUT' })
    expect(sent.filter(m => m.t === 'req')).toEqual([])
  })

  it('fails the client when no hello arrives in time', async () => {
    const { transport } = manualEngine()
    const client = createEngineClient<Api>(transport, { timeoutMs: 0, helloTimeoutMs: 20 })
    await expect(client.api.math.add(1, 1)).rejects.toMatchObject({ code: 'ENGINE_HELLO_TIMEOUT' })
    await expect(client.ready).rejects.toMatchObject({ code: 'ENGINE_HELLO_TIMEOUT' })
    await expect(client.api.math.add(1, 1)).rejects.toMatchObject({ code: 'ENGINE_DISCONNECTED' })
  })

  it('rejects pending calls with ENGINE_RESTARTED when a new engine instance says hello', async () => {
    const { transport, deliver, requests } = manualEngine()
    const client = createEngineClient<Api>(transport, { timeoutMs: 0 })
    deliver(helloMessage(PROTOCOL_VERSION, 'first'))
    const call = client.api.math.add(1, 1)
    await vi.waitFor(() => expect(requests()).toHaveLength(1))
    // A ping's answer from the same instance changes nothing...
    deliver(helloMessage(PROTOCOL_VERSION, 'first'))
    await new Promise(resolve => setTimeout(resolve, 5))
    // ...a reloaded engine fails what the old one was handling.
    deliver(helloMessage(PROTOCOL_VERSION, 'second'))
    await expect(call).rejects.toMatchObject({ code: 'ENGINE_RESTARTED' })
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

  it('writes storage through and acknowledges a secure batch once the host wrote it', async () => {
    const [host, engine] = createInProcessPair()
    const acks: number[] = []
    const dispatcher = createDispatcher({ api, transport: engine, onStorageAck: seq => acks.push(seq) })
    const written: string[] = []
    let finishSecureWrite!: () => void
    createEngineClient<Api>(host, {
      onStorage: (batch) => {
        written.push(`${batch.area}#${batch.seq}:${JSON.stringify(batch.ops)}`)
        if (batch.area === 'secure') return new Promise<void>(resolve => { finishSecureWrite = resolve })
      },
    })
    dispatcher.storage({ area: 'local', seq: 1, ops: [['set', 'k', 'v']] })
    dispatcher.storage({ area: 'secure', seq: 2, ops: [['del', 'yappr_secure_pk_x']] })
    await vi.waitFor(() => expect(written).toEqual(['local#1:[["set","k","v"]]', 'secure#2:[["del","yappr_secure_pk_x"]]']))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(acks).toEqual([])
    finishSecureWrite()
    await vi.waitFor(() => expect(acks).toEqual([2]))
  })

  it('never acknowledges a secure batch without a writer, or when the write fails', async () => {
    const [host, engine] = createInProcessPair()
    const acks: number[] = []
    const dispatcher = createDispatcher({ api, transport: engine, onStorageAck: seq => acks.push(seq) })
    createEngineClient<Api>(host)
    const [host2, engine2] = createInProcessPair()
    const dispatcher2 = createDispatcher({ api, transport: engine2, onStorageAck: seq => acks.push(seq) })
    createEngineClient<Api>(host2, { onStorage: () => Promise.reject(new Error('keychain locked')) })
    dispatcher.storage({ area: 'secure', seq: 1, ops: [['set', 'yappr_secure_a', 'x']] })
    dispatcher2.storage({ area: 'secure', seq: 1, ops: [['set', 'yappr_secure_a', 'x']] })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(acks).toEqual([])
  })

  it('makes an engine refuse, unrun, a call stamped for a previous instance', async () => {
    const [host, engine] = createInProcessPair()
    const ran = vi.fn(async () => 'ran')
    createDispatcher({ api: { ran }, transport: engine })
    const replies: unknown[] = []
    host.onMessage(message => replies.push(parse(message)))
    host.send(stringify({ t: 'req', v: PROTOCOL_VERSION, id: '1', path: 'ran', args: [], instance: 'an-older-engine' }))
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0]).toMatchObject({ ok: false, error: { code: 'ENGINE_RESTARTED' } })
    expect(ran).not.toHaveBeenCalled()
  })

  it('stamps calls with the instance it last heard from', async () => {
    const { transport, deliver, requests } = manualEngine()
    const client = createEngineClient<Api>(transport)
    deliver(helloMessage(PROTOCOL_VERSION, 'engine-a'))
    client.api.math.add(1, 1).catch(() => undefined)
    await vi.waitFor(() => expect(requests()).toHaveLength(1))
    expect(requests()[0].instance).toBe('engine-a')
  })

  it('ignores a malformed hello and isolates a throwing event listener', async () => {
    const { transport, deliver } = manualEngine()
    const client = createEngineClient<Api>(transport, { helloTimeoutMs: 0 })
    const seen: unknown[] = []
    client.on('engine.hello', () => { throw new Error('listener bug') })
    client.on('engine.hello', payload => seen.push(payload))
    expect(() => deliver(stringify({ t: 'evt', v: PROTOCOL_VERSION, event: 'engine.hello', payload: null }))).not.toThrow()
    deliver(helloMessage())
    await expect(client.ready).resolves.toMatchObject({ instanceId: 'i1' })
    expect(seen).toHaveLength(1)
  })

  it('does not turn awaiting, coercion or inspection of the proxy into calls', async () => {
    const { client, host } = connect()
    await client.ready
    const sent = vi.spyOn(host, 'send')
    const feed = (client.api as unknown as { feed: object }).feed
    expect(await (client.api as unknown as Promise<unknown>)).toBe(client.api)
    expect(() => `${String(feed)}`).toThrow()
    for (const key of ['then', 'toString', 'valueOf', 'toJSON', 'constructor', '$$typeof']) {
      expect((feed as Record<string, unknown>)[key], key).toBeUndefined()
    }
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
