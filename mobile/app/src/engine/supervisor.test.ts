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
    error: jest.fn(),
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
  it('boots to ready, holding calls made before boot until boot has finished', async () => {
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

  it('backs off, gives up after three restarts in a run (NET-04), and restart() resets the budget', async () => {
    const s = setup();
    s.supervisor.start();
    for (let i = 1; i <= 3; i++) {
      await boot(s, i);
      s.supervisor.crashed(`crash ${i}`);
      expect(s.supervisor.getStatus()).toMatchObject({ state: 'restarting', restarts: i });
      await settle(40);
    }
    await boot(s, 4);
    s.supervisor.crashed('crash 4');
    // Three restarts happened; the fourth failure is final, with no restart to count.
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'failed', restarts: 3, epoch: 4 });
    expect(s.supervisor.getStatus().reason).toContain('4 engine failures in a row');
    expect(s.supervisor.getMount()).toBeNull();
    await expect(s.supervisor.call('feed.home', [])).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
    // Failed is where it stays: no restart is scheduled.
    await settle(60_000);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'failed', epoch: 4 });

    // "Try again": a fresh budget of three restarts.
    s.supervisor.restart('Try again (banner)');
    for (let epoch = 5; epoch <= 7; epoch++) {
      await boot(s, epoch);
      expect(s.supervisor.getStatus().state).toBe('ready');
      s.supervisor.crashed(`crash after try again ${epoch}`);
      expect(s.supervisor.getStatus().state).toBe('restarting');
      await settle(40);
    }
    await boot(s, 8);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'ready', epoch: 8 });
    s.supervisor.crashed('one too many');
    expect(s.supervisor.getStatus().state).toBe('failed');
  });

  it('gives up on a fast crash loop: prepare rejects every time', async () => {
    const deps: SupervisorDeps<string> = {
      platform: 'ios',
      prepare: () => Promise.reject(new Error('the Keychain is locked')),
      onStorage: jest.fn(),
      log: jest.fn(),
    };
    const supervisor = new EngineSupervisor(deps, { backoffMs: [500, 1000, 2000, 4000] });
    supervisor.start();
    const queued = supervisor.call('feed.home', []).catch((error: unknown) => error);
    await settle(); // 1st failure
    await settle(500);
    await settle(1000);
    await settle(2000); // 4th failure
    expect(supervisor.getStatus()).toMatchObject({ state: 'failed', restarts: 3, epoch: 4, queued: 0 });
    expect(await queued).toMatchObject({ code: 'ENGINE_UNAVAILABLE', message: expect.stringContaining('Keychain is locked') });
  });

  it('fails an engine that never says hello, however slowly each attempt fails (SR-08)', async () => {
    const s = setup({
      supervisor: { backoffMs: [500, 1000, 2000, 4000, 8000, 30_000], pingIntervalMs: 600_000 },
      configure: (engine) => (engine.answerPings = false),
    });
    s.supervisor.start();
    const queued = s.supervisor.call('feed.home', []).catch((error: unknown) => error);
    for (let i = 0; i < 20 && s.supervisor.getStatus().state !== 'failed'; i++) await settle(31_000);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'failed', restarts: 3, epoch: 4, queued: 0 });
    expect(await queued).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
    await expect(s.supervisor.call('feed.home', [])).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });

  it('fails an engine that says hello but never boots, though each attempt takes longer than the window (SR-08)', async () => {
    const s = setup({
      supervisor: { pingIntervalMs: 600_000 },
      configure: (engine) => engine.hold.add('engine.boot'),
    });
    s.supervisor.start();
    for (let epoch = 1; epoch <= 4; epoch++) {
      await boot(s, epoch);
      expect(s.supervisor.getStatus()).toMatchObject({ state: 'booting', epoch });
      await settle(90_000);
      await settle(40);
    }
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'failed', restarts: 3 });
    expect(s.supervisor.getStatus().reason).toContain('no ready within 90 s');
  });

  it('fails an engine that comes up and hangs, four times within two minutes (NET-04)', async () => {
    const s = setup({
      supervisor: { pingIntervalMs: 6_000, pingTimeoutMs: 100 },
      configure: (engine) => (engine.answerPings = false),
    });
    s.supervisor.start();
    for (let epoch = 1; epoch <= 4; epoch++) {
      await boot(s, epoch);
      expect(s.supervisor.getStatus()).toMatchObject({ state: 'ready', epoch });
      // Three missed pings, 6 s apart: a hang about 18 s after ready.
      for (let ping = 0; ping < 3; ping++) await settle(6_100);
      await settle(40);
    }
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'failed', restarts: 3 });
    expect(s.deps.log).toHaveBeenCalledWith('error', 'host', 'Engine crashed: unresponsive (missed pings)');
  });

  it('judges engines that came up by the 2-minute window: crashes 1.9 minutes apart never trip it', async () => {
    const s = setup({ supervisor: { pingIntervalMs: 600_000 } });
    s.supervisor.start();
    for (let epoch = 1; epoch <= 6; epoch++) {
      await boot(s, epoch);
      await settle(55_000);
      s.supervisor.crashed(`crash ${epoch}`);
      expect(s.supervisor.getStatus()).toMatchObject({ state: 'restarting', restarts: epoch });
      await settle(40);
      await settle(59_000);
    }
    await boot(s, 7);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'ready', epoch: 7 });
    s.supervisor.stop();
  });

  it('counts a crash exactly the window old out of it', async () => {
    const s = setup({ supervisor: { pingIntervalMs: 600_000, failureWindowMs: 1000, backoffMs: [0] } });
    s.supervisor.start();
    // Three crashes inside the window, then the fourth when the first is exactly 1000 ms old.
    for (let epoch = 1; epoch <= 3; epoch++) {
      await boot(s, epoch);
      s.supervisor.crashed(`crash ${epoch}`);
      await settle(epoch < 3 ? 400 : 200);
    }
    await boot(s, 4);
    s.supervisor.crashed('crash 4');
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'restarting', restarts: 4 });
    s.supervisor.stop();
  });

  it('counts a degraded engine as up: it ends a run of boots that never came up', async () => {
    const s = setup({
      supervisor: { pingIntervalMs: 600_000 },
      configure: (engine, epoch) => {
        // Epochs 1-3 never finish booting; epoch 4 comes up degraded (DAPI trouble).
        if (epoch === 4) engine.handlers['engine.boot'] = () => { throw new RpcError('DAPI 504', 'NETWORK'); };
        else if (epoch < 4) engine.hold.add('engine.boot');
      },
    });
    s.supervisor.start();
    for (let epoch = 1; epoch <= 3; epoch++) {
      await boot(s, epoch);
      await settle(90_000);
      await settle(40);
    }
    expect(s.supervisor.getStatus()).toMatchObject({ restarts: 3, epoch: 4 });
    await boot(s, 4);
    expect(s.supervisor.getStatus().state).toBe('degraded');
    // Past the window: only the run of failed boots could trip it, and coming up degraded ended it.
    await settle(130_000);
    s.supervisor.crashed('later crash');
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'restarting', restarts: 4 });
    s.supervisor.stop();
  });

  it('gives a failed engine a fresh budget on return to the foreground', async () => {
    const s = setup();
    s.supervisor.start();
    for (let epoch = 1; epoch <= 4; epoch++) {
      await boot(s, epoch);
      s.supervisor.crashed(`crash ${epoch}`);
      await settle(40);
    }
    expect(s.supervisor.getStatus().state).toBe('failed');
    s.supervisor.setForeground(false);
    s.supervisor.setForeground(true);
    await boot(s, 5);
    s.supervisor.crashed('after the return');
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'restarting', epoch: 5 });
    s.supervisor.stop();
  });

  it('does not count a start that failed in the background, and keeps its calls for the return', async () => {
    let fail = true;
    const deps: SupervisorDeps<string> = {
      platform: 'ios',
      prepare: () => (fail ? Promise.reject(new Error('the Keychain is locked')) : new Promise(() => undefined)),
      onStorage: jest.fn(),
      log: jest.fn(),
    };
    const supervisor = new EngineSupervisor(deps);
    supervisor.setForeground(false);
    supervisor.start();
    const queued = supervisor.call('feed.home', []);
    await settle();
    expect(supervisor.getStatus()).toMatchObject({ state: 'failed', restarts: 0, queued: 1 });
    fail = false;
    supervisor.setForeground(true);
    await settle();
    expect(supervisor.getStatus()).toMatchObject({ state: 'starting', epoch: 2, queued: 1 });
    supervisor.stop();
    await expect(queued).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });

  it('does not give up on crashes spaced by more than two minutes of running', async () => {
    const s = setup({ supervisor: { pingIntervalMs: 600_000 } });
    s.supervisor.start();
    for (let epoch = 1; epoch <= 8; epoch++) {
      await boot(s, epoch);
      expect(s.supervisor.getStatus().state).toBe('ready');
      await settle(120_000);
      s.supervisor.crashed(`crash ${epoch}`);
      expect(s.supervisor.getStatus()).toMatchObject({ state: 'restarting', restarts: epoch });
      // Each crash starts a new run, so it waits the first backoff step only.
      await settle(10);
    }
    await boot(s, 9);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'ready', epoch: 9 });
    s.supervisor.stop();
  });

  it('settles every call when the engine gives up: queued reads and writes, and in-flight ones', async () => {
    const s = setup({
      supervisor: { pingIntervalMs: 600_000 },
      configure: (engine, epoch) => {
        if (epoch === 4) engine.hold.add('feed.home').add('posts.publish');
      },
    });
    s.supervisor.start();
    for (let epoch = 1; epoch <= 3; epoch++) {
      await boot(s, epoch);
      s.supervisor.crashed(`crash ${epoch}`);
      await settle(40);
    }
    await boot(s, 4);
    const inFlightRead = s.supervisor.call('feed.home', []).catch((error: unknown) => error);
    const inFlightWrite = s.supervisor.call('posts.publish', []).catch((error: unknown) => error);
    await settle();
    expect(s.engines[4].held).toHaveLength(2);
    s.supervisor.crashed('crash 4');
    // Made after the crash, before anyone noticed: queued, then failed with the queue.
    const lateRead = s.supervisor.call('feed.home', []).catch((error: unknown) => error);
    await settle();
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'failed', queued: 0 });
    // The read would have been replayed on a restarted engine; there is none.
    expect(await inFlightRead).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
    expect(await inFlightWrite).toMatchObject({ code: 'ENGINE_RESTARTED' });
    expect(await lateRead).toMatchObject({ code: 'ENGINE_UNAVAILABLE' });
  });

  it('does not count background time toward the hello and boot deadlines (SR-29)', async () => {
    const s = setup({
      supervisor: { pingIntervalMs: 600_000 },
      configure: (engine) => {
        engine.answerPings = false;
        engine.hold.add('engine.boot');
      },
    });
    s.supervisor.start();
    await settle();
    await settle(10_000);
    // Suspended for two minutes before saying hello: neither deadline has run out in foreground time.
    s.supervisor.setForeground(false);
    await settle(120_000);
    s.supervisor.setForeground(true);
    await settle();
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'handshaking', epoch: 1, restarts: 0 });
    s.engines[1].hello();
    await settle();
    expect(s.supervisor.getStatus().state).toBe('booting');
    // 10 s were spent before the background stretch; the boot deadline has 80 s of foreground left.
    await settle(79_000);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'booting', epoch: 1 });
    await settle(1000);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'restarting', restarts: 1 });
    expect(s.deps.log).toHaveBeenCalledWith('error', 'host', 'Engine crashed: no ready within 90 s');
    s.supervisor.stop();
  });

  it('tells an engine that boots in the background that it is in the background', async () => {
    const s = setup();
    s.supervisor.setForeground(false);
    s.supervisor.start();
    await boot(s);
    expect(s.supervisor.getStatus().state).toBe('ready');
    expect(s.engines[1].calls).toEqual(['engine.info', 'engine.lifecycle', 'engine.boot']);

    // In the foreground it is not told anything.
    s.supervisor.setForeground(true);
    s.supervisor.restart();
    await boot(s, 2);
    expect(s.engines[2].calls).toEqual(['engine.info', 'engine.boot']);
    s.supervisor.stop();
  });

  it('still restarts an engine that never says hello in the foreground', async () => {
    const s = setup({ configure: (engine, epoch) => (engine.answerPings = epoch !== 1) });
    s.supervisor.start();
    await settle(30_000);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'restarting', restarts: 1 });
    expect(s.deps.log).toHaveBeenCalledWith(
      'error',
      'host',
      'Engine crashed: handshake failed: Engine did not say hello within 30000 ms',
    );
    s.supervisor.stop();
  });

  it('retries an unsupported engine on return to the foreground (SR-27)', async () => {
    let wasm = false;
    const s = setup({ configure: (engine) => (engine.handlers['engine.info'] = () => ({ webAssembly: wasm })) });
    s.supervisor.start();
    await boot(s);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'unsupported', unsupported: 'lockdown', epoch: 1 });

    // The user excluded Yappr from Lockdown Mode in Settings and came back.
    wasm = true;
    s.supervisor.setForeground(false);
    s.supervisor.setForeground(true);
    await boot(s, 2);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'ready', epoch: 2, unsupported: null });
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

  it('holds app calls while the engine boots, so none reaches an SDK that is not configured yet', async () => {
    const s = setup({
      configure: (engine) => {
        engine.hold.add('engine.boot');
        engine.handlers['feed.home'] = () => ({ items: ['fresh'] });
      },
    });
    s.supervisor.start();
    await boot(s);
    const engine = s.engines[1];
    expect(s.supervisor.getStatus().state).toBe('booting');

    // A read made while engine.boot() runs waits; a lifecycle (control) call goes through.
    const read = s.supervisor.call('feed.home', [{}]);
    await s.supervisor.background();
    await settle();
    expect(engine.calls).toEqual(['engine.info', 'engine.boot', 'engine.lifecycle']);
    expect(s.supervisor.getStatus().queued).toBe(1);

    const booting = engine.held.shift()!;
    engine.respond(booting.id, booting.path, booting.args);
    await expect(read).resolves.toEqual({ items: ['fresh'] });
    expect(engine.calls.at(-1)).toBe('feed.home');
    s.supervisor.stop();
  });

  it('lets held app calls through once a failed boot leaves the engine degraded', async () => {
    const s = setup({
      configure: (engine) => {
        engine.hold.add('engine.boot');
        engine.handlers['engine.boot'] = () => {
          throw new RpcError('Failed to prefetch quorums', 'NETWORK');
        };
        engine.handlers['feed.home'] = () => ({ items: [] });
      },
    });
    s.supervisor.start();
    await boot(s);
    const read = s.supervisor.call('feed.home', [{}]);
    await settle();
    const engine = s.engines[1];
    expect(engine.calls).not.toContain('feed.home');

    const booting = engine.held.shift()!;
    engine.respond(booting.id, booting.path, booting.args);
    await expect(read).resolves.toEqual({ items: [] });
    expect(s.supervisor.getStatus().state).toBe('degraded');
    s.supervisor.stop();
  });

  it('logs and times a degraded boot that finishes, for diagnostics (SET-08, NET-01)', async () => {
    let online = false;
    const s = setup({
      configure: (engine) => {
        engine.handlers['engine.boot'] = () => {
          if (!online) throw new RpcError('Failed to prefetch quorums', 'NETWORK');
          return { webAssembly: true, ready: true };
        };
      },
    });
    s.supervisor.start();
    await boot(s);
    expect(s.supervisor.getStatus().timings?.readyMs).toBeUndefined();

    online = true;
    await s.supervisor.connectivity(true);
    const status = s.supervisor.getStatus();
    expect(status.state).toBe('ready');
    expect(status.timings).toMatchObject({ bootMs: expect.any(Number), readyMs: expect.any(Number) });
    expect(s.deps.log).toHaveBeenCalledWith('info', 'host', expect.stringMatching(/^Engine ready after a failed boot in \d+ ms/));
    s.supervisor.stop();
  });

  it('boots a degraded engine again at once on "Try again" (NET-01)', async () => {
    let fail = true;
    const s = setup({
      supervisor: { pingIntervalMs: 600_000 },
      configure: (engine) => {
        engine.handlers['engine.boot'] = () => {
          if (fail) throw new RpcError('DAPI 504', 'NETWORK');
          return { webAssembly: true, ready: true };
        };
      },
    });
    s.supervisor.start();
    await boot(s);
    expect(s.supervisor.getStatus().state).toBe('degraded');

    fail = false;
    s.supervisor.retryBootNow();
    await settle();
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'ready', epoch: 1 });
    s.supervisor.stop();
  });

  it('restarts, rather than degrades, an engine whose WASM did not load', async () => {
    const s = setup({
      configure: (engine, epoch) => {
        if (epoch === 1) {
          engine.handlers['engine.boot'] = () => {
            throw new RpcError('The SDK’s WebAssembly did not load: engine.wasm.js did not load', 'ENGINE_LOAD_FAILED');
          };
        }
      },
    });
    s.supervisor.start();
    await boot(s);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'restarting', restarts: 1 });
    await settle(10);
    await boot(s, 2);
    expect(s.supervisor.getStatus()).toMatchObject({ state: 'ready', epoch: 2 });
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

  it('reports every failed call to diagnostics with its path, reads included, but not the arguments (SET-08)', async () => {
    const s = setup({
      configure: (engine) => {
        engine.handlers['engine.boot'] = () => {
          throw new RpcError('Failed to fetch', 'NETWORK');
        };
        engine.handlers['profiles.get'] = () => {
          throw new RpcError('Dash Platform is temporarily unavailable', 'UNAVAILABLE');
        };
        engine.handlers['feed.home'] = () => ({ items: [], cursor: null });
        engine.handlers['engine.diagnostics'] = () => {
          throw new RpcError('poll failed', 'UNAVAILABLE');
        };
        engine.hold.add('posts.thread');
      },
    });
    s.supervisor.start();
    await boot(s);
    expect(s.deps.error).toHaveBeenCalledWith('engine.boot', 'Failed to fetch');

    await expect(s.supervisor.call('profiles.get', ['secret-arg'])).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(s.deps.error).toHaveBeenLastCalledWith('profiles.get', 'Dash Platform is temporarily unavailable');

    const hung = s.supervisor.call('posts.thread', ['id']);
    hung.catch(() => undefined);
    await settle(30_000);
    await expect(hung).rejects.toMatchObject({ code: 'RPC_TIMEOUT' });
    expect(s.deps.error).toHaveBeenCalledWith('posts.thread', 'Engine call posts.thread timed out after 30000 ms');

    await expect(s.supervisor.call('feed.home', [])).resolves.toEqual({ items: [], cursor: null });
    // The host's control calls are its own machinery (a diagnostics poll cut by a restart): not listed.
    await expect(s.supervisor.call('engine.diagnostics', [])).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    const operations = (s.deps.error as jest.Mock).mock.calls.map(([operation]: string[]) => operation);
    expect(operations).not.toContain('feed.home');
    expect(operations).not.toContain('engine.diagnostics');
    expect(JSON.stringify((s.deps.error as jest.Mock).mock.calls)).not.toContain('secret-arg');
    s.supervisor.stop();
  });

  it('reads the Chrome major version from a WebView user agent', () => {
    expect(parseChromeMajor('Mozilla/5.0 (Linux; Android 15; wv) AppleWebKit/537.36 Version/4.0 Chrome/124.0.6367.219 Mobile Safari/537.36')).toBe(124);
    expect(parseChromeMajor('Mozilla/5.0 (iPhone; CPU iPhone OS 26_5 like Mac OS X) AppleWebKit/605.1.15')).toBeNull();
  });
});
