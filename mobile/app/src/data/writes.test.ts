import type { TargetRef, WriteTicket } from '@engine/api';
import { act, renderHook } from '@testing-library/react-native';

import { useToastStore } from '~/ui/toast';

import { useSignInPrompt } from './require-auth';
import { advance, fakeEngine, ticket } from './testing/fake-engine';
import { adoptRestoredWrites, checkWrite, runWrite, submitWrite, useWrite, type WriteSpec } from './writes';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);

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
  noun: 'like',
  failureMessage: 'Failed to update like. Please try again.',
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
  useToastStore.setState({ current: null });
  useSignInPrompt.setState({ open: false });
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

  it('undoes a failed write and toasts the engine message with Retry, which re-applies and re-sends', async () => {
    const pending = await submitPending();
    const failed = advance(pending, {
      state: 'failed',
      retryable: true,
      error: { code: 'FEE_UNPAYABLE', consensusCode: null, outcome: 'refused', retryable: true, userMessage: 'Not enough credits.' },
    });
    act(() => fakeEngine.emit('write.status', failed));

    expect(undo).toHaveBeenCalledTimes(1);
    expect(currentToast()).toMatchObject({ kind: 'error', message: 'Not enough credits.', action: { label: 'Retry' } });

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
    expect(currentToast()).toMatchObject({ message: 'Failed to update like. Please try again.', action: undefined });
  });

  it('keeps an unconfirmed write, offers Check again, and undoes it once a check proves it absent', async () => {
    const pending = await submitPending();
    const unconfirmed = advance(pending, { state: 'unconfirmed' });
    act(() => fakeEngine.emit('write.status', unconfirmed));
    expect(undo).not.toHaveBeenCalled();
    expect(currentToast()).toMatchObject({ kind: 'info', message: 'Not confirmed yet', action: { label: 'Check again' } });

    const show = jest.spyOn(useToastStore.getState(), 'show');
    answer('writes.check', advance(unconfirmed, { retryable: true, lastCheckedAt: new Date() }));
    await act(async () => currentToast()?.action?.onPress());
    expect(fakeEngine.method('writes.check')).toHaveBeenCalledWith(pending.id);
    expect(undo).toHaveBeenCalledTimes(1);
    // The event and the call's answer are one outcome: one toast.
    expect(show).toHaveBeenCalledTimes(1);
    expect(currentToast()).toMatchObject({ kind: 'error', message: "Your like didn't go through. Try again.", action: { label: 'Retry' } });
  });

  it('says so again when a check proves nothing either way', async () => {
    const pending = await submitPending();
    const unconfirmed = advance(pending, { state: 'unconfirmed' });
    act(() => fakeEngine.emit('write.status', unconfirmed));
    act(() => useToastStore.setState({ current: null }));

    answer('writes.check', { ...unconfirmed, lastCheckedAt: new Date() });
    await act(async () => {
      await checkWrite(pending.id);
    });
    expect(currentToast()).toMatchObject({ message: 'Not confirmed yet' });
    expect(undo).not.toHaveBeenCalled();
  });

  it('stays quiet about an unconfirmed write the spec counts as done', async () => {
    const pending = ticket();
    fakeEngine.method('engage.like').mockResolvedValueOnce(pending);
    await submitWrite({ ...spec, announceUnconfirmed: false }, target);
    act(() => fakeEngine.emit('write.status', advance(pending, { state: 'unconfirmed' })));
    expect(currentToast()).toBeNull();
    expect(undo).not.toHaveBeenCalled();
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

    await act(async () => staleRetry?.onPress());
    expect(fakeEngine.method('writes.retry')).not.toHaveBeenCalled();
    expect(currentToast()).toMatchObject({ message: 'Already updated' });
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
      noun: 'like',
      failureMessage: 'Failed to update like. Please try again.',
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
      noun: 'like',
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

  it('drops a queued write that asks for what the pending one asked (like, unlike, like)', async () => {
    const toggle: WriteSpec<{ on: boolean }> = {
      key: () => `like:${target.id}`,
      submit: (api, { on }) => (on ? api.engage.like(target) : api.engage.unlike(target)),
      optimistic: apply,
      intent: ({ on }) => on,
      noun: 'like',
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
    expect(currentToast()).toMatchObject({ message: "Your like didn't go through. Try again." });
  });

  it('undoes and toasts a refused call, and asks to sign in for NOT_SIGNED_IN', async () => {
    fakeEngine.method('engage.like').mockRejectedValueOnce(Object.assign(new Error('bad'), { code: 'BAD_REQUEST' }));
    await expect(runWrite(spec, target)).resolves.toMatchObject({ status: 'refused' });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(currentToast()).toMatchObject({ kind: 'error', message: 'Failed to update like. Please try again.' });

    act(() => useToastStore.setState({ current: null }));
    fakeEngine.method('engage.like').mockRejectedValueOnce(Object.assign(new Error('no'), { code: 'NOT_SIGNED_IN' }));
    await expect(submitWrite(spec, target)).resolves.toBeNull();
    expect(useSignInPrompt.getState().open).toBe(true);
    expect(currentToast()).toBeNull();
  });

  it('lets the spec handle a refusal itself', async () => {
    const onRejected = jest.fn(() => true);
    fakeEngine.method('engage.like').mockRejectedValueOnce(Object.assign(new Error('q'), { code: 'QUOTE_HAS_TEXT' }));
    await submitWrite({ ...spec, onRejected }, target);
    expect(onRejected).toHaveBeenCalledWith(expect.objectContaining({ code: 'QUOTE_HAS_TEXT' }), target);
    expect(currentToast()).toBeNull();
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
