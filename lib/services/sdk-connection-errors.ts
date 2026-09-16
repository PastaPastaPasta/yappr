/**
 * Observe asynchronous failures without retrying the failed operation.
 * Install once on the mutable facades of each newly initialized SDK.
 */
export function observeSdkConnectionErrors(
  facades: readonly object[],
  recover: (error: unknown) => Promise<unknown>,
): void {
  for (const facade of facades) {
    const prototype = Object.getPrototypeOf(facade);
    const names = new Set([
      ...Object.getOwnPropertyNames(prototype),
      ...Object.getOwnPropertyNames(facade),
    ]);
    for (const name of names) {
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(facade, name) ??
        Object.getOwnPropertyDescriptor(prototype, name);
      if (typeof descriptor?.value !== 'function') continue;
      const original = descriptor.value;
      Object.defineProperty(facade, name, {
        configurable: true,
        writable: true,
        value: function (...args: unknown[]) {
          const result = original.apply(facade, args);
          // Local synchronous helpers and streams must retain their API.
          if (!result || typeof result.then !== 'function') return result;
          return Promise.resolve(result).catch(async (error: unknown) => {
            try {
              await recover(error);
            } catch {
              // Recovery cannot replace the operation's original failure.
            }
            throw error;
          });
        },
      });
    }
  }
}
