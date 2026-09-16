import { describe, expect, it, vi } from 'vitest';
import { observeSdkConnectionErrors } from './sdk-connection-errors';

describe('SDK failure observer compatibility', () => {
  it('preserves synchronous values, streams, receiver binding and successful promises', async () => {
    const stream = { [Symbol.asyncIterator]: async function* () { yield 1; } };
    class Facade {
      label = 'same receiver';
      local() { return this.label; }
      stream() { return stream; }
      async read() { return this.label; }
    }
    const facade = new Facade();
    const recover = vi.fn();
    observeSdkConnectionErrors([facade], recover);
    expect(facade.local()).toBe('same receiver');
    expect(facade.stream()).toBe(stream);
    await expect(facade.read()).resolves.toBe('same receiver');
    expect(recover).not.toHaveBeenCalled();
  });

  it('retains the original rejection if recovery also fails and never repeats the operation', async () => {
    const original = new Error('original transport failure');
    const operation = vi.fn().mockRejectedValue(original);
    const facade = { operation };
    const recover = vi.fn().mockRejectedValue(new Error('rebuild failed'));
    observeSdkConnectionErrors([facade], recover);
    await expect(facade.operation()).rejects.toBe(original);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith(original);
  });
});
