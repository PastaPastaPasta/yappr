import type { SessionDTO, WriteTicket } from '@engine/api';
import { act } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { useSessionStore } from '~/data/session';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { useToastStore } from '~/ui/toast';

import { BACKOFF_MS, MAX_ATTEMPTS, followGroupCreation, queueKeyResend, resendMissingKeys, resetKeyResends } from './group-keys';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);

const ALICE = 'AliceId111111111111111111111111111111111111';
const BOB = 'BobId11111111111111111111111111111111111111';
const CAROL = 'CarolId11111111111111111111111111111111111';
const GROUP = 'g:builders';

const session = (identityId: string): SessionDTO => ({
  identityId,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
});

const resend = () => fakeEngine.method('dm.resendKeys');
/** Lets the resend calls' promises answer. */
const settle = () => act(async () => {});
const wait = (ms: number) =>
  act(async () => {
    jest.advanceTimersByTime(ms);
  });

let appStateListeners: ((state: AppStateStatus) => void)[];
const originalAddEventListener = AppState.addEventListener;

beforeEach(() => {
  jest.useFakeTimers();
  fakeEngine.reset();
  resetKeyResends();
  useToastStore.setState({ current: null });
  useSessionStore.setState({ status: 'signed-in', session: session(ALICE), accounts: [] });
  appStateListeners = [];
  // Swapped, not spied: jest-expo's AppState is a mock whose restore would drop its implementation.
  AppState.addEventListener = ((_type: string, listener: (state: AppStateStatus) => void) => {
    appStateListeners.push(listener);
    return { remove: () => appStateListeners.splice(appStateListeners.indexOf(listener), 1) };
  }) as unknown as typeof AppState.addEventListener;
});

afterEach(() => {
  resetKeyResends();
  AppState.addEventListener = originalAddEventListener;
  jest.useRealTimers();
});

/** Each resend answers with a fresh ticket, recorded in order. */
function resendTickets(): WriteTicket[] {
  const issued: WriteTicket[] = [];
  resend().mockImplementation(async () => {
    const issuedTicket = ticket({ op: 'dm.group', target: { conversationKey: GROUP } });
    issued.push(issuedTicket);
    return issuedTicket;
  });
  return issued;
}

const emit = (next: WriteTicket) => act(() => fakeEngine.emit('write.status', next));

describe('group key resends (#8)', () => {
  it('resends a missed key once, and is done when it lands, with nothing said', async () => {
    const issued = resendTickets();
    queueKeyResend(ALICE, GROUP, [BOB]);
    await settle();
    expect(resend()).toHaveBeenCalledWith(GROUP, BOB);

    await emit(advance(issued[0], { state: 'confirmed' }));
    await wait(10 * 60_000);
    resendMissingKeys(GROUP);
    await settle();
    expect(resend()).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().current).toBeNull();
  });

  it('never sends a second resend while the first still runs, past the dm.group deadline too (#666)', async () => {
    const issued = resendTickets();
    queueKeyResend(ALICE, GROUP, [BOB]);
    await settle();
    // The engine's 5-minute deadline: unconfirmed, but its call still runs.
    await emit(advance(issued[0], { state: 'unconfirmed', error: { code: 'STILL_SENDING' } as never }));
    for (const trigger of [() => resendMissingKeys(GROUP), () => appStateListeners.forEach((l) => l('background'))]) {
      trigger();
      await settle();
    }
    appStateListeners.forEach((l) => l('active'));
    await wait(BACKOFF_MS[1] * 2);
    expect(resend()).toHaveBeenCalledTimes(1);

    // Its answer settles it.
    await emit(advance(issued[0], { state: 'confirmed', error: null }));
    expect(resend()).toHaveBeenCalledTimes(1);
  });

  it('backs off between failed attempts, stops after MAX_ATTEMPTS, then offers Retry once', async () => {
    const issued = resendTickets();
    queueKeyResend(ALICE, GROUP, [BOB, CAROL]);
    await settle();
    // One at a time: Carol's goes once Bob's is out.
    await settle();
    expect(resend()).toHaveBeenCalledTimes(2);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const sent = issued.slice(-2);
      for (const t of sent) await emit(advance(t, { state: 'failed', retryable: true }));
      if (attempt === MAX_ATTEMPTS) break;
      // Nothing before the backoff has passed.
      await wait(BACKOFF_MS[attempt - 1] - 1_000);
      expect(resend()).toHaveBeenCalledTimes(attempt * 2);
      await wait(2_000);
      await settle();
      expect(resend()).toHaveBeenCalledTimes((attempt + 1) * 2);
    }

    const toast = useToastStore.getState().current;
    expect(toast?.message).toBe("2 members haven't been added yet.");
    expect(toast?.action?.label).toBe('Retry');
    // No more resends of its own, ever.
    await wait(60 * 60_000);
    appStateListeners.forEach((l) => l('background'));
    appStateListeners.forEach((l) => l('active'));
    await settle();
    expect(resend()).toHaveBeenCalledTimes(MAX_ATTEMPTS * 2);

    // Retry is the user's: it starts again, for both.
    act(() => toast?.action?.onPress());
    await settle();
    await settle();
    expect(resend()).toHaveBeenCalledTimes(MAX_ATTEMPTS * 2 + 2);
  });

  it('asks the engine about a resend it never heard the end of, past the deadline (a restart)', async () => {
    resendTickets();
    fakeEngine.method('writes.get').mockResolvedValue(null);
    queueKeyResend(ALICE, GROUP, [BOB]);
    await settle();
    // Under the 6-minute mark it is still running: nothing is asked, nothing sent.
    await wait(5 * 60_000);
    resendMissingKeys(GROUP);
    await settle();
    expect(fakeEngine.method('writes.get')).not.toHaveBeenCalled();
    await wait(2 * 60_000);
    resendMissingKeys(GROUP);
    await settle();
    expect(fakeEngine.method('writes.get')).toHaveBeenCalledTimes(1);
    // The engine no longer has it: an attempt used up, and the next goes after the backoff.
    expect(resend()).toHaveBeenCalledTimes(1);
    await wait(BACKOFF_MS[0] + 1_000);
    await settle();
    expect(resend()).toHaveBeenCalledTimes(2);
  });

  it('says "1 member" for one', async () => {
    const issued = resendTickets();
    queueKeyResend(ALICE, GROUP, [BOB]);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await settle();
      await emit(advance(issued[attempt], { state: 'failed', retryable: true }));
      await wait(BACKOFF_MS[BACKOFF_MS.length - 1]);
    }
    expect(useToastStore.getState().current?.message).toBe("1 member hasn't been added yet.");
  });

  it('drops a member the engine says no longer needs the key (left, removed, group ended)', async () => {
    resend().mockRejectedValue(Object.assign(new Error('They are not in this group.'), { code: 'BAD_REQUEST' }));
    queueKeyResend(ALICE, GROUP, [BOB]);
    await settle();
    await wait(60 * 60_000);
    appStateListeners.forEach((l) => l('background'));
    appStateListeners.forEach((l) => l('active'));
    await settle();
    expect(resend()).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().current).toBeNull();
  });

  it("waits while another account is active: the engine would sign as that one", async () => {
    resendTickets();
    useSessionStore.setState({ status: 'signed-in', session: session(CAROL), accounts: [] });
    queueKeyResend(ALICE, GROUP, [BOB]);
    await settle();
    expect(resend()).not.toHaveBeenCalled();

    useSessionStore.setState({ status: 'signed-in', session: session(ALICE), accounts: [] });
    appStateListeners.forEach((l) => l('background'));
    appStateListeners.forEach((l) => l('active'));
    await settle();
    expect(resend()).toHaveBeenCalledWith(GROUP, BOB);
  });

  it('queues only the members a confirmed creation says it missed', async () => {
    resendTickets();
    const created = ticket({ op: 'dm.group' });
    fakeEngine.method('dm.createdGroup').mockResolvedValue({ key: GROUP, failed: [CAROL] });
    followGroupCreation(ALICE, created.id);
    await emit(advance(created, { state: 'unconfirmed', retryable: false }));
    await settle();
    expect(fakeEngine.method('dm.createdGroup')).not.toHaveBeenCalled();
    await emit(advance(created, { state: 'confirmed' }));
    await settle();
    await settle();
    expect(resend()).toHaveBeenCalledTimes(1);
    expect(resend()).toHaveBeenCalledWith(GROUP, CAROL);
  });

  it('queues nothing for a creation that failed', async () => {
    const created = ticket({ op: 'dm.group' });
    followGroupCreation(ALICE, created.id);
    await emit(advance(created, { state: 'failed', retryable: true }));
    await settle();
    expect(fakeEngine.method('dm.createdGroup')).not.toHaveBeenCalled();
    expect(resend()).not.toHaveBeenCalled();
  });
});
