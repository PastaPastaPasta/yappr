import type { Remote } from '@engine/rpc/client';

/**
 * Property names the proxy must not turn into calls: Promise resolution,
 * coercion, and what loggers, inspectors and React probe on any object
 * (the same list as mobile/engine src/rpc/client.ts).
 */
const NOT_METHODS = new Set([
  'then', 'catch', 'finally', 'toString', 'valueOf', 'toJSON', 'constructor', 'inspect',
  '$$typeof', 'nodeType', 'asymmetricMatch', 'prototype', 'length', 'name', 'call', 'apply', 'bind',
]);

/**
 * The typed `engine.api` proxy: `api.feed.home(x)` calls
 * `call('feed.home', [x])`, so a new engine method needs no host change.
 * Unlike the RPC client's own proxy, this one survives engine restarts: the
 * supervisor behind `call` routes each call to the engine of the moment.
 */
export function createRemote<T>(call: (path: string, args: unknown[]) => Promise<unknown>): Remote<T> {
  const at = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get(_target, key) {
        if (typeof key !== 'string' || NOT_METHODS.has(key)) return undefined;
        return at([...path, key]);
      },
      apply(_target, _this, args: unknown[]) {
        return call(path.join('.'), args);
      },
    });
  return at([]) as Remote<T>;
}
