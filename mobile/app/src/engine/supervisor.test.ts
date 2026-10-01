import { parse, stringify } from '@engine/protocol/codec';
import { PROTOCOL_VERSION, RpcError } from '@engine/protocol/envelope';

import { EngineSupervisor, parseChromeMajor, type SupervisorDeps, type SupervisorOptions } from './supervisor';

/**
 * A stand-in engine on the far side of the WebView transport: it reads what
 * the host injects, answers with real envelopes, and can be told to hang,
 * fail or never answer, so the supervisor's restart and replay rules are
 * exercised end to end without a WebView.
 */
type Handler = (args: unknown[]) => unknown;

class FakeEngine {
  instanceId = `engine-${Math.random().toString(36).slice(2)}`;
  handlers: Record<string, Handler> = {
    'engine.info': () => ({ webAssembly: true, protocol: PROTOCOL_VERSION }),
    'engine.boot': () => ({ webAssembly: true, ready: true }),
    'engine.lifecycle': () => undefined,
    'engine.connectivity': () => undefined,
  };
  /** Requests that have not been answered, by path. */
  held: { id: string; path: string; args: unknown[] }[] = [];
  hold = new Set<string>();
  answerPings = true;
  pings = 0;
  calls: string[] = [];

  constructor(private readonly receive: (message: string) => void) {}

  view = {
    injectJavaScript: (script: string) => {
      const literal = /__yapprEngineReceive\((".*")\); true;$/.exec(script)?.[1];
      if (literal) this.onMessage(JSON.parse(literal) as string);
    },
  };

  hello() {
    this.send({ t: 'evt', v: PROTOCOL_VERSION, event: 'engine.hello', payload: { protocol: PROTOCOL_VERSION, bundleHash: 'abc', instanceId: this.instanceId } });
  }

  hostMessage(message: object) {
    this.receive(JSON.stringify(message));
  }

  private send(envelope: object) {
    queueMicrotask(() => this.receive(stringify(envelope)));
  }

  respond(id: string, path: string, args: unknown[]) {
    try {
      const handler = this.handlers[path];
      if (!handler) throw new RpcError(`Unknown engine method: ${path}`, 'UNKNOWN_METHOD');
      this.send({ t: 'res', v: PROTOCOL_VERSION, id, ok: true, value: handler(args) });
    } catch (error) {
      const { name, message, code } = error as RpcError;
      this.send({ t: 'res', v: PROTOCOL_VERSION, id, ok: false, error: { name, message, code } });
    }
  }

  private onMessage(message: string) {
    const envelope = parse(message) as { t: string; id: string; path: string; args: unknown[] };
    if (envelope.t === 'ping') {
      this.pings += 1;
      if (this.answerPings) this.hello();
      return;
    }
    if (envelope.t !== 'req') return;
    this.calls.push(envelope.path);
    if (this.hold.has(envelope.path)) this.held.push(envelope);
    else this.respond(envelope.id, envelope.path, envelope.args);
  }
}

/** Mounts a FakeEngine for every epoch the supervisor creates. */
function setup(
  options: {
    platform?: 'ios' | 'android';
    configure?: (engine: FakeEngine, epoch: number) => void;
    supervisor?: SupervisorOptions;
  } = {},
) {
  const engines: FakeEngine[] = [];
  const deps: SupervisorDeps<string> = {
    platform: options.platform ?? 'ios',
    prepare: async (epoch) => `load-${epoch}`,
    onStorage: jest.fn(),
    log: jest.fn(),
  };
  const supervisor = new EngineSupervisor(deps, {
    backoffMs: [10, 20, 40],
    pingIntervalMs: 1000,
    pingTimeoutMs: 100,
    ...options.supervisor,
  });
  supervisor.subscribeMount(() => {
    const mount = supervisor.getMount();
    if (!mount) return;
    const engine = new FakeEngine(mount.transport.receive);
    options.configure?.(engine, mount.epoch);
    engines[mount.epoch] = engine;
    mount.transport.attach(engine.view);
  });
  return { supervisor, engines, deps };
}

/** Let promises, microtasks and due timers run. */
async function settle(ms = 0) {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  if (ms > 0) jest.advanceTimersByTime(ms);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function boot(setupResult: ReturnType<typeof setup>, epoch = 1) {
  await settle();
  setupResult.engines[epoch].hello();
  await settle();
}

beforeEach(() => jest.useFakeTimers({ doNotFake: ['queueMicrotask'] }));
afterEach(() => jest.useRealTimers());

describe('EngineSupervisor', () => {
  it('boots to ready, holding calls made before boot until boot has been sent', async () => {
    const s = setup({
      configure: (engine) => {
        engine.answerPings = false; // say hello only when the test says so
        engine.handlers['feed.home'] = () => ({ items: [], cursor: null });
      },
    });
    s.supervisor.start();
    const early = s.supervisor.call('feed.home', [{}]);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'starting', queued: 1 });

    await settle();
    expect(s.supervisor.getStatus().state).toBe('handshaking');
    await boot(s);

    await expect(early).resolves.toEqual({ items: [], cursor: null });
    expect(s.engines[1].calls).toEqual(['engine.info', 'engine.boot', 'feed.home']);
    const status = s.supervisor.getStatus();
    expect(status.state).toBe('ready');
    expect(status.hello?.bundleHash).toBe('abc');
    expect(status.timings).toMatchObject({ prepareMs: expect.any(Number), helloMs: expect.any(Number), bootMs: expect.any(Number) });
    expect(status.timings?.firstCall?.path).toBe('feed.home');
    s.supervisor.stop();
  });

  it('replays an interrupted read once on the restarted engine, and never a write', async () => {
    const s = setup({
      configure: (engine, epoch) => {
        if (epoch === 1) engine.hold.add('feed.home').add('posts.publish');
        else engine.handlers['feed.home'] = () => ({ items: ['replayed'] });
      },
    });
    s.supervisor.start();
    await boot(s);
    const read = s.supervisor.call('feed.home', [{}]);
    const write = s.supervisor.call('posts.publish', [{ text: 'hi' }]);
    const writeOutcome = write.catch((error: unknown) => error);
    await settle();
    expect(s.engines[1].held.map((r) => r.path)).toEqual(['feed.home', 'posts.publish']);

    s.supervisor.crashed('the WebContent process terminated');
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'restarting', restarts: 1 });
    expect(await writeOutcome).toMatchObject({ code: 'ENGINE_RESTARTED' });

    await settle(10); // backoff
    await boot(s, 2);
    await expect(read).resolves.toEqual({ items: ['replayed'] });
    expect(s.engines[2].calls).toEqual(['engine.info', 'engine.boot', 'feed.home']);
    expect(s.engines[2].calls).not.toContain('posts.publish');
    s.supervisor.stop();
  });

  it('rejects a read that is interrupted a second time', async () => {
    const s = setup({ configure: (engine) => engine.hold.add('feed.home') });
    s.supervisor.start();
    await boot(s);
    const read = s.supervisor.call('feed.home', [{}]).catch((error: unknown) => error);
    await settle();
    s.supervisor.crashed('first');
    await settle(10);
    await boot(s, 2);
    expect(s.engines[2].held.map((r) => r.path)).toEqual(['feed.home']);
    s.supervisor.crashed('second');
    expect(await read).toMatchObject({ code: 'ENGINE_RESTARTED' });
    s.supervisor.stop();
  });

  it('backs off, gives up after five crashes in the window, and restart() resets it', async () => {
    const s = setup();
    s.supervisor.start();
    for (let i = 1; i <= 4; i++) {
      await boot(s, i);
      s.supervisor.crashed(`crash ${i}`);
      expect(s.supervisor.getStatus().state).toBe('restarting');
      await settle(40);
    }
    await boot(s, 5);
    s.supervisor.crashed('crash 5');
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'failed', restarts: 5 });
    expect(s.supervisor.getMount()).toBeNull();
    await expect(s.supervisor.call('feed.home', [])).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });

    s.supervisor.restart();
    await boot(s, 6);
    expect(s.supervisor.getStatus().state).toBe('ready');
    s.supervisor.stop();
  });

  it('ignores a crash report from an older epoch', async () => {
    const s = setup();
    s.supervisor.start();
    await boot(s);
    s.supervisor.restart();
    await boot(s, 2);
    s.supervisor.crashed('late report from epoch 1', 1);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'ready', epoch: 2 });
    s.supervisor.stop();
  });

  it('enters Lockdown on iOS when the engine has no WebAssembly', async () => {
    const s = setup({ configure: (engine) => (engine.handlers['engine.info'] = () => ({ webAssembly: false })) });
    s.supervisor.start();
    const queued = s.supervisor.call('feed.home', []);
    await boot(s);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'unsupported', unsupported: 'lockdown' });
    await expect(queued).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });

  it('stops an Android WebView older than the bundle target before the engine runs', async () => {
    const s = setup({ platform: 'android' });
    s.supervisor.start();
    await settle();
    s.engines[1].hostMessage({
      t: 'host-caps',
      userAgent: 'Mozilla/5.0 (Linux; Android 10) Chrome/90.0.4430.91 Mobile Safari/537.36',
      webAssembly: true,
      secureContext: true,
      subtleCrypto: true,
      worker: true,
      decompressionStream: true,
    });
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'unsupported', unsupported: 'webview-outdated' });
    expect(s.supervisor.getStatus().caps?.chromeMajor).toBe(90);
  });

  it('restarts a hung engine after three missed pings', async () => {
    const s = setup({ configure: (engine, epoch) => (engine.answerPings = epoch !== 1) });
    s.supervisor.start();
    await boot(s);
    for (let i = 0; i < 2; i++) await settle(1100);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'ready', epoch: 1 });
    await settle(1100);
    expect(s.supervisor.getStatus()).toMatchObject({ restarts: 1, epoch: 2 });
    expect(s.deps.log).toHaveBeenCalledWith('error', 'host', 'Engine crashed: unresponsive (missed pings)');
    s.supervisor.stop();
  });

  it('degrades when boot fails and finishes booting when the network returns', async () => {
    let online = false;
    const s = setup({
      configure: (engine) => {
        engine.handlers['engine.boot'] = () => {
          if (!online) throw new RpcError('Failed to fetch', 'NETWORK');
          return { webAssembly: true, ready: true };
        };
      },
    });
    s.supervisor.start();
    await boot(s);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'degraded', reason: 'Failed to fetch' });

    online = true;
    await s.supervisor.connectivity(true);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'ready', reason: null });
    expect(s.engines[1].calls).toContain('engine.connectivity');
    s.supervisor.stop();
  });

  it('retries a degraded boot once at a time, however many triggers arrive', async () => {
    let fail = true;
    let boots = 0;
    const s = setup({
      // Pongs need microtasks, which a long fake-timer jump skips: keep pings out of this test.
      supervisor: { pingIntervalMs: 600_000 },
      configure: (engine) => {
        engine.hold.add('engine.boot');
        engine.handlers['engine.boot'] = () => {
          boots += 1;
          if (fail) throw new RpcError('DAPI 504', 'NETWORK');
          return { webAssembly: true, ready: true };
        };
      },
    });
    s.supervisor.start();
    await boot(s);
    const engine = s.engines[1];
    // The first boot fails.
    const first = engine.held.shift()!;
    engine.respond(first.id, first.path, first.args);
    await settle();
    expect(s.supervisor.getStatus().state).toBe('degraded');

    // Foreground returns and connectivity changes pile up; still one retry, then one boot call.
    s.supervisor.setForeground(false);
    s.supervisor.setForeground(true);
    s.supervisor.setForeground(true);
    const online = s.supervisor.connectivity(true);
    const again = s.supervisor.connectivity(true);
    await settle(5000);
    expect(engine.held.filter((r) => r.path === 'engine.boot')).toHaveLength(1);

    fail = false;
    const retry = engine.held.shift()!;
    engine.respond(retry.id, retry.path, retry.args);
    await Promise.all([online, again]);
    await settle();
    expect(boots).toBe(2);
    expect(s.supervisor.getStatus().state).toBe('ready');
    s.supervisor.stop();
  });

  it('pings as well as retrying when a degraded engine returns to the foreground', async () => {
    const s = setup({ configure: (engine) => (engine.handlers['engine.boot'] = () => { throw new RpcError('DAPI 504', 'NETWORK'); }) });
    s.supervisor.start();
    await boot(s);
    expect(s.supervisor.getStatus().state).toBe('degraded');
    const engine = s.engines[1];
    const pingsBefore = engine.pings;
    s.supervisor.setForeground(true);
    await settle();
    expect(engine.pings).toBe(pingsBefore + 1);
    s.supervisor.stop();
  });

  it('drops the oldest queued read beyond the cap, never a write', async () => {
    const deps: SupervisorDeps<string> = { platform: 'ios', prepare: () => new Promise(() => undefined), onStorage: jest.fn(), log: jest.fn() };
    const supervisor = new EngineSupervisor(deps, { queueCap: 2 });
    supervisor.start();
    const write = supervisor.call('posts.publish', []);
    const firstRead = supervisor.call('feed.home', []);
    supervisor.call('feed.home', []).catch(() => undefined);
    await expect(firstRead).rejects.toMatchObject({ code: 'ENGINE_BUSY' });
    expect(supervisor.getStatus().queued).toBe(2);
    supervisor.stop();
    await expect(write).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });

  it('forwards engine events to subscribers across restarts', async () => {
    const s = setup();
    const seen: unknown[] = [];
    s.supervisor.on('write.status', (payload) => seen.push(payload));
    s.supervisor.start();
    await boot(s);
    s.engines[1].hostMessage({ t: 'evt', v: PROTOCOL_VERSION, event: 'write.status', payload: { id: 'w1' } });
    s.supervisor.restart();
    await boot(s, 2);
    s.engines[2].hostMessage({ t: 'evt', v: PROTOCOL_VERSION, event: 'write.status', payload: { id: 'w2' } });
    expect(seen).toEqual([{ id: 'w1' }, { id: 'w2' }]);
    s.supervisor.stop();
  });

  it('reads the Chrome major version from a WebView user agent', () => {
    expect(parseChromeMajor('Mozilla/5.0 (Linux; Android 15; wv) AppleWebKit/537.36 Version/4.0 Chrome/124.0.6367.219 Mobile Safari/537.36')).toBe(124);
    expect(parseChromeMajor('Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15')).toBeNull();
  });
});
