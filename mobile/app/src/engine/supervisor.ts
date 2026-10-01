import type { EngineApi, EngineInfo } from '@engine/api';
import { LOG_LEVELS, RpcError, RpcErrorCode, type EngineHello, type LogLevel } from '@engine/protocol/envelope';
import { createEngineClient, type EngineClient, type StorageBatch } from '@engine/rpc/client';

import { errorMessage } from './logs';
import { methodKind, methodTimeoutMs, type MethodKind } from './methods';
import { redact } from './redact';
import { createWebViewTransport, type WebViewTransport } from './webview-transport';

/**
 * The engine supervisor (ENGINE.md §3): one engine at a time, each in its own
 * WebView "epoch". It boots the engine, queues calls made before boot, watches
 * for crashes and hangs, restarts with backoff, replays interrupted reads once
 * and never replays anything else.
 *
 * States: idle → starting → handshaking → booting → ready ⇄ degraded,
 * then crashed → restarting → starting … , or terminal: unsupported, failed.
 */

export type EngineState =
  | 'idle'
  | 'starting'
  | 'handshaking'
  | 'booting'
  | 'ready'
  | 'degraded'
  | 'crashed'
  | 'restarting'
  | 'unsupported'
  | 'failed';

export type UnsupportedReason = 'lockdown' | 'webview-outdated';

/** What the WebView reports about itself before the engine runs (posted by the host's bootstrap script). */
export interface HostCaps {
  userAgent: string;
  webAssembly: boolean;
  secureContext: boolean;
  subtleCrypto: boolean;
  worker: boolean;
  decompressionStream: boolean;
  /** Android System WebView / Chrome major version, when the user agent has one. */
  chromeMajor: number | null;
}

export interface EngineTimings {
  /** Reading the storage snapshot and the engine page, before the mount. */
  prepareMs: number;
  /** When this epoch's WebView was mounted (epoch ms). */
  mountedAt: number;
  /** Mount → `engine.hello` (page load, bundle parse and evaluation). */
  helloMs?: number;
  /** `engine.boot()` round trip (wasm, SDK connect, contract preload). */
  bootMs?: number;
  /** Mount → ready. */
  readyMs?: number;
  /** The first app call answered on this epoch: its path and round trip. */
  firstCall?: { path: string; ms: number; sinceMountMs: number };
}

export interface EngineStatus {
  state: EngineState;
  /** Increments on every (re)mount. */
  epoch: number;
  /** Why the engine is degraded, crashed, unsupported or failed. */
  reason: string | null;
  unsupported: UnsupportedReason | null;
  hello: EngineHello | null;
  info: EngineInfo | null;
  caps: HostCaps | null;
  timings: EngineTimings | null;
  /** Crashes and hangs since launch. */
  restarts: number;
  /** Calls waiting for the engine. */
  queued: number;
}

/** One WebView mount. The host renders it; the transport carries its messages. */
export interface EngineMount<Load> {
  epoch: number;
  transport: WebViewTransport;
  /** Host-specific load parameters (page source, bootstrap), opaque to the supervisor. */
  load: Load;
}

export interface SupervisorDeps<Load> {
  /** Prepare one epoch's load parameters (storage snapshot, page source). */
  prepare(epoch: number): Promise<Load>;
  /** Persist a write-through batch; a secure batch resolves once durable. */
  onStorage(batch: StorageBatch): void | Promise<void>;
  log(level: LogLevel, source: 'engine' | 'host', message: string): void;
  /** iOS without WebAssembly is Lockdown Mode; elsewhere it means an unusable WebView. */
  platform: 'ios' | 'android';
  now?: () => number;
}

export interface SupervisorOptions {
  /** Restart delays, by the number of crashes in the failure window. */
  backoffMs?: number[];
  /** This many crashes inside `failureWindowMs` → `failed`. */
  maxFailures?: number;
  failureWindowMs?: number;
  /** No ready (or degraded) within this long after mount → restart. */
  bootDeadlineMs?: number;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
  /** Consecutive missed pings that count as a hang. */
  maxMissedPings?: number;
  /** Calls held before the engine can take them; beyond this the oldest read is dropped. */
  queueCap?: number;
  /** Oldest Android WebView the bundle runs on (its esbuild target is chrome110). */
  minChromeMajor?: number;
  /** Lowest engine console level forwarded (ENGINE.md §4.7: release builds want only warn and error). */
  engineLogLevel?: LogLevel;
}

const DEFAULTS: Required<SupervisorOptions> = {
  backoffMs: [500, 1000, 2000, 4000, 8000, 30_000],
  maxFailures: 5,
  failureWindowMs: 120_000,
  bootDeadlineMs: 90_000,
  helloTimeoutMs: 30_000,
  pingIntervalMs: 15_000,
  pingTimeoutMs: 5_000,
  maxMissedPings: 3,
  queueCap: 256,
  minChromeMajor: 110,
  engineLogLevel: 'info',
};

export const EngineErrorCode = {
  Busy: 'ENGINE_BUSY',
  Unavailable: 'ENGINE_UNAVAILABLE',
  Restarted: RpcErrorCode.Restarted,
  Timeout: RpcErrorCode.Timeout,
} as const;

interface Job {
  path: string;
  args: unknown[];
  kind: MethodKind;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  replayed: boolean;
}

/** Rejections that mean the engine went away under the call, not that the call failed. */
const ENGINE_GONE = new Set<string>([RpcErrorCode.Restarted, RpcErrorCode.Disconnected, RpcErrorCode.HelloTimeout]);

const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

/** Status fields that belong to one epoch, cleared on every (re)mount. */
const FRESH_EPOCH = { reason: null, unsupported: null, hello: null, info: null, caps: null, timings: null } as const;

/** Call `path` on a client's proxy (`client.api.feed.home(...)`). */
function invoke(client: EngineClient<EngineApi>, path: string, args: unknown[]): Promise<unknown> {
  const method = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], client.api);
  return (method as (...a: unknown[]) => Promise<unknown>)(...args);
}

export function parseChromeMajor(userAgent: string): number | null {
  const match = /Chrome\/(\d+)\./.exec(userAgent);
  return match ? Number(match[1]) : null;
}

export class EngineSupervisor<Load = unknown> {
  private readonly options: Required<SupervisorOptions>;
  private readonly now: () => number;
  private status: EngineStatus = { state: 'idle', epoch: 0, restarts: 0, queued: 0, ...FRESH_EPOCH };
  private mount: EngineMount<Load> | null = null;
  private client: EngineClient<EngineApi> | null = null;
  /** Calls go straight to the client once boot has been sent; until then they wait here. */
  private accepting = false;
  private queue: Job[] = [];
  private crashes: number[] = [];
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private missedPings = 0;
  private awaitingPong = false;
  private foreground = true;
  /** stop() was called: calls fail instead of waiting for an engine that is not coming. */
  private stopped = false;
  /** Last connectivity NetInfo reported; replayed into every engine after boot (it starts out online). */
  private online = true;
  /** A boot retry is scheduled: foreground returns and connectivity changes do not stack more. */
  private bootRetryScheduled = false;
  /** The boot retry in flight, shared by everyone who asks for one. */
  private bootInFlight: Promise<void> | null = null;
  private readonly statusListeners = new Set<() => void>();
  private readonly mountListeners = new Set<() => void>();
  private readonly events = new Map<string, Set<(payload: unknown) => void>>();
  private clientUnsubscribers: (() => void)[] = [];

  constructor(
    private readonly deps: SupervisorDeps<Load>,
    options: SupervisorOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    this.now = deps.now ?? Date.now;
  }

  // ── observation ──────────────────────────────────────────────────────────

  getStatus = (): EngineStatus => this.status;
  getMount = (): EngineMount<Load> | null => this.mount;

  subscribeStatus = (listener: () => void): (() => void) => {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  };

  subscribeMount = (listener: () => void): (() => void) => {
    this.mountListeners.add(listener);
    return () => this.mountListeners.delete(listener);
  };

  /** Subscribe to an engine event; survives restarts. */
  on(event: string, handler: (payload: unknown) => void): () => void {
    let set = this.events.get(event);
    if (!set) {
      this.events.set(event, (set = new Set()));
      if (this.client) this.forwardEvent(this.client, event);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  private update(patch: Partial<EngineStatus>) {
    // `reason` carries engine error text onto screens and into "Copy diagnostics": redact it like a log line.
    if (patch.reason) patch = { ...patch, reason: redact(patch.reason) };
    this.status = { ...this.status, ...patch, queued: this.queue.length };
    this.statusListeners.forEach((listener) => listener());
  }

  private setMount(mount: EngineMount<Load> | null) {
    this.mount = mount;
    this.mountListeners.forEach((listener) => listener());
  }

  private log(level: LogLevel, message: string) {
    this.deps.log(level, 'host', message);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Mount an engine. A no-op unless idle. */
  start(): void {
    if (this.status.state !== 'idle') return;
    this.stopped = false;
    this.launch(this.status.epoch + 1);
  }

  /** Tear everything down (tests; the app never unmounts the host). */
  stop(): void {
    this.stopped = true;
    this.teardown('Engine host stopped');
    this.failQueue(new RpcError('Engine host stopped', EngineErrorCode.Unavailable));
    this.update({ state: 'idle' });
  }

  /** "Restart engine" / "Try again": a fresh epoch, with the failure counter reset. */
  restart(reason = 'Restart requested'): void {
    this.log('info', `${reason}; restarting the engine`);
    this.crashes = [];
    this.teardown(reason);
    this.launch(this.status.epoch + 1);
  }

  /** The WebView's content process died (iOS) or its renderer is gone (Android). */
  crashed(cause: string, epoch = this.status.epoch): void {
    if (epoch !== this.status.epoch) return;
    if (['crashed', 'restarting', 'idle', 'failed', 'unsupported'].includes(this.status.state)) return;
    if (!this.foreground && this.status.state === 'starting') {
      // prepare() failed in the background (Keychain locked): try again on return, not in a loop.
      this.log('warn', `Engine start failed in the background: ${cause}`);
      this.teardown(cause);
      this.update({ state: 'failed', reason: cause });
      return;
    }
    this.log('error', `Engine crashed: ${cause}`);
    this.teardown(`Engine crashed: ${cause}`);
    const now = this.now();
    this.crashes = [...this.crashes.filter((at) => now - at < this.options.failureWindowMs), now];
    this.update({ state: 'crashed', reason: cause, restarts: this.status.restarts + 1 });
    if (this.crashes.length >= this.options.maxFailures) {
      this.update({ state: 'failed', reason: `${this.crashes.length} engine failures in a row; last: ${cause}` });
      this.failQueue(new RpcError(`The engine keeps failing (${cause})`, EngineErrorCode.Unavailable));
      return;
    }
    const delay = this.options.backoffMs[Math.min(this.crashes.length - 1, this.options.backoffMs.length - 1)];
    this.update({ state: 'restarting' });
    this.after(delay, () => this.launch(this.status.epoch + 1));
  }

  /** AppState: pings pause in the background and run once on return; a failed engine gets a fresh try. */
  setForeground(foreground: boolean): void {
    this.foreground = foreground;
    if (!foreground) return;
    if (this.status.state === 'failed') this.restart('Back in the foreground');
    else {
      if (this.status.state === 'degraded') this.retryBoot(0);
      this.ping();
    }
  }

  private launch(epoch: number) {
    this.update({ state: 'starting', epoch, ...FRESH_EPOCH });
    const started = this.now();
    this.deps
      .prepare(epoch)
      .then((load) => {
        if (this.status.epoch !== epoch || this.status.state !== 'starting') return;
        this.connect(epoch, load, this.now() - started);
      })
      // A locked Keychain, a missing page: retried with backoff like a crash.
      .catch((error: unknown) => this.crashed(`could not prepare the engine: ${errorMessage(error)}`, epoch));
  }

  private connect(epoch: number, load: Load, prepareMs: number) {
    const transport = createWebViewTransport();
    const mountedAt = this.now();
    const client = createEngineClient<EngineApi>(transport, {
      timeoutMs: 0, // deadlines are per method kind, here
      helloTimeoutMs: this.options.helloTimeoutMs,
      // Also filtered here: the engine forwards `info` until boot lowers its level.
      onLog: (level, message) => {
        if (LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(this.options.engineLogLevel)) {
          this.deps.log(level, 'engine', message);
        }
      },
      onStorage: (batch) => this.deps.onStorage(batch),
    });
    this.client = client;
    this.clientUnsubscribers = [
      transport.onMessage((message) => this.onHostMessage(epoch, message)),
      client.on('engine.hello', (payload) => {
        this.awaitingPong = false;
        this.missedPings = 0;
        // A new instance on the same mount: the page reloaded and lost its boot (and its snapshot is stale).
        const instanceId = (payload as EngineHello).instanceId;
        const known = this.status.hello?.instanceId;
        if (known && instanceId !== known) this.crashed('the engine page reloaded', epoch);
      }),
    ];
    for (const event of this.events.keys()) this.forwardEvent(client, event);

    this.update({ state: 'handshaking', timings: { prepareMs, mountedAt } });
    this.setMount({ epoch, transport, load });
    this.after(this.options.bootDeadlineMs, () => {
      if (this.status.epoch === epoch && ['handshaking', 'booting'].includes(this.status.state)) {
        this.crashed(`no ready within ${this.options.bootDeadlineMs / 1000} s`, epoch);
      }
    });

    client.ready.then(
      (hello) => this.boot(epoch, client, hello),
      (error: unknown) => {
        if (errorCode(error) === RpcErrorCode.ProtocolMismatch && this.status.epoch === epoch) {
          // A packaging bug (app and engine bundle out of step): restarting cannot fix it (§3.4).
          this.teardown(errorMessage(error));
          this.update({ state: 'failed', reason: errorMessage(error) });
          this.failQueue(new RpcError(errorMessage(error), EngineErrorCode.Unavailable));
        } else {
          this.crashed(`handshake failed: ${errorMessage(error)}`, epoch);
        }
      },
    );
  }

  /**
   * Messages from the host's own page scripts, not the engine: the bootstrap's
   * `host-caps` (before the bundle runs) and the dev timer probe.
   */
  private onHostMessage(epoch: number, message: string) {
    if (message.startsWith('{"t":"host-probe"')) {
      const { gaps } = JSON.parse(message) as { gaps: number[] };
      const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
      this.log('info', `Timer probe: ${gaps.length} × 50 ms setInterval → mean ${mean.toFixed(1)} ms, max ${Math.max(...gaps).toFixed(1)} ms`);
      return;
    }
    if (!message.startsWith('{"t":"host-caps"')) return;
    try {
      if (this.status.epoch !== epoch) return;
      const raw = JSON.parse(message) as Omit<HostCaps, 'chromeMajor'>;
      const caps: HostCaps = { ...raw, chromeMajor: parseChromeMajor(raw.userAgent) };
      this.update({ caps });
      // Decided before the bundle runs: an unusable WebView may never get as far as a hello.
      if (!caps.webAssembly) this.noWebAssembly('WebAssembly is unavailable');
      else if (this.deps.platform === 'android' && caps.chromeMajor !== null && caps.chromeMajor < this.options.minChromeMajor) {
        this.unsupported('webview-outdated', `Android System WebView ${caps.chromeMajor} is too old`);
      }
    } catch (error) {
      this.log('warn', `Ignoring malformed host caps: ${errorMessage(error)}`);
    }
  }

  private async boot(epoch: number, client: EngineClient<EngineApi>, hello: EngineHello) {
    const current = () => this.status.epoch === epoch && this.client === client;
    if (!current() || this.status.state !== 'handshaking') return;
    const helloAt = this.now();
    const timings = this.status.timings!;
    this.update({ state: 'booting', hello, timings: { ...timings, helloMs: helloAt - timings.mountedAt } });
    this.log('info', `Engine hello: protocol ${hello.protocol}, bundle ${hello.bundleHash.slice(0, 12)}`);

    try {
      const info = await client.api.engine.info();
      if (!current()) return;
      this.update({ info });
      if (!info.webAssembly) {
        this.noWebAssembly('WebAssembly is unavailable');
        return;
      }
      if (this.options.engineLogLevel !== 'info') await client.api.engine.setLogLevel(this.options.engineLogLevel);
      if (!this.online) await client.api.engine.connectivity(false);
      const bootStarted = this.now();
      const booted = client.api.engine.boot();
      // Queued calls go out after boot, so the SDK is initializing before any of them runs.
      this.acceptCalls();
      const bootInfo = await booted;
      if (!current()) return;
      const readyAt = this.now();
      this.update({
        state: 'ready',
        reason: null,
        info: bootInfo,
        timings: { ...this.status.timings!, bootMs: readyAt - bootStarted, readyMs: readyAt - timings.mountedAt },
      });
      this.log('info', `Engine ready in ${readyAt - timings.mountedAt} ms (boot ${readyAt - bootStarted} ms)`);
      this.startPings();
    } catch (error) {
      if (!current()) return;
      if (ENGINE_GONE.has(String(errorCode(error)))) return; // a crash is already being handled
      if (errorCode(error) === 'NO_WEBASSEMBLY') {
        this.noWebAssembly(errorMessage(error));
        return;
      }
      // Offline or DAPI trouble: calls still go through; connectivity retries the boot.
      this.acceptCalls();
      this.update({ state: 'degraded', reason: errorMessage(error) });
      this.log('warn', `Engine boot failed: ${errorMessage(error)}`);
      this.retryBoot(0);
      this.startPings();
    }
  }

  /** NetInfo: forward connectivity; coming back online finishes a boot that failed. */
  async connectivity(online: boolean): Promise<void> {
    this.online = online;
    const client = this.client;
    if (!client || !this.accepting) return;
    await client.api.engine.connectivity(online);
    if (online && this.status.state === 'degraded') await this.bootAgain(client);
  }

  /**
   * A degraded engine (boot failed: DAPI trouble) retries with backoff while
   * online and in the foreground. At most one retry is scheduled at a time.
   */
  private retryBoot(attempt: number) {
    if (this.bootRetryScheduled) return;
    this.bootRetryScheduled = true;
    const delay = Math.min(5000 * 2 ** attempt, 60_000);
    this.after(delay, () => {
      this.bootRetryScheduled = false;
      const client = this.client;
      // Offline or in the background: connectivity() or setForeground() picks it up again.
      if (!client || this.status.state !== 'degraded' || !this.online || !this.foreground) return;
      this.bootAgain(client).catch(() => this.retryBoot(attempt + 1));
    });
  }

  /** One `engine.boot()` at a time: concurrent callers share the call in flight. */
  private bootAgain(client: EngineClient<EngineApi>): Promise<void> {
    this.bootInFlight ??= client.api.engine
      .boot()
      .then((info) => {
        if (this.client === client) this.update({ state: 'ready', reason: null, info });
      })
      .finally(() => {
        this.bootInFlight = null;
      });
    return this.bootInFlight;
  }

  /** iOS without WebAssembly is Lockdown Mode; elsewhere it means an unusable WebView. */
  private noWebAssembly(detail: string) {
    this.unsupported(this.deps.platform === 'ios' ? 'lockdown' : 'webview-outdated', detail);
  }

  private acceptCalls() {
    this.accepting = true;
    this.drain();
  }

  private unsupported(reason: UnsupportedReason, detail: string) {
    if (this.status.state === 'unsupported') return;
    this.log('error', `Engine unsupported (${reason}): ${detail}`);
    this.teardown(detail);
    this.update({ state: 'unsupported', unsupported: reason, reason: detail });
    this.failQueue(new RpcError(detail, EngineErrorCode.Unavailable));
  }

  /** Close the current epoch: the WebView goes, in-flight calls reject (and reads requeue), timers stop. */
  private teardown(reason: string) {
    this.setMount(null);
    // Timers are cleared below; a boot in flight belongs to the client being closed.
    this.bootRetryScheduled = false;
    this.bootInFlight = null;
    this.accepting = false;
    this.stopPings();
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.clientUnsubscribers.forEach((unsubscribe) => unsubscribe());
    this.clientUnsubscribers = [];
    const client = this.client;
    this.client = null;
    client?.close(reason);
  }

  private after(ms: number, run: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
  }

  // ── health ───────────────────────────────────────────────────────────────

  private startPings() {
    this.stopPings();
    this.pingTimer = setInterval(() => this.ping(), this.options.pingIntervalMs);
  }

  private stopPings() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.missedPings = 0;
    this.awaitingPong = false;
  }

  /** Ask for a hello; three unanswered in a row is a hang. */
  private ping() {
    const client = this.client;
    if (!client || !this.foreground || !['ready', 'degraded'].includes(this.status.state)) return;
    if (this.awaitingPong) return;
    this.awaitingPong = true;
    const epoch = this.status.epoch;
    client.ping();
    this.after(this.options.pingTimeoutMs, () => {
      if (this.client !== client || !this.awaitingPong) return;
      this.awaitingPong = false;
      this.missedPings += 1;
      this.log('warn', `Engine missed a ping (${this.missedPings}/${this.options.maxMissedPings})`);
      if (this.missedPings >= this.options.maxMissedPings) this.crashed('unresponsive (missed pings)', epoch);
    });
  }

  // ── calls ────────────────────────────────────────────────────────────────

  /** Call an engine method by path. Queued until the engine boots; reads survive one restart. */
  call(path: string, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.dispatch({ path, args, kind: methodKind(path), resolve, reject, replayed: false });
    });
  }

  private dispatch(job: Job) {
    const { state } = this.status;
    if (state === 'failed' || state === 'unsupported' || this.stopped) {
      job.reject(new RpcError(this.status.reason ?? 'The engine is unavailable', EngineErrorCode.Unavailable));
      return;
    }
    if (this.accepting && this.client) {
      this.send(this.client, job);
      return;
    }
    this.queue.push(job);
    if (this.queue.length > this.options.queueCap) {
      const oldestRead = this.queue.findIndex((queued) => queued.kind === 'read');
      if (oldestRead >= 0) {
        const [dropped] = this.queue.splice(oldestRead, 1);
        dropped.reject(new RpcError('Too many calls waiting for the engine', EngineErrorCode.Busy));
      }
    }
    this.update({});
  }

  private drain() {
    const jobs = this.queue;
    this.queue = [];
    this.update({});
    for (const job of jobs) this.dispatch(job);
  }

  private failQueue(error: Error) {
    const jobs = this.queue;
    this.queue = [];
    for (const job of jobs) job.reject(error);
    this.update({});
  }

  private send(client: EngineClient<EngineApi>, job: Job) {
    const started = this.now();
    const epoch = this.status.epoch;
    let settled = false;
    /** True for the first outcome only (response, failure or deadline). */
    const settle = () => {
      clearTimeout(timer);
      if (settled) return false;
      settled = true;
      return true;
    };
    const timeoutMs = methodTimeoutMs(job.path);
    const timer = setTimeout(() => {
      if (settle()) {
        job.reject(new RpcError(`Engine call ${job.path} timed out after ${timeoutMs} ms`, EngineErrorCode.Timeout));
      }
    }, timeoutMs);

    invoke(client, job.path, job.args).then(
      (value) => {
        if (!settle()) return;
        if (job.kind !== 'control') this.recordFirstCall(epoch, job.path, started);
        job.resolve(value);
      },
      (error: unknown) => {
        if (!settle()) return;
        if (!ENGINE_GONE.has(String(errorCode(error)))) {
          job.reject(error);
        } else if (job.kind === 'read' && !job.replayed) {
          this.log('info', `Replaying ${job.path} on the restarted engine`);
          this.dispatch({ ...job, replayed: true });
        } else {
          job.reject(new RpcError(`The engine restarted during ${job.path}`, EngineErrorCode.Restarted));
        }
      },
    );
  }

  private recordFirstCall(epoch: number, path: string, started: number) {
    const timings = this.status.timings;
    if (!timings || timings.firstCall || this.status.epoch !== epoch) return;
    const now = this.now();
    this.update({ timings: { ...timings, firstCall: { path, ms: now - started, sinceMountMs: now - timings.mountedAt } } });
  }

  private forwardEvent(client: EngineClient<EngineApi>, event: string) {
    this.clientUnsubscribers.push(
      client.on(event, (payload) => this.events.get(event)?.forEach((handler) => handler(payload))),
    );
  }

  /**
   * Dev diagnostics (ENGINE.md O4): time 20 × 50 ms `setInterval` ticks in
   * the hidden WebView, to see whether a zero-size view throttles timers.
   */
  probeTimers(): void {
    this.mount?.transport.evaluate(
      '(function(){var n=0,last=performance.now(),gaps=[];var id=setInterval(function(){var t=performance.now();' +
        'gaps.push(t-last);last=t;if(++n>=20){clearInterval(id);window.ReactNativeWebView.postMessage(' +
        'JSON.stringify({t:"host-probe",gaps:gaps}))}},50)})();true;',
    );
  }

  /** Tell a running engine the app went to the background (it fires visibilitychange and pagehide). */
  async background(): Promise<void> {
    if (this.client && this.accepting) await this.call('engine.lifecycle', ['background']);
  }
}
