import type { CapabilitiesDTO, EngineErrorData, Page, PostDTO, SessionDTO, ThreadDTO, WriteTicket } from '@engine/api';
import { notifyManager, type InfiniteData } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import { router } from 'expo-router';

import { queryKeys } from '~/data/keys';
import { useSessionStore } from '~/data/session';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';
import { AUTHORS, VIEWER_ID, fixturePost } from '~/ui/post/fixtures';
import { useToastStore } from '~/ui/toast';

import { useRemovedPosts } from '~/data/optimistic';

import { deleteDraft, loadDraft, saveDraft, type ComposeContext, type DraftPart } from './drafts';
import { hasVisibleContent } from './limits';
import {
  checkPending,
  editPending,
  pendingStatus,
  publishPost,
  retryPending,
  startPendingPosts,
  usePendingPosts,
  usePendingWriteStatus,
  viewerAuthor,
} from './pending-posts';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const viewer: SessionDTO = {
  identityId: VIEWER_ID,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};
const POST: ComposeContext = { mode: 'post', targetId: null };
const HOME = queryKeys.feed.home({ tab: 'forYou' });
const PROFILE = queryKeys.profile.posts(VIEWER_ID, 'posts');

const existing = fixturePost({ id: 'existing-1' });
const page = (items: PostDTO[]): InfiniteData<Page<PostDTO>> => ({
  pages: [{ items, cursor: null, hasMore: false }],
  pageParams: [null],
});
const homeIds = () => queryClient.getQueryData<InfiniteData<Page<PostDTO>>>(HOME)?.pages[0]?.items.map((p) => p.id);
const parts = (...texts: string[]): DraftPart[] => texts.map((text) => ({ text, postedId: null }));
const only = () => Object.values(usePendingPosts.getState().entries)[0];
const toastMessage = () => useToastStore.getState().current?.message;

function publish(texts: string[], context: ComposeContext = POST, target: PostDTO | null = null, mediaUrl: string | null = null) {
  return publishPost(
    {
      identityId: VIEWER_ID,
      context,
      parts: parts(...texts),
      sensitive: false,
      mediaUrl,
      target,
      author: viewerAuthor(VIEWER_ID, 'alice'),
    },
    hasVisibleContent,
  );
}

/** Lets the submit's promise chain settle. */
const settle = () => act(async () => {});

const doc = (part: number, id: string, confirmed = true) => ({
  contractId: 'social',
  type: part === 0 ? 'post' : 'reply',
  id,
  action: 'create' as const,
  confirmed,
  part,
});
const failedWith = (outcome: 'refused' | 'unknown'): EngineErrorData => ({
  code: 'UNKNOWN',
  consensusCode: null,
  outcome,
  retryable: false,
  userMessage: 'Broke.',
});
const publishTicket = () => ticket({ op: 'post.publish', identityId: VIEWER_ID });

let stop: () => void;
beforeAll(() => {
  notifyManager.setScheduler((callback) => callback());
  stop = startPendingPosts();
});
afterAll(() => {
  stop();
  queryClient.clear();
});

beforeEach(() => {
  jest.clearAllMocks();
  fakeEngine.reset();
  queryClient.clear();
  usePendingPosts.setState({ entries: {} });
  useToastStore.setState({ current: null });
  deleteDraft(VIEWER_ID, POST);
  useRemovedPosts.setState({ ids: new Set() });
  fakeEngine.setStatus({ state: 'ready', info: { capabilities: { contentLimits: { chars: 1000, bytes: 2000 } } as CapabilitiesDTO } });
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  queryClient.setQueryData(HOME, page([existing]));
  queryClient.setQueryData(PROFILE, page([existing]));
});

it('puts the card on top of Home and the profile at once, posting', async () => {
  let resolve: (t: WriteTicket) => void = () => undefined;
  fakeEngine.method('posts.publish').mockReturnValue(new Promise((r) => (resolve = r)));

  const localId = publish(['Hello world', '']);

  expect(homeIds()).toEqual([localId, 'existing-1']);
  expect(queryClient.getQueryData<InfiniteData<Page<PostDTO>>>(PROFILE)?.pages[0]?.items[0]?.id).toBe(localId);
  expect(pendingStatus(only()!)).toEqual({ state: 'posting' });
  // The empty second part is left out.
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledWith(
    expect.objectContaining({ parts: [{ text: 'Hello world' }], replyTo: null, quote: null, resume: null }),
  );
  resolve(ticket({ op: 'post.publish' }));
  await settle();
  expect(only()?.ticketId).toBeTruthy();
});

it('keeps the card when the list refetches before the chain has it', async () => {
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  const localId = publish(['Hello']);
  await settle();

  queryClient.setQueryData(HOME, page([existing]));
  expect(homeIds()).toEqual([localId, 'existing-1']);
});

it('becomes the real post on confirm, with the success toast, and stays pinned', async () => {
  const t = ticket({ op: 'post.publish' });
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  const localId = publish(['Hello']);
  await settle();

  act(() => fakeEngine.emit('write.status', advance(t, { state: 'confirmed', documents: [doc(0, 'real-1')] })));

  expect(homeIds()).toEqual(['real-1', 'existing-1']);
  expect(toastMessage()).toBe('Post created successfully!');
  expect(usePendingPosts.getState().entries[localId]?.confirmedAt).toBeTruthy();
  // A refetch that does not have it yet keeps it on top.
  queryClient.setQueryData(HOME, page([existing]));
  expect(homeIds()).toEqual(['real-1', 'existing-1']);
});

it('says "Thread with N posts created!" for a thread', async () => {
  const t = ticket({ op: 'post.publish' });
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  publish(['one', 'two', 'three']);
  await settle();
  act(() => fakeEngine.emit('write.status', advance(t, { progress: { done: 1, total: 3 } })));
  expect(pendingStatus(only()!)).toEqual({ state: 'threadProgress', index: 2, total: 3 });

  act(() =>
    fakeEngine.emit(
      'write.status',
      advance(t, { state: 'confirmed', documents: [doc(0, 'a'), doc(1, 'b'), doc(2, 'c')] }),
    ),
  );
  expect(toastMessage()).toBe('Thread with 3 posts created!');
});

it('fails: the card offers Retry and Edit, and the text returns to the draft', async () => {
  const t = ticket({ op: 'post.publish' });
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  const localId = publish(['Hello there']);
  await settle();
  expect(loadDraft(VIEWER_ID, POST)).toBeNull();

  const error = { code: 'TOO_LONG', consensusCode: null, outcome: 'refused', retryable: false, userMessage: 'Too long.' } as const;
  act(() => fakeEngine.emit('write.status', advance(t, { state: 'failed', error })));

  expect(pendingStatus(only()!)).toEqual({ state: 'failed' });
  expect(homeIds()).toEqual([localId, 'existing-1']);
  expect(loadDraft(VIEWER_ID, POST)?.parts).toEqual([{ text: 'Hello there', postedId: null }]);
  expect(toastMessage()).toBe('Too long.');

  // Edit: the card goes and compose opens on the draft.
  editPending(localId);
  expect(homeIds()).toEqual(['existing-1']);
  expect(usePendingPosts.getState().entries[localId]).toBeUndefined();
  expect(router.push).toHaveBeenCalledWith({ pathname: '/compose', params: {} });
});

it('a partly posted thread reads "Posted 1 of 3" and retries the rest with resume', async () => {
  const t = ticket({ op: 'post.publish' });
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  publish(['one', 'two', 'three']);
  await settle();

  const error = { code: 'UNKNOWN', consensusCode: null, outcome: 'refused', retryable: false, userMessage: 'Broke.' } as const;
  act(() => fakeEngine.emit('write.status', advance(t, { state: 'failed', error, documents: [doc(0, 'root-1')] })));

  expect(pendingStatus(only()!)).toEqual({ state: 'partial', posted: 1, total: 3 });
  expect(toastMessage()).toBe('Thread partly posted. Post 2 failed: Broke.');
  expect(loadDraft(VIEWER_ID, POST)?.parts.map((p) => p.postedId)).toEqual(['root-1', null, null]);

  const again = ticket({ op: 'post.publish' });
  fakeEngine.method('posts.publish').mockResolvedValue(again);
  retryPending(only()!.localId);
  await settle();
  expect(fakeEngine.method('posts.publish')).toHaveBeenLastCalledWith(
    expect.objectContaining({ resume: { postedIds: ['root-1', null, null] } }),
  );
  expect(fakeEngine.method('writes.dismiss')).toHaveBeenCalledWith(t.id);
  expect(only()?.ticketId).toBe(again.id);
  expect(loadDraft(VIEWER_ID, POST)).toBeNull();
});

it('retries a ticket the engine proved did not land in place', async () => {
  const t = ticket({ op: 'post.publish' });
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  publish(['Hello']);
  await settle();
  act(() => fakeEngine.emit('write.status', advance(t, { state: 'unconfirmed', documents: [doc(0, 'real-1', false)] })));
  expect(pendingStatus(only()!)).toEqual({ state: 'unconfirmed' });

  act(() => fakeEngine.emit('write.status', advance(t, { state: 'unconfirmed', retryable: true, updatedAt: new Date(Date.now() + 5000) })));
  expect(pendingStatus(only()!)).toEqual({ state: 'failed' });

  // The engine reports the transition before it answers the call.
  const retried = advance(t, { state: 'pending', retryable: false, updatedAt: new Date(Date.now() + 9000) });
  fakeEngine.method('writes.retry').mockImplementation(async () => {
    fakeEngine.emit('write.status', retried);
    return retried;
  });
  retryPending(only()!.localId);
  await settle();
  expect(fakeEngine.method('writes.retry')).toHaveBeenCalledWith(t.id);
  expect(pendingStatus(only()!)).toEqual({ state: 'posting' });
});

it('a reply goes under its parent in the thread and moves its reply count', async () => {
  const parent = fixturePost({ id: 'parent-1', author: AUTHORS.bob });
  const thread: ThreadDTO = {
    focus: parent,
    ancestors: [],
    removedAncestorIds: [],
    replies: { items: [], cursor: null, hasMore: false },
  };
  queryClient.setQueryData(queryKeys.post.thread('parent-1'), thread);
  queryClient.setQueryData(queryKeys.post.detail('parent-1'), parent);
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));

  const localId = publish(['Nice'], { mode: 'reply', targetId: 'parent-1' }, parent);
  await settle();

  const replies = queryClient.getQueryData<ThreadDTO>(queryKeys.post.thread('parent-1'))?.replies.items;
  expect(replies?.map((r) => [r.id, r.depth, r.parentId])).toEqual([[localId, 0, 'parent-1']]);
  expect(homeIds()).toEqual(['existing-1']);
  expect(queryClient.getQueryData<PostDTO>(queryKeys.post.detail('parent-1'))?.stats.replies).toBe(
    parent.stats.replies + 1,
  );
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledWith(
    expect.objectContaining({
      replyTo: { id: 'parent-1', kind: 'post', ownerId: AUTHORS.bob.id, rootPostId: null },
    }),
  );
});

it('a refused call (no ticket) shows failed and returns the text', async () => {
  fakeEngine.method('posts.publish').mockRejectedValue(Object.assign(new Error('bad'), { code: 'BAD_REQUEST' }));
  publish(['Hello']);
  await settle();
  expect(pendingStatus(only()!)).toEqual({ state: 'failed' });
  expect(loadDraft(VIEWER_ID, POST)?.parts[0]?.text).toBe('Hello');
  expect(toastMessage()).toBe("Couldn't post. Please try again.");
});

it("adopts a thread's first part as it lands, so a refetch never shows it twice", async () => {
  const t = ticket({ op: 'post.publish' });
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  const localId = publish(['root text', 'second']);
  await settle();

  const root = fixturePost({ id: 'root-real', content: 'root text', author: { ...AUTHORS.alice, id: VIEWER_ID } });
  act(() => fakeEngine.emit('content.created', { kind: 'post', id: root.id, confirmed: true, post: root }));
  expect(homeIds()).toEqual(['root-real', 'existing-1']);
  expect(usePendingPosts.getState().entries[localId]?.adoptedId).toBe('root-real');

  // The feed refetches with the root in it: still one card.
  queryClient.setQueryData(HOME, page([root, existing]));
  expect(homeIds()).toEqual(['root-real', 'existing-1']);
  expect(pendingStatus(only()!)).toEqual({ state: 'posting' });
});

it('a thread retried past its posted root keeps the root as its card', async () => {
  const t = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  publish(['root text', 'second']);
  await settle();
  act(() =>
    fakeEngine.emit('write.status', advance(t, { state: 'failed', error: failedWith('refused'), documents: [doc(0, 'root-1')] })),
  );

  const again = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(again);
  retryPending(only()!.localId);
  await settle();

  // The feed refetches with the root in it while the rest still posts: one card.
  const root = fixturePost({ id: 'root-1', content: 'root text', author: { ...AUTHORS.alice, id: VIEWER_ID } });
  queryClient.setQueryData(HOME, page([root, existing]));
  expect(homeIds()).toEqual(['root-1', 'existing-1']);
  // The root carries the rest's write status, with no content.created ever seen for it.
  const status = renderHook(() => usePendingWriteStatus('root-1'));
  expect(status.result.current?.status).toEqual({ state: 'posting' });
  status.unmount();

  act(() => fakeEngine.emit('write.status', advance(again, { state: 'confirmed', documents: [doc(1, 'second-1')] })));
  expect(only()?.post.id).toBe('root-1');
  queryClient.setQueryData(HOME, page([existing]));
  expect(homeIds()).toEqual(['root-1', 'existing-1']);
});

it('adopts a created reply only for the pending reply to the same parent', async () => {
  const parentA = fixturePost({ id: 'parent-a', author: AUTHORS.bob });
  const parentB = fixturePost({ id: 'parent-b', author: AUTHORS.bob });
  fakeEngine.method('posts.publish').mockResolvedValue(publishTicket());
  const toA = publish(['Same'], { mode: 'reply', targetId: 'parent-a' }, parentA);
  const toB = publish(['Same'], { mode: 'reply', targetId: 'parent-b' }, parentB);
  await settle();

  const created = fixturePost({
    id: 'reply-b',
    kind: 'reply',
    content: 'Same',
    parentId: 'parent-b',
    rootPostId: 'parent-b',
    author: { ...AUTHORS.alice, id: VIEWER_ID },
  });
  act(() => fakeEngine.emit('content.created', { kind: 'reply', id: created.id, confirmed: true, post: created }));

  expect(usePendingPosts.getState().entries[toA]?.adoptedId).toBeUndefined();
  expect(usePendingPosts.getState().entries[toB]?.adoptedId).toBe('reply-b');
});

it('a part "Check again" proved absent is not posted: Edit can post it again', async () => {
  const t = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  const localId = publish(['Hello']);
  await settle();
  act(() => fakeEngine.emit('write.status', advance(t, { state: 'unconfirmed', documents: [doc(0, 'x', false)] })));
  expect(pendingStatus(only()!)).toEqual({ state: 'unconfirmed' });

  // The check proves it absent: the engine keeps the document, unconfirmed, and allows a retry.
  act(() =>
    fakeEngine.emit(
      'write.status',
      advance(t, { state: 'unconfirmed', retryable: true, documents: [doc(0, 'x', false)], updatedAt: new Date(Date.now() + 5000) }),
    ),
  );
  expect(pendingStatus(only()!)).toEqual({ state: 'failed' });
  expect(loadDraft(VIEWER_ID, POST)?.parts).toEqual([{ text: 'Hello', postedId: null }]);
  expect(homeIds()).toEqual([localId, 'existing-1']);
});

it("a failure never overwrites the user's other draft: Edit opens the post on a slot of its own", async () => {
  const t = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  const localId = publish(['Post A']);
  await settle();
  saveDraft(VIEWER_ID, { context: POST, parts: parts('Draft B'), sensitive: false, mediaUrl: '', updatedAt: Date.now() });

  act(() => fakeEngine.emit('write.status', advance(t, { state: 'failed', error: failedWith('refused') })));
  expect(pendingStatus(only()!)).toEqual({ state: 'failed' });
  expect(loadDraft(VIEWER_ID, POST)?.parts[0]?.text).toBe('Draft B');

  editPending(localId);
  expect(router.push).toHaveBeenCalledWith({ pathname: '/compose', params: { pending: localId } });
  // The card stays until that composer posts or deletes it; draft B is untouched.
  expect(homeIds()).toEqual([localId, 'existing-1']);
  expect(loadDraft(VIEWER_ID, POST)?.parts[0]?.text).toBe('Draft B');
});

it('a failure that may have landed offers Edit only, and Retry never re-sends it', async () => {
  const t = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  publish(['one', 'two']);
  await settle();
  act(() =>
    fakeEngine.emit('write.status', advance(t, { state: 'failed', error: failedWith('unknown'), documents: [doc(0, 'root-1')] })),
  );
  expect(pendingStatus(only()!)).toEqual({ state: 'uncertain' });

  fakeEngine.method('posts.publish').mockClear();
  retryPending(only()!.localId);
  await settle();
  expect(fakeEngine.method('posts.publish')).not.toHaveBeenCalled();
  expect(fakeEngine.method('writes.retry')).not.toHaveBeenCalled();
});

it('a call cut short waits for its ticket: "Not confirmed yet", adopted when the engine shows it', async () => {
  fakeEngine.method('posts.publish').mockRejectedValue(Object.assign(new Error('restarted'), { code: 'ENGINE_RESTARTED' }));
  fakeEngine.method('writes.list').mockResolvedValue([]);
  const localId = publish(['Hello']);
  await settle();
  expect(pendingStatus(only()!)).toEqual({ state: 'unconfirmed' });
  // Never returned to the draft: it may have gone out.
  expect(loadDraft(VIEWER_ID, POST)).toBeNull();

  const restored = publishTicket();
  act(() => fakeEngine.emit('write.status', advance(restored, { state: 'confirmed', documents: [doc(0, 'real-1')] })));
  expect(usePendingPosts.getState().entries[localId]?.confirmedAt).toBeTruthy();
  expect(homeIds()).toEqual(['real-1', 'existing-1']);
});

it('"Check again" on a cut-short post with no ticket: Edit only, never Retry', async () => {
  fakeEngine.method('posts.publish').mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ENGINE_TIMEOUT' }));
  fakeEngine.method('writes.list').mockResolvedValue([]);
  const localId = publish(['Hello']);
  await settle();

  checkPending(localId);
  await settle();
  expect(fakeEngine.method('writes.list')).toHaveBeenCalled();
  expect(pendingStatus(only()!)).toEqual({ state: 'uncertain' });

  // A ticket that shows up later is still followed.
  const late = publishTicket();
  const lateUnconfirmed = advance(late, { state: 'unconfirmed', documents: [doc(0, 'real-1', false)] });
  fakeEngine.method('writes.list').mockResolvedValue([lateUnconfirmed]);
  checkPending(localId);
  fakeEngine.method('writes.check').mockResolvedValue(lateUnconfirmed);
  await settle();
  expect(only()?.ticketId).toBe(late.id);
  expect(pendingStatus(only()!)).toEqual({ state: 'unconfirmed' });
});

it('a part that never reported an id cannot be checked: Edit only, never Check again or Retry', async () => {
  const t = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  publish(['one', 'two']);
  await settle();

  // Part 2 timed out before its id was known: the engine's probe says unknown on every check.
  act(() => fakeEngine.emit('write.status', advance(t, { state: 'unconfirmed', documents: [doc(0, 'one-1')] })));
  expect(pendingStatus(only()!)).toEqual({ state: 'uncertain' });

  // A single post whose only part has no id: the same.
  usePendingPosts.setState({ entries: {} });
  const single = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(single);
  publish(['Hello']);
  await settle();
  act(() => fakeEngine.emit('write.status', advance(single, { state: 'unconfirmed', documents: [] })));
  expect(pendingStatus(only()!)).toEqual({ state: 'uncertain' });
});

it('never guesses which of two cut-short posts a ticket belongs to', async () => {
  fakeEngine.method('posts.publish').mockRejectedValue(Object.assign(new Error('restarted'), { code: 'ENGINE_RESTARTED' }));
  fakeEngine.method('writes.list').mockResolvedValue([]);
  publish(['first']);
  publish(['second']);
  await settle();

  const restored = publishTicket();
  act(() => fakeEngine.emit('write.status', advance(restored, { state: 'confirmed', documents: [doc(0, 'real-1')] })));
  const entries = Object.values(usePendingPosts.getState().entries);
  expect(entries).toHaveLength(2);
  expect(entries.every((e) => !e.ticketId && !e.confirmedAt)).toBe(true);
});

it('a resume carries no image: it went with the first part', async () => {
  fakeEngine.method('posts.publish').mockResolvedValue(publishTicket());
  publishPost(
    {
      identityId: VIEWER_ID,
      context: POST,
      parts: [
        { text: 'one', postedId: 'root-1' },
        { text: 'two', postedId: null },
      ],
      sensitive: false,
      mediaUrl: 'https://img.example/a.png',
      target: null,
      author: viewerAuthor(VIEWER_ID, 'alice'),
    },
    hasVisibleContent,
  );
  await settle();
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledWith(
    expect.objectContaining({ mediaUrl: null, resume: { postedIds: ['root-1', null] } }),
  );

  // And Retry the rest after part 1 (with the image) landed.
  const t = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  publish(['one', 'two'], POST, null, 'https://img.example/a.png');
  await settle();
  expect(fakeEngine.method('posts.publish')).toHaveBeenLastCalledWith(
    expect.objectContaining({ mediaUrl: 'https://img.example/a.png' }),
  );
  const entry = Object.values(usePendingPosts.getState().entries).find((e) => e.ticketId === t.id)!;
  act(() =>
    fakeEngine.emit('write.status', advance(t, { state: 'failed', error: failedWith('refused'), documents: [doc(0, 'root-2')] })),
  );
  fakeEngine.method('posts.publish').mockResolvedValue(publishTicket());
  retryPending(entry.localId);
  await settle();
  expect(fakeEngine.method('posts.publish')).toHaveBeenLastCalledWith(
    expect.objectContaining({ mediaUrl: null, resume: { postedIds: ['root-2', null] } }),
  );
});

it("signing out deletes the account's drafts and pending posts", async () => {
  fakeEngine.method('posts.publish').mockResolvedValue(publishTicket());
  publish(['Hello']);
  await settle();
  saveDraft(VIEWER_ID, { context: POST, parts: parts('Draft'), sensitive: false, mediaUrl: '', updatedAt: Date.now() });
  fakeEngine.method('session.accounts').mockResolvedValue([]);

  act(() => fakeEngine.emit('session.changed', { session: null, reason: 'signed-out' }));
  await settle();
  expect(usePendingPosts.getState().entries).toEqual({});
  expect(loadDraft(VIEWER_ID, POST)).toBeNull();
});

it('a post deleted while pinned does not come back with the pin', async () => {
  const t = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  publish(['Hello']);
  await settle();
  act(() => fakeEngine.emit('write.status', advance(t, { state: 'confirmed', documents: [doc(0, 'real-1')] })));
  expect(homeIds()).toEqual(['real-1', 'existing-1']);

  act(() => useRemovedPosts.setState({ ids: new Set(['real-1']) }));
  queryClient.setQueryData(HOME, page([existing]));
  expect(homeIds()).toEqual(['existing-1']);
});
