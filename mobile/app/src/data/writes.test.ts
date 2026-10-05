import type { ProfileDTO, SessionDTO, TargetRef, WriteTicket } from '@engine/api';
import { defaultScheduler, notifyManager } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';

import * as WebBrowser from 'expo-web-browser';

import { queryClient } from '~/state/query-client';
import { useToastStore } from '~/ui/toast';

import { deleteWrite, followWrite } from '~/features/post/post-writes';

import { useSignInPrompt } from './require-auth';
import { SESSION_EXPIRED_MESSAGE, isSessionExpired, setReauthHandler, useExpiredSessions } from './session-expiry';
import { getLogs } from '~/engine/logs';

import { queryKeys } from './keys';
import { isExhausted, ticketJob } from './reconcile';
import { advance, fakeEngine, ticket } from './testing/fake-engine';
import { useSessionStore } from './session';
import { adoptRestoredWrites, OFFLINE_MESSAGE, resetWriteTracking, retryWrite, runWrite, submitWrite, useWrite, type WriteSpec } from './writes';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
let mockOffline = false;
jest.mock('./connectivity', () => ({ isOffline: () => mockOffline, startConnectivity: () => () => undefined }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })) }));

/** A fresh post per test: a write left pending would hold its key. */
let target: TargetRef;
let postNumber = 0;

const undo = jest.fn();
const apply = jest.fn(() => undo);
const confirmed = jest.fn();
const spec: WriteSpec<TargetRef> = {
  key: (t) => `like:${t.id}`,
  submit: (api, t) => api.engage.like(t),
  optimistic: apply,
  failureMessage: "Couldn't like this post. Try again.",
  onConfirmed: confirmed,
};

const currentToast = () => useToastStore.getState().current;

/** As the engine answers `writes.check` / `retry`: the `write.status` event first, then the result. */
function answer(path: string, next: WriteTicket) {
  fakeEngine.method(path).mockImplementationOnce(async () => {
    fakeEngine.emit('write.status', next);
    return next;
  });
}

/** Submits `spec` with the engine answering `pending`; returns that ticket. */
async function submitPending(overrides: Partial<WriteTicket> = {}): Promise<WriteTicket> {
  const pending = ticket(overrides);
  fakeEngine.method('engage.like').mockResolvedValueOnce(pending);
  await expect(submitWrite(spec, target)).resolves.toEqual(pending);
  return pending;
}

beforeEach(() => {
  postNumber += 1;
  target = { id: `p${postNumber}`, kind: 'post', ownerId: 'author', rootPostId: null };
  jest.clearAllMocks();
  fakeEngine.reset();
  // No reconciler job (or its timers) of an earlier test runs into this one.
  resetWriteTracking();
  useToastStore.setState({ current: null });
  useSignInPrompt.setState({ open: false });
  useExpiredSessions.setState({ ids: [] });
  mockOffline = false;
});

describe('submitWrite', () => {
  it('applies the change at once and keeps it when the write confirms', async () => {
    const pending = await submitPending();
    expect(apply).toHaveBeenCalledWith(target);
    expect(fakeEngine.method('engage.like')).toHaveBeenCalledWith(target);

    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    expect(undo).not.toHaveBeenCalled();
    expect(confirmed).toHaveBeenCalledWith(expect.objectContaining({ id: pending.id, state: 'confirmed' }), target);
    expect(currentToast()).toBeNull();
  });

  it("undoes a failed write and toasts the write's own sentence with Retry, which re-applies and re-sends", async () => {
    const pending = await submitPending();
    const failed = advance(pending, {
      state: 'failed',
      retryable: true,
      error: {
        code: 'FEE_UNPAYABLE',
        consensusCode: 40701,
        outcome: 'refused',
        retryable: true,
        userMessage: 'The gas sponsor is short. Switch to paying in credits.',
      },
    });
    act(() => fakeEngine.emit('write.status', failed));

    expect(undo).toHaveBeenCalledTimes(1);
    // Web's text (a payment setting the app does not have) goes to diagnostics only.
    expect(currentToast()).toMatchObject({ kind: 'error', message: "Couldn't like this post. Try again.", action: { label: 'Retry' } });
    expect(getLogs().some((line) => line.message.includes('FEE_UNPAYABLE 40701: The gas sponsor is short'))).toBe(true);

    answer('writes.retry', advance(failed, { state: 'pending', error: null }));
    await act(async () => currentToast()?.action?.onPress());
    expect(fakeEngine.method('writes.retry')).toHaveBeenCalledWith(pending.id);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("uses the spec's message when the engine's is generic, and offers no Retry for a refusal", async () => {
    const pending = await submitPending();
    act(() =>
      fakeEngine.emit(
        'write.status',
        advance(pending, {
          state: 'failed',
          error: { code: 'UNKNOWN', consensusCode: null, outcome: 'refused', retryable: false, userMessage: 'Something went wrong' },
        }),
      ),
    );
    expect(currentToast()).toMatchObject({ message: "Couldn't like this post. Try again.", action: undefined });
  });

  describe('an unconfirmed write (PRD G-3)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('keeps it quietly, checks it by itself, and undoes it once a check proves it absent', async () => {
      const pending = await submitPending();
      const unconfirmed = advance(pending, { state: 'unconfirmed' });
      act(() => fakeEngine.emit('write.status', unconfirmed));
      expect(undo).not.toHaveBeenCalled();
      // Nothing for the user to do: no "Not confirmed yet", no Check again.
      expect(currentToast()).toBeNull();

      const show = jest.spyOn(useToastStore.getState(), 'show');
      answer('writes.check', advance(unconfirmed, { retryable: true, lastCheckedAt: new Date() }));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5_000);
      });
      expect(fakeEngine.method('writes.check')).toHaveBeenCalledWith(pending.id);
      expect(undo).toHaveBeenCalledTimes(1);
      // The event and the call's answer are one outcome: one toast, the same sentence as a refusal.
      expect(show).toHaveBeenCalledTimes(1);
      expect(currentToast()).toMatchObject({ kind: 'error', message: "Couldn't like this post. Try again.", action: { label: 'Retry' } });
      expect(isExhausted(ticketJob(pending.id))).toBe(false);
    });

    it('checks it again at 5, 20, 80 and 130 s, then says nothing more, and settles when a check finds it', async () => {
      const pending = await submitPending();
      const unconfirmed = advance(pending, { state: 'unconfirmed' });
      act(() => fakeEngine.emit('write.status', unconfirmed));
      const check = fakeEngine.method('writes.check');
      check.mockImplementation(async () => ({ ...unconfirmed, lastCheckedAt: new Date() }));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(130_000);
      });
      expect(check).toHaveBeenCalledTimes(4);
      expect(isExhausted(ticketJob(pending.id))).toBe(true);
      expect(currentToast()).toBeNull();
      expect(undo).not.toHaveBeenCalled();

      // A later check (the app back in the foreground, a feed read) finds it: done, quietly.
      act(() => fakeEngine.emit('write.status', advance(unconfirmed, { state: 'confirmed' })));
      expect(confirmed).toHaveBeenCalledTimes(1);
      expect(isExhausted(ticketJob(pending.id))).toBe(false);
      expect(currentToast()).toBeNull();
    });

    it('never runs out of checks while its call still runs past the deadline (STILL_SENDING)', async () => {
      const pending = await submitPending();
      const stalled = advance(pending, {
        state: 'unconfirmed',
        error: { code: 'STILL_SENDING', consensusCode: null, outcome: 'unknown', retryable: false, userMessage: 'x' },
      });
      act(() => fakeEngine.emit('write.status', stalled));
      fakeEngine.method('writes.check').mockImplementation(async () => ({ ...stalled, lastCheckedAt: new Date() }));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(130_000);
      });
      expect(isExhausted(ticketJob(pending.id))).toBe(false);
    });

    it('keeps a failure that may have landed (outcome unknown) quietly: never "Couldn\'t…", never undone', async () => {
      const pending = await submitPending();
      act(() =>
        fakeEngine.emit(
          'write.status',
          advance(pending, {
            state: 'failed',
            error: { code: 'UNKNOWN', consensusCode: null, outcome: 'unknown', retryable: false, userMessage: 'x' },
          }),
        ),
      );
      expect(undo).not.toHaveBeenCalled();
      expect(currentToast()).toBeNull();
      // The key is free for the next write.
      await submitPending();
    });

    it("never checks another account's ticket", async () => {
      useSessionStore.setState({ status: 'signed-in', session: { identityId: 'me' } as SessionDTO });
      try {
        act(() => fakeEngine.emit('write.status', ticket({ identityId: 'someone-else', state: 'unconfirmed' })));
        await act(async () => {
          await jest.advanceTimersByTimeAsync(130_000);
        });
        expect(fakeEngine.method('writes.check')).not.toHaveBeenCalled();
      } finally {
        useSessionStore.setState({ status: 'unknown', session: null });
      }
    });
  });

  it('keeps a failure that arrived before the call’s pending answer (same millisecond)', async () => {
    const pending = ticket();
    fakeEngine.method('engage.like').mockImplementationOnce(async () => {
      fakeEngine.emit('write.status', { ...pending, state: 'failed', error: null });
      return pending;
    });
    await act(async () => {
      await submitWrite(spec, target);
    });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(currentToast()).toMatchObject({ kind: 'error' });
    // The key is free again.
    await submitPending();
  });

  it('retries only the latest write for a key, and not while another is in flight', async () => {
    const first = await submitPending();
    const failed = advance(first, { state: 'failed', retryable: true, error: null });
    act(() => fakeEngine.emit('write.status', failed));
    const staleRetry = currentToast()?.action;
    await submitPending();

    act(() => useToastStore.setState({ current: null }));
    await act(async () => staleRetry?.onPress());
    expect(fakeEngine.method('writes.retry')).not.toHaveBeenCalled();
    // A stale Retry does nothing, and says nothing.
    expect(currentToast()).toBeNull();
  });

  it('gives the key back to a write that may land when the one after it is refused unsent, and its Retry takes it again', async () => {
    const first = await submitPending();
    const maybe = advance(first, { state: 'unconfirmed' });
    act(() => fakeEngine.emit('write.status', maybe));
    const second = await submitPending();
    const notSent = { code: 'NETWORK', consensusCode: null, outcome: 'not-sent', retryable: true, userMessage: 'Network error.' } as const;
    act(() => fakeEngine.emit('write.status', advance(second, { state: 'failed', retryable: true, error: notSent })));
    const retrySecond = currentToast()?.action;
    expect(retrySecond?.label).toBe('Retry');

    // The first proved absent still decides: undone, with its own failure and Retry.
    undo.mockClear();
    act(() => useToastStore.setState({ current: null }));
    const absent = advance(maybe, {
      state: 'unconfirmed',
      retryable: true,
      error: { code: 'NOT_RECORDED', consensusCode: null, outcome: 'not-recorded', retryable: true, userMessage: 'Checked.' },
    });
    act(() => fakeEngine.emit('write.status', absent));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(currentToast()).toMatchObject({ kind: 'error', message: "Couldn't like this post. Try again." });

    // The refused write's Retry still sends it, and makes it the latest again.
    answer('writes.retry', advance(second, { state: 'pending', retryable: false, error: null }));
    await act(async () => retrySecond?.onPress());
    expect(fakeEngine.method('writes.retry')).toHaveBeenCalledWith(second.id);
    const firstRetry = currentToast()?.action;
    act(() => useToastStore.setState({ current: null }));
    await act(async () => firstRetry?.onPress());
    expect(fakeEngine.method('writes.retry')).toHaveBeenCalledTimes(1);
  });

  it('reports an absence proved while a newer write held the key, once that newer write is refused unsent', async () => {
    const first = await submitPending();
    const maybe = advance(first, { state: 'unconfirmed' });
    act(() => fakeEngine.emit('write.status', maybe));
    const second = await submitPending();
    undo.mockClear();

    // The first is proved absent while the second holds the key: nothing said or undone yet.
    const absent = advance(maybe, {
      state: 'unconfirmed',
      retryable: true,
      error: { code: 'NOT_RECORDED', consensusCode: null, outcome: 'not-recorded', retryable: true, userMessage: 'Checked.' },
    });
    act(() => fakeEngine.emit('write.status', absent));
    expect(undo).not.toHaveBeenCalled();
    expect(currentToast()).toBeNull();

    // The second is refused before anything went out: the first's absence is reported now.
    const notSent = { code: 'NETWORK', consensusCode: null, outcome: 'not-sent', retryable: true, userMessage: 'Network error.' } as const;
    act(() => fakeEngine.emit('write.status', advance(second, { state: 'failed', retryable: true, error: notSent })));
    // Both changes undone: the second's, then the first's.
    expect(undo).toHaveBeenCalledTimes(2);
    expect(currentToast()).toMatchObject({ kind: 'error', message: "Couldn't like this post. Try again." });
    const retryFirst = currentToast()?.action;

    // Once only: the same event again changes nothing.
    act(() => useToastStore.setState({ current: null }));
    act(() => fakeEngine.emit('write.status', absent));
    expect(undo).toHaveBeenCalledTimes(2);
    expect(currentToast()).toBeNull();

    answer('writes.retry', advance(absent, { state: 'pending', retryable: false, error: null }));
    await act(async () => retryFirst?.onPress());
    expect(fakeEngine.method('writes.retry')).toHaveBeenCalledWith(first.id);
  });

  it('acts on a status that overtook the call’s answer', async () => {
    const pending = ticket();
    fakeEngine.method('engage.like').mockImplementationOnce(async () => {
      fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' }));
      return pending;
    });
    await act(async () => {
      await submitWrite(spec, target);
    });
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it('queues a write made while its key is pending, and sends it once that confirms', async () => {
    const toggle: WriteSpec<{ target: TargetRef; on: boolean }> = {
      key: ({ target: t }) => `like:${t.id}`,
      submit: (api, { target: t, on }) => (on ? api.engage.like(t) : api.engage.unlike(t)),
      optimistic: apply,
      intent: ({ on }) => on,
      failureMessage: "Couldn't like this post. Try again.",
    };
    const like = ticket();
    fakeEngine.method('engage.like').mockResolvedValueOnce(like);
    await expect(runWrite(toggle, { target, on: true })).resolves.toMatchObject({ status: 'submitted' });

    // Unlike while the like is pending: applied at once, sent later.
    await expect(runWrite(toggle, { target, on: false })).resolves.toEqual({ status: 'queued' });
    expect(apply).toHaveBeenCalledTimes(2);
    expect(fakeEngine.method('engage.unlike')).not.toHaveBeenCalled();

    fakeEngine.method('engage.unlike').mockResolvedValueOnce(ticket({ op: 'unlike' }));
    await act(async () => fakeEngine.emit('write.status', advance(like, { state: 'confirmed' })));
    expect(fakeEngine.method('engage.unlike')).toHaveBeenCalledWith(target);
    // Its optimistic change was applied when it was made, not again.
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('keeps a released queued write busy when the confirmation beats the call’s answer', async () => {
    const toggle: WriteSpec<{ on: boolean }> = {
      key: () => `like:${target.id}`,
      submit: (api, { on }) => (on ? api.engage.like(target) : api.engage.unlike(target)),
      intent: ({ on }) => on,
      failureMessage: 'x',
    };
    const like = ticket();
    let answer: (t: WriteTicket) => void = () => undefined;
    fakeEngine.method('engage.like').mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const first = runWrite(toggle, { on: true });
    await expect(runWrite(toggle, { on: false })).resolves.toEqual({ status: 'queued' });

    // The unlike, once released, stays in flight.
    fakeEngine.method('engage.unlike').mockImplementationOnce(() => new Promise(() => undefined));
    await act(async () => {
      fakeEngine.emit('write.status', advance(like, { state: 'confirmed' }));
      answer(like);
      await first;
    });
    expect(fakeEngine.method('engage.unlike')).toHaveBeenCalledTimes(1);
    await expect(runWrite(toggle, { on: true })).resolves.toEqual({ status: 'queued' });
    expect(fakeEngine.method('engage.like')).toHaveBeenCalledTimes(1);
  });

  it('keeps a key busy while its call still runs past the engine\'s deadline (STILL_SENDING), then sends what was queued', async () => {
    const toggle: WriteSpec<{ on: boolean }> = {
      key: () => `like:${target.id}`,
      submit: (api, { on }) => (on ? api.engage.like(target) : api.engage.unlike(target)),
      optimistic: apply,
      intent: ({ on }) => on,
      failureMessage: 'x',
    };
    const like = ticket();
    fakeEngine.method('engage.like').mockResolvedValueOnce(like);
    await runWrite(toggle, { on: true });
    await expect(runWrite(toggle, { on: false })).resolves.toEqual({ status: 'queued' });

    // A minute without an answer: unconfirmed, but the like's call still runs. The unlike would race it.
    const stalled = advance(like, {
      state: 'unconfirmed',
      error: { code: 'STILL_SENDING', consensusCode: null, outcome: 'unknown', retryable: false, userMessage: 'x' },
    });
    await act(async () => fakeEngine.emit('write.status', stalled));
    expect(fakeEngine.method('engage.unlike')).not.toHaveBeenCalled();
    // A tap meanwhile queues too (back to what the like asks: nothing more to send).
    await expect(runWrite(toggle, { on: true })).resolves.toEqual({ status: 'queued' });
    await expect(runWrite(toggle, { on: false })).resolves.toEqual({ status: 'queued' });

    // The call answers: the queued unlike goes out once.
    fakeEngine.method('engage.unlike').mockResolvedValueOnce(ticket({ op: 'unlike' }));
    await act(async () => fakeEngine.emit('write.status', advance(stalled, { state: 'confirmed', error: null })));
    expect(fakeEngine.method('engage.unlike')).toHaveBeenCalledTimes(1);
    expect(fakeEngine.method('engage.like')).toHaveBeenCalledTimes(1);
  });

  it('drops a queued write that asks for what the pending one asked (like, unlike, like)', async () => {
    const toggle: WriteSpec<{ on: boolean }> = {
      key: () => `like:${target.id}`,
      submit: (api, { on }) => (on ? api.engage.like(target) : api.engage.unlike(target)),
      optimistic: apply,
      intent: ({ on }) => on,
      failureMessage: 'x',
    };
    const like = ticket();
    fakeEngine.method('engage.like').mockResolvedValueOnce(like);
    await runWrite(toggle, { on: true });
    await runWrite(toggle, { on: false });
    await runWrite(toggle, { on: true });
    await act(async () => fakeEngine.emit('write.status', advance(like, { state: 'confirmed' })));
    expect(fakeEngine.method('engage.unlike')).not.toHaveBeenCalled();
    expect(fakeEngine.method('engage.like')).toHaveBeenCalledTimes(1);
  });

  it('keeps the change when the engine restarts under the call, then adopts the restored ticket', async () => {
    const onAdopted = jest.fn();
    const matching = {
      ...spec,
      matches: (t: WriteTicket, vars: TargetRef) => t.op === 'like' && t.target === vars,
      onAdopted,
    };
    fakeEngine.method('engage.like').mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENGINE_RESTARTED' }));
    const result = await runWrite(matching, target);
    expect(result.status).toBe('unknown');
    expect(undo).not.toHaveBeenCalled();
    expect(currentToast()).toBeNull();

    // The next engine restores it as unconfirmed, then a check proves it absent.
    const restored = ticket({ state: 'unconfirmed', target });
    fakeEngine.method('writes.list').mockResolvedValueOnce([restored]);
    await act(async () => {
      await adoptRestoredWrites();
    });
    expect(onAdopted).toHaveBeenCalledWith(restored, target);
    act(() => fakeEngine.emit('write.status', advance(restored, { retryable: true, lastCheckedAt: new Date() })));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(currentToast()).toMatchObject({ message: "Couldn't like this post. Try again." });
  });

  it('adopts the ticket of a call that timed out long after the engine made it (SR-16)', async () => {
    const onAdopted = jest.fn();
    const matching = {
      ...spec,
      matches: (t: WriteTicket, vars: TargetRef) => t.op === 'like' && t.target === vars,
      onAdopted,
    };
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    try {
      fakeEngine.method('engage.like').mockImplementationOnce(async () => {
        // The engine made its ticket at once; the call gave up waiting 15 s later.
        clock.mockReturnValue(start + 15_000);
        throw Object.assign(new Error('timed out'), { code: 'ENGINE_TIMEOUT' });
      });
      expect((await runWrite(matching, target)).status).toBe('unknown');
      const made = ticket({ state: 'unconfirmed', target, createdAt: new Date(start + 500) });
      fakeEngine.method('writes.list').mockResolvedValueOnce([made]);
      await act(async () => {
        await adoptRestoredWrites();
      });
      expect(onAdopted).toHaveBeenCalledWith(made, target);
    } finally {
      clock.mockRestore();
    }
  });

  it("never adopts another write's ticket that already settled, when it is listed again", async () => {
    const onAdopted = jest.fn();
    // As `dm.send`: any ticket of the op could be the cut-short call's.
    const matching = { ...spec, matches: (t: WriteTicket) => t.op === 'like', onAdopted };
    fakeEngine.method('engage.like').mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENGINE_RESTARTED' }));
    expect((await runWrite(matching, target)).status).toBe('unknown');

    // A later write lands and settles.
    const other: TargetRef = { ...target, id: `${target.id}-other` };
    const later = ticket({ target: other });
    fakeEngine.method('engage.like').mockResolvedValueOnce(later);
    expect((await runWrite(matching, other)).status).toBe('submitted');
    act(() => fakeEngine.emit('write.status', advance(later, { state: 'confirmed' })));

    fakeEngine.method('writes.list').mockResolvedValueOnce([advance(later, { state: 'confirmed' })]);
    await act(async () => {
      await adoptRestoredWrites();
    });
    expect(onAdopted).not.toHaveBeenCalled();
  });

  it('undoes and toasts a refused call, and asks to sign in for NOT_SIGNED_IN', async () => {
    fakeEngine.method('engage.like').mockRejectedValueOnce(Object.assign(new Error('bad'), { code: 'BAD_REQUEST' }));
    await expect(runWrite(spec, target)).resolves.toMatchObject({ status: 'refused' });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(currentToast()).toMatchObject({ kind: 'error', message: "Couldn't like this post. Try again." });

    act(() => useToastStore.setState({ current: null }));
    fakeEngine.method('engage.like').mockRejectedValueOnce(Object.assign(new Error('no'), { code: 'NOT_SIGNED_IN' }));
    await expect(submitWrite(spec, target)).resolves.toBeNull();
    expect(useSignInPrompt.getState().open).toBe(true);
    expect(currentToast()).toBeNull();
  });

  it('sends nothing while offline: no change, and the offline toast (PRD G-1)', async () => {
    mockOffline = true;
    await expect(runWrite(spec, target)).resolves.toMatchObject({ status: 'refused', error: { code: 'OFFLINE' } });
    expect(apply).not.toHaveBeenCalled();
    expect(fakeEngine.method('engage.like')).not.toHaveBeenCalled();
    expect(currentToast()).toMatchObject({ message: OFFLINE_MESSAGE });
  });

  it('says what a code the user can act on means, in mobile copy (UX_SPEC §5.4)', async () => {
    const refusal = (code: 'TARGET_GONE' | 'NOT_OWNER' | 'STALE' | 'BUILD_DEFECT', userMessage: string) => ({
      code,
      consensusCode: 40100,
      outcome: 'refused' as const,
      retryable: false,
      userMessage,
    });
    for (const [code, web, mobile] of [
      ['TARGET_GONE', 'The post you are responding to was not found.', 'This post no longer exists.'],
      ['NOT_OWNER', 'Only the owner can do this.', "You can't do this from this account."],
      ['STALE', 'Something changed. Please reload the page and try again.', 'Update Yappr and try again.'],
      ['BUILD_DEFECT', 'Something went wrong building this action, so the network refused it.', 'Something went wrong. Nothing was charged. Please report this.'],
    ] as const) {
      target = { ...target, id: `${target.id}-${code}` };
      const pending = await submitPending();
      act(() => fakeEngine.emit('write.status', advance(pending, { state: 'failed', error: refusal(code, web) })));
      expect(currentToast()?.message).toBe(mobile);
    }
  });

  it('says credits or YAPP are short in the mobile copy, with no Retry (PRD G-5)', async () => {
    const short = (code: 'INSUFFICIENT_CREDITS' | 'INSUFFICIENT_YAPP') => ({
      code,
      consensusCode: null,
      outcome: 'refused' as const,
      retryable: false,
      userMessage: "You don't have enough YAPP. Buy more to continue.",
    });
    const credits = await submitPending();
    act(() => fakeEngine.emit('write.status', advance(credits, { state: 'failed', error: short('INSUFFICIENT_CREDITS') })));
    expect(currentToast()).toMatchObject({
      kind: 'error',
      message: "You don't have enough credits for this. Top up from your Dash wallet.",
    });
    expect(currentToast()?.action).toBeUndefined();

    target = { ...target, id: `${target.id}-yapp` };
    const yapp = await submitPending();
    act(() => fakeEngine.emit('write.status', advance(yapp, { state: 'failed', error: short('INSUFFICIENT_YAPP') })));
    expect(currentToast()).toMatchObject({
      message: 'You need YAPP for this.',
      action: { label: 'Get YAPP' },
    });
    act(() => currentToast()?.action?.onPress());
    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/yap\.pr/));
  });

  it('says the session expired and marks the account when its key no longer signs (AUTH-14)', async () => {
    const refusedKey = {
      code: 'KEY_REVOKED' as const,
      consensusCode: 20006,
      outcome: 'refused' as const,
      retryable: false,
      userMessage: 'Failed to create post: Identity key 2 is disabled',
    };
    const reauth = jest.fn();
    const unregister = setReauthHandler(reauth);
    try {
      const pending = await submitPending({ identityId: 'alice' });
      act(() => fakeEngine.emit('write.status', advance(pending, { state: 'failed', error: refusedKey })));
      expect(undo).toHaveBeenCalledTimes(1);
      expect(isSessionExpired('alice')).toBe(true);
      // No Retry: it would fail the same way. "Sign in" opens the flow for that account.
      expect(currentToast()).toMatchObject({ kind: 'error', message: SESSION_EXPIRED_MESSAGE, action: { label: 'Sign in' } });
      act(() => currentToast()?.action?.onPress());
      expect(reauth).toHaveBeenCalledWith('alice');

      // A missing key says the same, though the engine would allow a retry.
      target = { ...target, id: `${target.id}-nokey` };
      const missing = await submitPending({ identityId: 'bob' });
      const noKey = { ...refusedKey, code: 'NO_KEY' as const, consensusCode: null, outcome: 'not-sent' as const, retryable: true };
      act(() => fakeEngine.emit('write.status', advance(missing, { state: 'failed', retryable: true, error: noKey })));
      expect(isSessionExpired('bob')).toBe(true);
      expect(currentToast()).toMatchObject({ message: SESSION_EXPIRED_MESSAGE, action: { label: 'Sign in' } });

      // Messages' NO_KEY is the encryption key: not the session.
      target = { ...target, id: `${target.id}-dm` };
      const dm = await submitPending({ identityId: 'carol', op: 'dm.send' });
      act(() => fakeEngine.emit('write.status', advance(dm, { state: 'failed', retryable: true, error: noKey })));
      expect(isSessionExpired('carol')).toBe(false);
      expect(currentToast()?.message).not.toBe(SESSION_EXPIRED_MESSAGE);
    } finally {
      unregister();
    }
  });

  it('marks the account from any failed ticket it hears of, untracks it, and from a refused call (AUTH-14)', async () => {
    const revoked = { code: 'KEY_REVOKED' as const, consensusCode: 20003, outcome: 'refused' as const, retryable: false, userMessage: 'x' };
    // A ticket no spec follows (another screen's, or restored after a restart).
    act(() => fakeEngine.emit('write.status', ticket({ identityId: 'dave', state: 'failed', op: 'follow', error: revoked })));
    expect(isSessionExpired('dave')).toBe(true);

    // A retryable NO_KEY failure is not kept for a Retry that would fail the same way.
    const pending = await submitPending({ identityId: 'erin' });
    const noKey = { ...revoked, code: 'NO_KEY' as const, consensusCode: null, outcome: 'not-sent' as const, retryable: true };
    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'failed', retryable: true, error: noKey })));
    await expect(retryWrite(pending.id)).resolves.toBeNull();
    expect(fakeEngine.method('writes.retry')).not.toHaveBeenCalled();

    // Refused before any ticket, for the key itself.
    useSessionStore.setState({ status: 'signed-in', session: { identityId: 'frank' } as SessionDTO });
    target = { ...target, id: `${target.id}-refused` };
    fakeEngine.method('engage.like').mockRejectedValueOnce(Object.assign(new Error('Identity key 2 is disabled'), { code: 'KEY_REVOKED' }));
    await expect(runWrite(spec, target)).resolves.toMatchObject({ status: 'refused' });
    expect(isSessionExpired('frank')).toBe(true);
    expect(currentToast()).toMatchObject({ message: SESSION_EXPIRED_MESSAGE, action: { label: 'Sign in' } });
  });

  it('drops a write queued behind a call the engine cut short: undone, never sent to the next engine', async () => {
    const toggle: WriteSpec<{ on: boolean }> = {
      key: () => `like:${target.id}`,
      submit: (api, { on }) => (on ? api.engage.like(target) : api.engage.unlike(target)),
      optimistic: apply,
      intent: ({ on }) => on,
      failureMessage: 'x',
    };
    let cut: (error: unknown) => void = () => undefined;
    fakeEngine.method('engage.like').mockImplementationOnce(() => new Promise((_resolve, reject) => (cut = reject)));
    const first = runWrite(toggle, { on: true });
    await expect(runWrite(toggle, { on: false })).resolves.toEqual({ status: 'queued' });

    await act(async () => {
      cut(Object.assign(new Error('The engine restarted'), { code: 'ENGINE_RESTARTED' }));
      await expect(first).resolves.toMatchObject({ status: 'unknown' });
    });
    expect(fakeEngine.method('engage.unlike')).not.toHaveBeenCalled();
    // The queued unlike's change is undone; the cut-short like's stays (it may have landed).
    expect(undo).toHaveBeenCalledTimes(1);
    expect(currentToast()).toMatchObject({ kind: 'error', message: 'x' });
  });

  it('sends one delete for a second delete made while the first is pending', async () => {
    const own: TargetRef = { ...target, ownerId: 'viewer' };
    const pending = ticket({ op: 'post.delete', target: own });
    fakeEngine.method('posts.delete').mockResolvedValueOnce(pending);
    await expect(runWrite(deleteWrite, { target: own })).resolves.toMatchObject({ status: 'submitted' });
    await expect(runWrite(deleteWrite, { target: own })).resolves.toEqual({ status: 'queued' });
    await act(async () => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    expect(fakeEngine.method('posts.delete')).toHaveBeenCalledTimes(1);
  });

  it('lets the spec handle a refusal itself', async () => {
    const onRejected = jest.fn(() => true);
    fakeEngine.method('engage.like').mockRejectedValueOnce(Object.assign(new Error('q'), { code: 'QUOTE_HAS_TEXT' }));
    await submitWrite({ ...spec, onRejected }, target);
    expect(onRejected).toHaveBeenCalledWith(expect.objectContaining({ code: 'QUOTE_HAS_TEXT' }), target);
    expect(currentToast()).toBeNull();
  });
});

describe('a read that lands while a write is on its way', () => {
  const author = 'author-id';
  const profileKey = queryKeys.profile.detail(author);
  const profileReading = (follows: boolean, followers: number) =>
    ({ id: author, hasProfile: true, stats: { posts: 1, followers, following: 0 }, viewer: { follows, blocks: false, isSelf: false } }) as Partial<ProfileDTO>;
  /** The profile screen opened again: a fresh read of the chain. */
  const reopen = (follows: boolean, followers: number) =>
    act(async () => {
      await queryClient.fetchQuery({ queryKey: profileKey, queryFn: async () => profileReading(follows, followers), staleTime: 0 });
    });
  const shown = () => queryClient.getQueryData<Partial<ProfileDTO>>(profileKey);

  beforeAll(() => notifyManager.setScheduler((cb) => cb()));
  beforeEach(() => queryClient.clear());
  afterAll(() => {
    queryClient.clear();
    notifyManager.setScheduler(defaultScheduler);
  });

  it('keeps an unfollow queued behind a pending follow when the reopened profile reads the follow back', async () => {
    queryClient.setQueryData(profileKey, profileReading(false, 10));
    const follow = ticket({ op: 'follow', target: { identityId: author } });
    fakeEngine.method('graph.follow').mockResolvedValueOnce(follow);
    await expect(runWrite(followWrite, { authorId: author, follow: true })).resolves.toMatchObject({ status: 'submitted' });
    expect(shown()).toMatchObject({ viewer: { follows: true }, stats: { followers: 11 } });

    // Reopened ~10 s later: the follow has landed. Then Following → Unfollow, while the follow's call still runs.
    await reopen(true, 11);
    await expect(runWrite(followWrite, { authorId: author, follow: false })).resolves.toEqual({ status: 'queued' });
    expect(shown()).toMatchObject({ viewer: { follows: false }, stats: { followers: 10 } });

    // Back and reopened at once: the chain still has the follow, the unfollow hasn't gone out.
    await reopen(true, 11);
    expect(shown()).toMatchObject({ viewer: { follows: false }, stats: { followers: 10 } });

    // The follow confirms: the unfollow goes out; a read before it lands still shows it.
    const unfollow = ticket({ op: 'unfollow', target: { identityId: author } });
    fakeEngine.method('graph.unfollow').mockResolvedValueOnce(unfollow);
    await act(async () => fakeEngine.emit('write.status', advance(follow, { state: 'confirmed' })));
    expect(fakeEngine.method('graph.unfollow')).toHaveBeenCalledWith(author);
    await reopen(true, 11);
    expect(shown()).toMatchObject({ viewer: { follows: false }, stats: { followers: 10 } });

    // Once it confirms, reads are the chain's again.
    act(() => fakeEngine.emit('write.status', advance(unfollow, { state: 'confirmed' })));
    await reopen(true, 11);
    expect(shown()).toMatchObject({ viewer: { follows: true } });
  });

  it('shows the follow again when a sent unfollow fails, and a later read does not undo that', async () => {
    queryClient.setQueryData(profileKey, profileReading(true, 11));
    const unfollow = ticket({ op: 'unfollow', target: { identityId: author } });
    fakeEngine.method('graph.unfollow').mockResolvedValueOnce(unfollow);
    await runWrite(followWrite, { authorId: author, follow: false });
    expect(shown()).toMatchObject({ viewer: { follows: false } });

    act(() => fakeEngine.emit('write.status', advance(unfollow, { state: 'failed', error: null })));
    expect(shown()).toMatchObject({ viewer: { follows: true } });
    await reopen(true, 11);
    expect(shown()).toMatchObject({ viewer: { follows: true }, stats: { followers: 11 } });
  });

  it('stops standing in for a write once tracking resets (an account switch)', async () => {
    queryClient.setQueryData(profileKey, profileReading(true, 11));
    const unfollow = ticket({ op: 'unfollow', target: { identityId: author } });
    fakeEngine.method('graph.unfollow').mockResolvedValueOnce(unfollow);
    await runWrite(followWrite, { authorId: author, follow: false });
    resetWriteTracking();
    await reopen(true, 11);
    expect(shown()).toMatchObject({ viewer: { follows: true } });
  });

  it("leaves reads alone once a write's call has answered and it may have landed", async () => {
    queryClient.setQueryData(profileKey, profileReading(true, 11));
    const unfollow = ticket({ op: 'unfollow' });
    fakeEngine.method('graph.unfollow').mockResolvedValueOnce(unfollow);
    await runWrite(followWrite, { authorId: author, follow: false });
    act(() => fakeEngine.emit('write.status', advance(unfollow, { state: 'unconfirmed' })));
    await reopen(true, 11);
    expect(shown()).toMatchObject({ viewer: { follows: true } });
  });
});

describe('useWrite', () => {
  it('follows its ticket from idle to confirmed', async () => {
    const { result } = renderHook(() => useWrite(spec));
    expect(result.current.status).toBe('idle');

    const pending = ticket();
    fakeEngine.method('engage.like').mockResolvedValueOnce(pending);
    await act(async () => {
      await result.current.run(target);
    });
    expect(result.current.status).toBe('pending');
    expect(result.current.ticket?.id).toBe(pending.id);

    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'confirmed' })));
    expect(result.current.status).toBe('confirmed');
  });
});
