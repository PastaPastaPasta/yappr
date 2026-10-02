import type { EngineInfo, WriteTicket } from '@engine/api';

/**
 * A stand-in for `~/engine` in Jest. Every `engine.api.<module>.<method>` is
 * a `jest.fn` (rejecting until a test gives it an answer), events are
 * emitted by hand, and the supervisor's status is set by hand:
 *
 *   jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
 *   fakeEngine.method('engage.like').mockResolvedValue(ticket({ op: 'like' }));
 *   fakeEngine.emit('write.status', ticket({ state: 'confirmed' }));
 */

type Listener = (payload: unknown) => void;

const methods = new Map<string, jest.Mock>();
const listeners = new Map<string, Set<Listener>>();

function method(path: string): jest.Mock {
  let fn = methods.get(path);
  if (!fn) {
    fn = jest.fn(() => Promise.reject(new Error(`fake engine: no answer for ${path}`)));
    methods.set(path, fn);
  }
  return fn;
}

const at = (path: string[]): unknown =>
  new Proxy(() => undefined, {
    get: (_target, key) => (typeof key === 'string' && key !== 'then' ? at([...path, key]) : undefined),
    apply: (_target, _this, args: unknown[]) => method(path.join('.'))(...args),
  });

type Status = {
  state: string;
  epoch: number;
  info: Partial<EngineInfo> | null;
  unsupported?: 'lockdown' | 'webview-outdated' | null;
};

let status: Status = { state: 'handshaking', epoch: 1, info: null };
const statusListeners = new Set<() => void>();

export const fakeEngine = {
  method,
  emit(event: string, payload: unknown): void {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  },
  listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
  setStatus(next: Partial<Status>): void {
    status = { ...status, ...next };
    for (const listener of statusListeners) listener();
  },
  reset(): void {
    methods.clear();
    status = { state: 'handshaking', epoch: 1, info: null };
  },
};

export const engineModule = {
  engineNetworkKey: 'devnet-test',
  engine: {
    api: at([]),
    on(event: string, listener: Listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
  },
  engineStorage: {
    idle: async () => undefined,
  },
  engineSupervisor: {
    /** An engine restart; tests drive the next session by hand (`fakeEngine.emit('session.changed', …)`). */
    restart: jest.fn(),
    getStatus: () => status,
    subscribeStatus(listener: () => void) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  },
};

let nextTicket = 1;

/** A write ticket, `pending` unless overridden. */
export function ticket(overrides: Partial<WriteTicket> = {}): WriteTicket {
  const now = new Date();
  return {
    id: `t${nextTicket++}`,
    op: 'like',
    identityId: 'viewer',
    state: 'pending',
    stage: 'signing',
    target: null,
    documents: [],
    progress: null,
    error: null,
    retryable: false,
    createdAt: now,
    updatedAt: now,
    lastCheckedAt: null,
    ...overrides,
  };
}

/** The same ticket, moved on (a later `updatedAt`). */
export function advance(previous: WriteTicket, overrides: Partial<WriteTicket>): WriteTicket {
  return { ...previous, updatedAt: new Date(previous.updatedAt.getTime() + 1000), ...overrides };
}
