import { methodKind, methodTimeoutMs } from './methods';
import { createRemote } from './remote';

interface Api {
  feed: { forYou(options: { cursor?: string }): Promise<string[]> };
}

describe('engine.api proxy', () => {
  it('turns property paths into calls', async () => {
    const call = jest.fn(async (path: string, args: unknown[]) => [path, ...args.map(String)]);
    const api = createRemote<Api>(call);
    await expect(api.feed.forYou({ cursor: 'c' })).resolves.toEqual(['feed.forYou', '[object Object]']);
    expect(call).toHaveBeenCalledWith('feed.forYou', [{ cursor: 'c' }]);
  });

  it('is not a thenable and sends nothing when inspected', () => {
    const call = jest.fn();
    const api = createRemote<Api>(call) as unknown as Record<string, unknown>;
    expect(api.then).toBeUndefined();
    expect(api.toJSON).toBeUndefined();
    expect(call).not.toHaveBeenCalled();
  });
});

describe('method kinds', () => {
  it.each([
    ['feed.home', 'read', 30_000],
    ['writes.get', 'read', 30_000],
    ['settings.set', 'write', 15_000],
    ['posts.get', 'read', 30_000],
    ['engine.info', 'read', 30_000],
    ['engine.lifecycle', 'control', 5_000],
    ['session.signInWithKey', 'session', 30_000],
    ['session.awaitKeyRegistration', 'session', 310_000],
    ['posts.publish', 'write', 15_000],
    ['something.new', 'write', 15_000],
  ])('%s is a %s with a %i ms deadline', (path, kind, timeout) => {
    expect(methodKind(path)).toBe(kind);
    expect(methodTimeoutMs(path)).toBe(timeout);
  });
});
