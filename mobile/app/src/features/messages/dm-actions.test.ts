import type { EngineErrorData, SessionDTO, WriteTicket } from '@engine/api';
import { act } from '@testing-library/react-native';

import { useSessionStore } from '~/data/session';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { resetWriteTracking, startWriteTracking } from '~/data/writes';

import { hideWhileLeaving, useLocallyHidden } from './dm-actions';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);

const ALICE = 'AliceId111111111111111111111111111111111111';
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

const error = (outcome: EngineErrorData['outcome']): EngineErrorData => ({
  code: outcome === 'unknown' ? 'UNKNOWN' : 'RULE_VIOLATION',
  consensusCode: null,
  outcome,
  retryable: false,
  userMessage: '',
});

const hidden = () => useLocallyHidden.getState().keys[GROUP] === true;
const emit = (next: WriteTicket) => act(() => fakeEngine.emit('write.status', next));

let stopTracking: () => void;

beforeEach(() => {
  fakeEngine.reset();
  resetWriteTracking();
  stopTracking = startWriteTracking();
  useLocallyHidden.setState({ keys: {} });
  useSessionStore.setState({ status: 'signed-in', session: session(ALICE), accounts: [] });
});

afterEach(() => {
  stopTracking();
  resetWriteTracking();
});

describe('hideWhileLeaving (#8)', () => {
  const leaving = () => ticket({ op: 'dm.group', identityId: ALICE, target: { conversationKey: GROUP } });

  it('brings the group back when the leave is refused', async () => {
    const left = leaving();
    hideWhileLeaving(GROUP, left.id);
    expect(hidden()).toBe(true);
    await emit(advance(left, { state: 'failed', error: error('refused') }));
    expect(hidden()).toBe(false);
  });

  it('reads a leave that settled before it listened', async () => {
    const left = leaving();
    await emit(advance(left, { state: 'failed', error: error('refused') }));
    hideWhileLeaving(GROUP, left.id);
    expect(hidden()).toBe(false);
  });

  it('keeps it out when the leave may have landed (failed with an unknown outcome)', async () => {
    const left = leaving();
    hideWhileLeaving(GROUP, left.id);
    await emit(advance(left, { state: 'failed', error: error('unknown') }));
    expect(hidden()).toBe(true);
  });

  it('brings it back when the account changes first', async () => {
    const left = leaving();
    hideWhileLeaving(GROUP, left.id);
    act(() => useSessionStore.setState({ session: session(CAROL) }));
    expect(hidden()).toBe(false);
    // And stops listening: a later word about the old account's leave changes nothing.
    hideWhileLeaving(GROUP, 'another');
    await emit(advance(left, { state: 'failed', error: error('refused') }));
    expect(hidden()).toBe(true);
  });

  it('lets the engine keep it out once the leave is confirmed', async () => {
    const left = leaving();
    hideWhileLeaving(GROUP, left.id);
    await emit(advance(left, { state: 'confirmed' }));
    await act(async () => {});
    expect(hidden()).toBe(false);
  });
});
