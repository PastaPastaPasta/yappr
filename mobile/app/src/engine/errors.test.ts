import { ENGINE_ERRORS_CAPACITY, getEngineErrors, recordEngineError, subscribeEngineErrors } from './errors';
import { appendLog } from './logs';

const WIF = 'cVt4o7BGAig1UXywgGSmARhxMdzP5qvQsxKkSsc1XEkw3tDTQFpy';
const last = () => getEngineErrors()[getEngineErrors().length - 1];

describe('recent engine errors (SET-08)', () => {
  it('keeps the last 50 with time, operation and the redacted message, and notifies', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeEngineErrors(listener);
    for (let i = 0; i < ENGINE_ERRORS_CAPACITY + 5; i++) recordEngineError('feed.home', `failure ${i}`, 1000 + i);
    recordEngineError('profiles.get', `signing with ${WIF} failed`, 5000);
    unsubscribe();

    const errors = getEngineErrors();
    expect(errors).toHaveLength(ENGINE_ERRORS_CAPACITY);
    expect(errors[0]).toMatchObject({ operation: 'feed.home', message: 'failure 6', at: 1006 });
    expect(last()).toMatchObject({ operation: 'profiles.get', at: 5000 });
    expect(last().message).not.toContain(WIF);
    expect(listener).toHaveBeenCalledTimes(ENGINE_ERRORS_CAPACITY + 6);
  });

  it('lists the errors the engine logs (lib logs the reads it recovers from), not its warnings', () => {
    appendLog('warn', 'engine', 'Engine missed a ping');
    expect(last().message).not.toBe('Engine missed a ping');
    appendLog('error', 'engine', 'Error querying post documents: Dash Platform is temporarily unavailable');
    expect(last()).toMatchObject({
      operation: 'engine',
      message: 'Error querying post documents: Dash Platform is temporarily unavailable',
    });
  });
});
