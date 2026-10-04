import type { AccountDTO, CapabilitiesDTO, EngineErrorData, Page, PostDTO, SessionDTO, ThreadDTO, WriteTicket } from '@engine/api';
import { notifyManager, type InfiniteData } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import { router } from 'expo-router';

import { queryKeys } from '~/data/keys';
import { isExhausted, recheck, ticketJob } from '~/data/reconcile';
import { useSessionStore } from '~/data/session';
import { advance, fakeEngine, ticket } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';
import { syncStorage } from '~/state/storage';
import { AUTHORS, VIEWER_ID, fixturePost } from '~/ui/post/fixtures';
import { useToastStore } from '~/ui/toast';

import { useRemovedPosts } from '~/data/optimistic';
import { resetWriteTracking } from '~/data/writes';

import { deleteDraft, holdDraftSlot, loadDraft, saveDraft, type ComposeContext, type DraftPart } from './drafts';
import { hasVisibleContent } from './limits';
import {
  editPending,
  MEDIA_UNREADABLE_TEXT,
  POST_UNCONFIRMED_TEXT,
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
/** Where pending posts persist (pending-posts.ts `STORAGE_KEY`). */
const PENDING_KEY = 'yappr.compose.pending';
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
/** The reconciler's job that looks for the ticket of a post whose call never named it. */
const orphanJob = (localId: string) => `post.orphan:${localId}`;
/** The reconciler's next check of a job (what its 5 s / 15 s / 60 s schedule, a foreground or a read runs). */
const nextCheck = (job: string) => act(async () => void (await recheck(job)));

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
  // No reconciler job (or its timers) of an earlier test runs into this one.
  resetWriteTracking();
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
  expect(toastMessage()).toBe('Posted');
  expect(usePendingPosts.getState().entries[localId]?.confirmedAt).toBeTruthy();
  // A refetch that does not have it yet keeps it on top.
  queryClient.setQueryData(HOME, page([existing]));
  expect(homeIds()).toEqual(['real-1', 'existing-1']);
});

it('says "Thread posted" for a thread', async () => {
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
  expect(toastMessage()).toBe('Thread posted');
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
  // The engine's own wording goes to diagnostics; the toast is the post's sentence.
  expect(toastMessage()).toBe("Couldn't post. Try again.");

  // Edit: the card goes and compose opens on the draft.
  editPending(localId);
  expect(homeIds()).toEqual(['existing-1']);
  expect(usePendingPosts.getState().entries[localId]).toBeUndefined();
  expect(router.push).toHaveBeenCalledWith({ pathname: '/compose', params: {} });
});

it('an image link the engine cannot read says so, and its toast offers Edit, not Retry (D-L3a-012)', async () => {
  const t = ticket({ op: 'post.publish' });
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  const localId = publish(['Look at this'], POST, null, 'https://img.example/refused.png');
  await settle();

  const error = {
    code: 'MEDIA_UNREADABLE',
    consensusCode: null,
    outcome: 'local',
    retryable: false,
    userMessage: 'Could not read the image to fingerprint it (HTTP 403)',
  } as const;
  act(() => fakeEngine.emit('write.status', advance(t, { state: 'failed', error })));

  expect(pendingStatus(only()!)).toEqual({ state: 'failed' });
  expect(toastMessage()).toBe(MEDIA_UNREADABLE_TEXT);
  const action = useToastStore.getState().current?.action;
  expect(action?.label).toBe('Edit');
  act(() => action?.onPress());
  expect(usePendingPosts.getState().entries[localId]).toBeUndefined();
  expect(router.push).toHaveBeenCalledWith({ pathname: '/compose', params: {} });
  expect(loadDraft(VIEWER_ID, POST)?.mediaUrl).toBe('https://img.example/refused.png');
});

it('a partly posted thread reads "Posted 1 of 3" and retries the rest with resume', async () => {
  const t = ticket({ op: 'post.publish' });
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  publish(['one', 'two', 'three']);
  await settle();

  const error = { code: 'UNKNOWN', consensusCode: null, outcome: 'refused', retryable: false, userMessage: 'Broke.' } as const;
  act(() => fakeEngine.emit('write.status', advance(t, { state: 'failed', error, documents: [doc(0, 'root-1')] })));

  expect(pendingStatus(only()!)).toEqual({ state: 'partial', posted: 1, total: 3 });
  // The engine's reason ("Broke.") goes to diagnostics only.
  expect(toastMessage()).toBe("Thread partly posted. Post 2 didn't go through.");
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
  // Not proved either way: still "Posting…" while the app checks it.
  expect(pendingStatus(only()!)).toEqual({ state: 'posting' });

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

it("a quote on v10 takes the viewer's one slot on the quoted post once confirmed (D-L3i-002)", async () => {
  fakeEngine.setStatus({
    state: 'ready',
    info: { capabilities: { contentLimits: { chars: 1000, bytes: 2000 }, repostsAreQuotes: true } as CapabilitiesDTO },
  });
  const quoted = fixturePost({ id: 'quoted-1', author: AUTHORS.bob, stats: { likes: 0, reposts: 0, replies: 0, quotes: 0 } });
  // The feed's card of the quoted post, read before the quote.
  queryClient.setQueryData(HOME, page([quoted]));
  const t = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(t);

  publish(['My take'], { mode: 'quote', targetId: 'quoted-1' }, quoted);
  await settle();
  const card = () => queryClient.getQueryData<InfiniteData<Page<PostDTO>>>(HOME)?.pages[0]?.items.find((p) => p.id === 'quoted-1');
  expect(card()).toMatchObject({ stats: { quotes: 1 }, viewer: { reposted: false } });

  act(() => fakeEngine.emit('write.status', advance(t, { state: 'confirmed', documents: [doc(0, 'quote-1')] })));
  // Its sheet now offers the quote, never a second repost the one slot would refuse.
  expect(card()).toMatchObject({
    stats: { quotes: 1 },
    viewer: { reposted: true, ownQuoteId: 'quote-1', ownQuoteBare: false },
  });
});

it('a quote off v10 leaves the repost mark alone: there a quote is not a repost', async () => {
  const quoted = fixturePost({ id: 'quoted-2', author: AUTHORS.bob });
  queryClient.setQueryData(queryKeys.post.detail('quoted-2'), quoted);
  const t = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  publish(['My take'], { mode: 'quote', targetId: 'quoted-2' }, quoted);
  await settle();
  act(() => fakeEngine.emit('write.status', advance(t, { state: 'confirmed', documents: [doc(0, 'quote-2')] })));
  expect(queryClient.getQueryData<PostDTO>(queryKeys.post.detail('quoted-2'))).toMatchObject({
    stats: { quotes: quoted.stats.quotes + 1 },
    viewer: { reposted: false, ownQuoteId: null },
  });
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
  expect(toastMessage()).toBe("Couldn't post. Try again.");
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

it('Edit after a restart cut a thread short keeps the parts that landed posted (SR-03)', async () => {
  const t = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  const localId = publish(['root text', 'second', 'third']);
  await settle();
  const root = fixturePost({ id: 'root-real', content: 'root text', author: { ...AUTHORS.alice, id: VIEWER_ID } });
  act(() => fakeEngine.emit('content.created', { kind: 'post', id: root.id, confirmed: true, post: root }));

  // The engine restarted mid-thread, and its ticket names no part.
  const restarted = { code: 'ENGINE_RESTARTED', consensusCode: null, outcome: 'unknown', retryable: false, userMessage: 'x' } as const;
  act(() => fakeEngine.emit('write.status', advance(t, { state: 'unconfirmed', error: restarted, documents: [] })));
  expect(pendingStatus(only()!)).toEqual({ state: 'posting' });

  editPending(localId);
  expect(loadDraft(VIEWER_ID, POST)?.parts.map((p) => p.postedId)).toEqual(['root-real', null, null]);
});

it('a resumed thread that fails while a composer is open keeps its text, on a card (SR-06)', async () => {
  const t = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  // "Post all" on a partly posted thread: its root is on chain, so it has no card of its own.
  const localId = publishPost(
    {
      identityId: VIEWER_ID,
      context: POST,
      parts: [{ text: 'one', postedId: 'root-1' }, ...parts('two', 'three')],
      sensitive: false,
      mediaUrl: null,
      target: null,
      author: viewerAuthor(VIEWER_ID, 'alice'),
    },
    hasVisibleContent,
  );
  await settle();
  expect(only()?.placement).toBe('none');

  // The user opens an empty composer at once; then the resume fails.
  const release = holdDraftSlot(VIEWER_ID, POST);
  act(() => fakeEngine.emit('write.status', advance(t, { state: 'failed', error: failedWith('refused') })));

  // Not in the slot the open composer will save over: with the entry, now on a card.
  expect(loadDraft(VIEWER_ID, POST)).toBeNull();
  expect(usePendingPosts.getState().entries[localId]).toMatchObject({ placement: 'feed' });
  expect(homeIds()).toEqual([localId, 'existing-1']);
  expect(pendingStatus(only()!)).toEqual({ state: 'partial', posted: 1, total: 3 });

  // Once that composer is closed, Edit brings the text back to the draft.
  release();
  editPending(localId);
  expect(loadDraft(VIEWER_ID, POST)?.parts).toEqual([
    { text: 'one', postedId: 'root-1' },
    { text: 'two', postedId: null },
    { text: 'three', postedId: null },
  ]);
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

it('a part a check proved absent is not posted: Edit can post it again', async () => {
  const t = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  const localId = publish(['Hello']);
  await settle();
  act(() => fakeEngine.emit('write.status', advance(t, { state: 'unconfirmed', documents: [doc(0, 'x', false)] })));
  expect(pendingStatus(only()!)).toEqual({ state: 'posting' });

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

it('a failure that may have landed reads "Couldn\'t confirm · Edit" at once (no check can settle it), and Retry never re-sends it', async () => {
  const t = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  publish(['one', 'two']);
  await settle();
  act(() =>
    fakeEngine.emit('write.status', advance(t, { state: 'failed', error: failedWith('unknown'), documents: [doc(0, 'root-1')] })),
  );
  expect(pendingStatus(only()!)).toEqual({ state: 'unconfirmed' });
  // Never "Couldn't post" or "partly posted": it may have landed.
  expect(toastMessage()).toBe(POST_UNCONFIRMED_TEXT);

  fakeEngine.method('posts.publish').mockClear();
  retryPending(only()!.localId);
  await settle();
  expect(fakeEngine.method('posts.publish')).not.toHaveBeenCalled();
  expect(fakeEngine.method('writes.retry')).not.toHaveBeenCalled();
});

it('a call cut short waits for its ticket, still "Posting…", and is adopted when the engine shows it', async () => {
  fakeEngine.method('posts.publish').mockRejectedValue(Object.assign(new Error('restarted'), { code: 'ENGINE_RESTARTED' }));
  fakeEngine.method('writes.list').mockResolvedValue([]);
  const localId = publish(['Hello']);
  await settle();
  expect(pendingStatus(only()!)).toEqual({ state: 'posting' });
  // Never returned to the draft: it may have gone out.
  expect(loadDraft(VIEWER_ID, POST)).toBeNull();

  const restored = publishTicket();
  act(() => fakeEngine.emit('write.status', advance(restored, { state: 'confirmed', documents: [doc(0, 'real-1')] })));
  expect(usePendingPosts.getState().entries[localId]?.confirmedAt).toBeTruthy();
  expect(homeIds()).toEqual(['real-1', 'existing-1']);
});

it('the reconciler looks for a cut-short post\'s ticket by itself: still "Posting…" while a busy engine may take it', async () => {
  jest.useFakeTimers();
  try {
    fakeEngine.method('posts.publish').mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ENGINE_TIMEOUT' }));
    fakeEngine.method('writes.list').mockResolvedValue([]);
    publish(['Hello']);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    // The submit looked once, as it answered.
    expect(fakeEngine.method('writes.list')).toHaveBeenCalledTimes(1);

    // 5 s on, the first check: no ticket yet, and too soon to call it unsent.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(fakeEngine.method('writes.list')).toHaveBeenCalledTimes(2);
    expect(pendingStatus(only()!)).toEqual({ state: 'posting' });
    expect(loadDraft(VIEWER_ID, POST)).toBeNull();

    // A ticket that shows up by the next check is followed from there.
    const late = publishTicket();
    const lateUnconfirmed = advance(late, { state: 'unconfirmed', documents: [doc(0, 'real-1', false)] });
    fakeEngine.method('writes.list').mockResolvedValue([lateUnconfirmed]);
    fakeEngine.method('writes.check').mockResolvedValue(lateUnconfirmed);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(15_000);
    });
    expect(only()?.ticketId).toBe(late.id);
    expect(pendingStatus(only()!)).toEqual({ state: 'posting' });
    expect(toastMessage()).toBeUndefined();
  } finally {
    jest.useRealTimers();
  }
});

it('a part that never reported an id reads "Posting…" while it is checked, never Retry (D-L1a-001)', async () => {
  const t = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(t);
  publish(['one', 'two']);
  await settle();

  // Part 2 timed out before its id was known: the engine's check looks for it by its text.
  act(() => fakeEngine.emit('write.status', advance(t, { state: 'unconfirmed', documents: [doc(0, 'one-1')] })));
  expect(pendingStatus(only()!)).toEqual({ state: 'posting' });

  // A single post whose only part has no id: the same.
  usePendingPosts.setState({ entries: {} });
  const single = publishTicket();
  fakeEngine.method('posts.publish').mockResolvedValue(single);
  publish(['Hello']);
  await settle();
  act(() => fakeEngine.emit('write.status', advance(single, { state: 'unconfirmed', documents: [] })));
  expect(pendingStatus(only()!)).toEqual({ state: 'posting' });
  const { result } = renderHook(() => usePendingWriteStatus(only()!.localId));
  expect(result.current?.status).toEqual({ state: 'posting' });
  expect(toastMessage()).toBeUndefined();
  retryPending(only()!.localId);
  await settle();
  expect(fakeEngine.method('writes.retry')).not.toHaveBeenCalled();
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledTimes(2);
});

describe('an engine restart while a post was in flight (NET-04, COMP-10)', () => {
  const restartedUnknown: EngineErrorData = {
    code: 'ENGINE_RESTARTED',
    consensusCode: null,
    outcome: 'unknown',
    retryable: false,
    userMessage: 'An engine restart cut this write short before it was confirmed: checking whether it landed.',
  };
  const restartedUnsent: EngineErrorData = {
    code: 'ENGINE_RESTARTED',
    consensusCode: null,
    outcome: 'not-sent',
    retryable: true,
    userMessage: 'An engine restart cut this write short before it sent anything.',
  };

  it('before it sent anything: "Couldn\'t post · Retry · Edit", on the card and in the toast (D-L1i-005)', async () => {
    const t = publishTicket();
    fakeEngine.method('posts.publish').mockResolvedValue(t);
    publish(['Hello']);
    await settle();
    act(() =>
      fakeEngine.emit('write.status', advance(t, { state: 'failed', retryable: true, error: restartedUnsent, documents: [] })),
    );
    expect(pendingStatus(only()!)).toEqual({ state: 'failed' });
    // The engine's own words stay internal: the post's sentence, with Retry.
    expect(toastMessage()).toBe("Couldn't post. Try again.");
    expect(useToastStore.getState().current?.action?.label).toBe('Retry');
    // Its text is safe in the draft, and Retry re-runs the same ticket.
    expect(loadDraft(VIEWER_ID, POST)?.parts.map((p) => p.text)).toEqual(['Hello']);
    fakeEngine.method('writes.retry').mockResolvedValue(advance(t, { state: 'pending' }));
    retryPending(only()!.localId);
    await settle();
    expect(fakeEngine.method('writes.retry')).toHaveBeenCalledWith(t.id);
  });

  it('once it may have gone out: still "Posting…" with no toast, and a check that finds it makes it the real post (D-L1i-005)', async () => {
    const t = publishTicket();
    fakeEngine.method('posts.publish').mockResolvedValue(t);
    const localId = publish(['Hello']);
    await settle();
    act(() =>
      fakeEngine.emit('write.status', advance(t, { state: 'unconfirmed', error: restartedUnknown, documents: [] })),
    );
    expect(pendingStatus(only()!)).toEqual({ state: 'posting' });
    expect(toastMessage()).toBeUndefined();
    expect(loadDraft(VIEWER_ID, POST)).toBeNull();

    // The reconciler's check finds it (the engine looks for it by its text): the card becomes the real post.
    const found = advance(t, { state: 'confirmed', error: null, documents: [doc(0, 'real-1')] });
    fakeEngine.method('writes.check').mockImplementation(async () => {
      fakeEngine.emit('write.status', found);
      return found;
    });
    await nextCheck(ticketJob(t.id));
    expect(fakeEngine.method('writes.check')).toHaveBeenCalledWith(t.id);
    expect(usePendingPosts.getState().entries[localId]?.confirmedAt).toBeTruthy();
    expect(homeIds()).toEqual(['real-1', 'existing-1']);
    expect(toastMessage()).toBe('Posted');
  });

  it('the next refresh that shows the post on chain makes it normal, with no second card (D-L1a-001)', async () => {
    const t = publishTicket();
    fakeEngine.method('posts.publish').mockResolvedValue(t);
    const localId = publish(['Hello chain']);
    await settle();
    const unconfirmed = advance(t, { state: 'unconfirmed', error: restartedUnknown, documents: [] });
    act(() => fakeEngine.emit('write.status', unconfirmed));
    fakeEngine.method('writes.check').mockResolvedValue(unconfirmed);

    // An older post with the same words is not this one.
    const author = { ...AUTHORS.alice, id: VIEWER_ID };
    const older = fixturePost({ id: 'older-1', content: 'Hello chain', author, createdAt: new Date(Date.now() - 60 * 60_000) });
    act(() => queryClient.setQueryData(HOME, page([older, existing])));
    expect(homeIds()).toEqual([localId, 'older-1', 'existing-1']);
    expect(fakeEngine.method('writes.check')).not.toHaveBeenCalled();

    // The refresh has the post that landed: one card, the real post, and the engine is asked to confirm it.
    const landed = fixturePost({ id: 'landed-1', content: 'Hello chain', author, createdAt: new Date() });
    act(() => queryClient.setQueryData(HOME, page([landed, older, existing])));
    expect(homeIds()).toEqual(['landed-1', 'older-1', 'existing-1']);
    await settle();
    expect(fakeEngine.method('writes.check')).toHaveBeenCalledWith(t.id);
    // Still unproved by the engine: the real post carries the row, and no card comes back.
    const { result } = renderHook(() => usePendingWriteStatus('landed-1'));
    expect(result.current?.status).toEqual({ state: 'posting' });
    act(() => queryClient.setQueryData(PROFILE, page([landed, existing])));
    expect(queryClient.getQueryData<InfiniteData<Page<PostDTO>>>(PROFILE)?.pages[0]?.items.map((p) => p.id)).toEqual([
      'landed-1',
      'existing-1',
    ]);

    // The engine proves it: the post is normal.
    act(() =>
      fakeEngine.emit('write.status', advance(t, { state: 'confirmed', error: null, documents: [doc(0, 'landed-1')] })),
    );
    expect(usePendingPosts.getState().entries[localId]?.confirmedAt).toBeTruthy();
    expect(renderHook(() => usePendingWriteStatus('landed-1')).result.current).toBeNull();
    expect(homeIds()).toEqual(['landed-1', 'older-1', 'existing-1']);
  });

  it('a call cut short that the engine never took is not sent: "Couldn\'t post · Retry · Edit" (D-L1i-005)', async () => {
    fakeEngine.method('posts.publish').mockRejectedValue(Object.assign(new Error('restarted'), { code: 'ENGINE_RESTARTED' }));
    fakeEngine.method('writes.list').mockResolvedValue([]);
    const localId = publish(['Hello']);
    await settle();
    expect(pendingStatus(only()!)).toEqual({ state: 'posting' });

    // A restored ticket of another post (another target) is not this one's.
    const other = ticket({ op: 'post.publish', identityId: VIEWER_ID, target: { id: 'someone-else', kind: 'post', ownerId: 'x', rootPostId: null } });
    fakeEngine.method('writes.list').mockResolvedValue([advance(other, { state: 'unconfirmed' })]);
    // Too long ago, a ticket that confirmed would no longer be listed: that proves nothing, so the
    // check settles nothing (never Retry).
    usePendingPosts.setState(({ entries }) => ({
      entries: { [localId]: { ...entries[localId]!, submittedAt: Date.now() - 20 * 60_000 } },
    }));
    await nextCheck(orphanJob(localId));
    expect(pendingStatus(only()!)).toEqual({ state: 'posting' });
    // Long enough ago that any ticket the call made would show, and recent enough that it would still be listed.
    usePendingPosts.setState(({ entries }) => ({
      entries: { [localId]: { ...entries[localId]!, submittedAt: Date.now() - 2 * 60_000 } },
    }));
    await nextCheck(orphanJob(localId));
    expect(pendingStatus(only()!)).toEqual({ state: 'failed' });
    expect(loadDraft(VIEWER_ID, POST)?.parts.map((p) => p.text)).toEqual(['Hello']);

    // Retry publishes it again: it never went out.
    const t = publishTicket();
    fakeEngine.method('posts.publish').mockResolvedValue(t);
    retryPending(localId);
    await settle();
    expect(fakeEngine.method('posts.publish')).toHaveBeenCalledTimes(2);
    expect(only()?.ticketId).toBe(t.id);
    expect(pendingStatus(only()!)).toEqual({ state: 'posting' });
  });

  it('never calls a cut-short post unsent while a ticket that could be its own is listed', async () => {
    fakeEngine.method('posts.publish').mockRejectedValue(Object.assign(new Error('restarted'), { code: 'ENGINE_RESTARTED' }));
    fakeEngine.method('writes.list').mockResolvedValue([]);
    const first = publish(['first']);
    publish(['second']);
    await settle();
    const old = Date.now() - 2 * 60_000;
    usePendingPosts.setState(({ entries }) => ({
      entries: Object.fromEntries(Object.entries(entries).map(([id, e]) => [id, { ...e, submittedAt: old, createdAt: old }])),
    }));
    // One restored ticket that either could have made: neither is adopted, and neither is called unsent.
    const restored = { ...publishTicket(), createdAt: new Date(old) };
    fakeEngine.method('writes.list').mockResolvedValue([advance(restored, { state: 'unconfirmed' })]);
    await nextCheck(orphanJob(first));
    expect(Object.values(usePendingPosts.getState().entries).map(pendingStatus)).toEqual([
      { state: 'posting' },
      { state: 'posting' },
    ]);

    // Nor while a busy engine's ticket for it came minutes later.
    const stale = Date.now() - 12 * 60_000;
    usePendingPosts.setState(({ entries }) => ({
      entries: Object.fromEntries(Object.entries(entries).map(([id, e]) => [id, { ...e, submittedAt: stale, createdAt: stale }])),
    }));
    const late = { ...publishTicket(), createdAt: new Date(stale + 3 * 60_000) };
    fakeEngine.method('writes.list').mockResolvedValue([advance(late, { state: 'unconfirmed' })]);
    await nextCheck(orphanJob(first));
    expect(pendingStatus(usePendingPosts.getState().entries[first]!)).toEqual({ state: 'posting' });
    expect(fakeEngine.method('posts.publish')).toHaveBeenCalledTimes(2);
  });

  it('once the automatic checks of a cut-short post run out unsettled: "Couldn\'t confirm · Edit", said once, never Retry', async () => {
    jest.useFakeTimers();
    try {
      fakeEngine.method('posts.publish').mockRejectedValue(Object.assign(new Error('restarted'), { code: 'ENGINE_RESTARTED' }));
      // A ticket either of two posts could have made: the checks can never tell.
      fakeEngine.method('writes.list').mockImplementation(async () => [advance({ ...publishTicket(), createdAt: new Date() }, { state: 'unconfirmed' })]);
      const first = publish(['first']);
      publish(['second']);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(80_000 - 1);
      });
      expect(pendingStatus(usePendingPosts.getState().entries[first]!)).toEqual({ state: 'posting' });
      expect(toastMessage()).toBeUndefined();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1);
      });
      expect(isExhausted(orphanJob(first))).toBe(true);
      expect(pendingStatus(usePendingPosts.getState().entries[first]!)).toEqual({ state: 'unconfirmed' });
      expect(toastMessage()).toBe(POST_UNCONFIRMED_TEXT);
      const { result } = renderHook(() => usePendingWriteStatus(first));
      expect(result.current?.status).toEqual({ state: 'unconfirmed' });
      retryPending(first);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(fakeEngine.method('posts.publish')).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a cut-short post a refresh shows on chain is normal, though its ticket is long gone (D-L1a-001)', async () => {
    fakeEngine.method('posts.publish').mockRejectedValue(Object.assign(new Error('restarted'), { code: 'ENGINE_RESTARTED' }));
    fakeEngine.method('writes.list').mockResolvedValue([]);
    const localId = publish(['Landed while away']);
    await settle();
    const away = Date.now() - 15 * 60_000;
    usePendingPosts.setState(({ entries }) => ({
      entries: { [localId]: { ...entries[localId]!, submittedAt: away, createdAt: away } },
    }));
    const author = { ...AUTHORS.alice, id: VIEWER_ID };
    // The same words from well before it are not it.
    const older = fixturePost({ id: 'older-1', content: 'Landed while away', author, createdAt: new Date(away - 3 * 60_000) });
    act(() => queryClient.setQueryData(HOME, page([older, existing])));
    expect(homeIds()).toEqual([localId, 'older-1', 'existing-1']);

    const landed = fixturePost({ id: 'landed-1', content: 'Landed while away', author, createdAt: new Date(away + 2000) });
    act(() => queryClient.setQueryData(HOME, page([landed, older, existing])));
    expect(homeIds()).toEqual(['landed-1', 'older-1', 'existing-1']);
    expect(usePendingPosts.getState().entries[localId]?.confirmedAt).toBeTruthy();
    expect(renderHook(() => usePendingWriteStatus('landed-1')).result.current).toBeNull();
    // Nothing was sent, and no toast: the user asked for nothing.
    expect(fakeEngine.method('posts.publish')).toHaveBeenCalledTimes(1);
    expect(toastMessage()).toBeUndefined();
    // The next refresh keeps one copy.
    act(() => queryClient.setQueryData(PROFILE, page([landed, existing])));
    expect(queryClient.getQueryData<InfiniteData<Page<PostDTO>>>(PROFILE)?.pages[0]?.items.map((p) => p.id)).toEqual([
      'landed-1',
      'existing-1',
    ]);
  });

  it('a post the engine cannot tell apart reads "Couldn\'t confirm · Edit" once its checks run out, and settles if a later check finds it', async () => {
    jest.useFakeTimers();
    try {
      const t = publishTicket();
      fakeEngine.method('posts.publish').mockResolvedValue(t);
      const localId = publish(['gm']);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      const unconfirmed = advance(t, { state: 'unconfirmed', error: restartedUnknown, documents: [] });
      act(() => fakeEngine.emit('write.status', unconfirmed));
      fakeEngine.method('writes.check').mockImplementation(async () => ({ ...unconfirmed, lastCheckedAt: new Date() }));

      // Checked at 5 and 20 s: still "Posting…", nothing said.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(20_000);
      });
      expect(fakeEngine.method('writes.check')).toHaveBeenCalledTimes(2);
      expect(pendingStatus(only()!)).toEqual({ state: 'posting' });
      expect(toastMessage()).toBeUndefined();

      // The 80 s check is the last: "Couldn't confirm · Edit", never Retry, and a toast once.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });
      expect(fakeEngine.method('writes.check')).toHaveBeenCalledTimes(3);
      expect(isExhausted(ticketJob(t.id))).toBe(true);
      expect(pendingStatus(only()!)).toEqual({ state: 'unconfirmed' });
      const { result } = renderHook(() => usePendingWriteStatus(localId));
      expect(result.current?.status).toEqual({ state: 'unconfirmed' });
      expect(toastMessage()).toBe(POST_UNCONFIRMED_TEXT);
      act(() => useToastStore.setState({ current: null }));
      await act(async () => {
        await jest.advanceTimersByTimeAsync(10 * 60_000);
      });
      expect(fakeEngine.method('writes.check')).toHaveBeenCalledTimes(3);
      expect(toastMessage()).toBeUndefined();

      // A refresh that shows it adopts it, and checks it again.
      const author = { ...AUTHORS.alice, id: VIEWER_ID };
      const landed = fixturePost({ id: 'landed-1', content: 'gm', author, createdAt: new Date() });
      act(() => queryClient.setQueryData(HOME, page([landed, existing])));
      expect(homeIds()).toEqual(['landed-1', 'existing-1']);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(fakeEngine.method('writes.check')).toHaveBeenCalledTimes(4);

      // Edit takes it back: the text to compose (the landed part kept posted), the ticket dismissed.
      act(() => editPending(localId));
      expect(router.push).toHaveBeenCalled();
      expect(loadDraft(VIEWER_ID, POST)?.parts).toEqual([{ text: 'gm', postedId: 'landed-1' }]);
      expect(usePendingPosts.getState().entries[localId]).toBeUndefined();
      expect(fakeEngine.method('writes.dismiss')).toHaveBeenCalledWith(t.id);
      expect(homeIds()).toEqual(['landed-1', 'existing-1']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('after an app kill a second after Post, the relaunched card reads "Posting…" and the landed post replaces it (QA D-L2a-001)', async () => {
    // Killed before the engine answered: the post went out, but the card never learned its ticket.
    fakeEngine.method('posts.publish').mockReturnValue(new Promise(() => undefined));
    const localId = publish(['Killed mid-post']);
    const stored = syncStorage.getItem(PENDING_KEY);
    expect(stored).toContain(localId);
    const sentAt = only()!.createdAt;
    // This launch is gone (its store forgets the card, which clears the key: put it back as the kill left it).
    usePendingPosts.setState({ entries: {} });
    syncStorage.setItem(PENDING_KEY, stored!);

    // The next engine restores the ticket the call made as unconfirmed (ENGINE_RESTARTED).
    const restored = advance(publishTicket(), {
      state: 'unconfirmed',
      stage: null,
      error: restartedUnknown,
      documents: [],
      createdAt: new Date(sentAt + 300),
    });
    fakeEngine.method('writes.list').mockResolvedValue([restored]);
    fakeEngine.method('writes.get').mockResolvedValue(restored);
    const found = advance(restored, { state: 'confirmed', error: null, documents: [doc(0, 'landed-1')] });
    fakeEngine.method('writes.check').mockImplementation(async () => {
      fakeEngine.emit('write.status', found);
      return found;
    });

    await jest.isolateModulesAsync(async () => {
      // A fresh launch of the app over the same storage.
      const relaunched = jest.requireActual<typeof import('./pending-posts')>('./pending-posts');
      const { queryClient: client } = jest.requireActual<typeof import('~/state/query-client')>('~/state/query-client');
      const session = jest.requireActual<typeof import('~/data/session')>('~/data/session');
      session.useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
      const ids = () => client.getQueryData<InfiniteData<Page<PostDTO>>>(HOME)?.pages[0]?.items.map((p) => p.id);
      const stopRelaunched = relaunched.startPendingPosts();
      try {
        const card = () => relaunched.usePendingPosts.getState().entries[localId];
        expect(card()?.orphaned).toBe(true);
        expect(relaunched.pendingStatus(card()!)).toEqual({ state: 'posting' });
        await settle();
        // It follows the restored ticket, still "Posting…" while it is checked: never "Couldn't confirm" yet.
        expect(card()?.ticketId).toBe(restored.id);
        expect(relaunched.pendingStatus(card()!)).toEqual({ state: 'posting' });

        // The saved Home shows the card on top.
        act(() => client.setQueryData(HOME, page([existing])));
        expect(ids()).toEqual([localId, 'existing-1']);

        // The refresh has the post that landed: it replaces the card, and the engine confirms it.
        const author = { ...AUTHORS.alice, id: VIEWER_ID };
        const landed = fixturePost({ id: 'landed-1', content: 'Killed mid-post', author, createdAt: new Date(sentAt + 2000) });
        act(() => client.setQueryData(HOME, page([landed, existing])));
        expect(ids()).toEqual(['landed-1', 'existing-1']);
        await settle();
        expect(fakeEngine.method('writes.check')).toHaveBeenCalledWith(restored.id);
        expect(card()?.confirmedAt).toBeTruthy();
        expect(relaunched.pendingStatus(card()!)).toBeNull();
        expect(ids()).toEqual(['landed-1', 'existing-1']);
        // Nothing was sent again.
        expect(fakeEngine.method('posts.publish')).toHaveBeenCalledTimes(1);
        expect(fakeEngine.method('writes.retry')).not.toHaveBeenCalled();
      } finally {
        stopRelaunched();
        client.clear();
      }
    });
  });
});

it('checks a post whose ticket was already unconfirmed before a relaunch: the engine never reports it again', async () => {
  jest.useFakeTimers();
  try {
    const t = publishTicket();
    fakeEngine.method('posts.publish').mockResolvedValue(t);
    const localId = publish(['From before']);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    const unconfirmed = advance(t, { state: 'unconfirmed', documents: [doc(0, 'before-1', false)] });
    // The app restarts: nothing reconciles this ticket yet (the event was the last launch's).
    usePendingPosts.setState(({ entries }) => ({ entries: { [localId]: { ...entries[localId]!, ticket: unconfirmed } } }));
    resetWriteTracking();
    fakeEngine.method('writes.get').mockResolvedValue(unconfirmed);
    fakeEngine.method('writes.list').mockResolvedValue([unconfirmed]);
    const found = advance(unconfirmed, { state: 'confirmed', documents: [doc(0, 'before-1')] });
    fakeEngine.method('writes.check').mockImplementation(async () => {
      fakeEngine.emit('write.status', found);
      return found;
    });
    // A new engine, the same account: the account is resumed.
    act(() => fakeEngine.setStatus({ epoch: 99 }));
    act(() => useSessionStore.setState({ status: 'signed-in', session: { ...viewer } }));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(fakeEngine.method('writes.get')).toHaveBeenCalledWith(t.id);
    expect(isExhausted(ticketJob(t.id))).toBe(false);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(fakeEngine.method('writes.check')).toHaveBeenCalledWith(t.id);
    expect(usePendingPosts.getState().entries[localId]?.confirmedAt).toBeTruthy();
  } finally {
    act(() => fakeEngine.setStatus({ epoch: 1 }));
    jest.useRealTimers();
  }
});

describe('a post whose call never answers (a DAPI stall: QA D-L2a-007)', () => {
  const stillSending: EngineErrorData = {
    code: 'STILL_SENDING',
    consensusCode: null,
    outcome: 'unknown',
    retryable: false,
    userMessage: "Still waiting for this write's answer.",
  };

  it('stays "Posting…" while the engine says the call still runs, never offers Edit, and is normal when it answers', async () => {
    jest.useFakeTimers();
    try {
      const t = publishTicket();
      fakeEngine.method('posts.publish').mockResolvedValue(t);
      publish(['Through a stall']);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(pendingStatus(only()!)).toEqual({ state: 'posting' });

      // A minute without an answer (the engine's deadline).
      const unconfirmed = advance(t, { state: 'unconfirmed', stage: null, error: stillSending });
      act(() => fakeEngine.emit('write.status', unconfirmed));
      expect(pendingStatus(only()!)).toEqual({ state: 'posting' });
      expect(toastMessage()).toBeUndefined();
      // Its text stays with the card: it may still land.
      expect(loadDraft(VIEWER_ID, POST)).toBeNull();

      // Its checks, the call still running: they never run out, so no Edit (posted again, it would land twice), no Retry.
      const checked = advance(unconfirmed, { lastCheckedAt: new Date() });
      fakeEngine.method('writes.check').mockImplementation(async () => {
        fakeEngine.emit('write.status', checked);
        return checked;
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(20 * 60_000);
      });
      expect(fakeEngine.method('writes.check')).toHaveBeenCalledWith(t.id);
      expect(pendingStatus(only()!)).toEqual({ state: 'posting' });
      expect(toastMessage()).toBeUndefined();

      // The stall clears and the call answers: the card is the real post.
      act(() =>
        fakeEngine.emit('write.status', advance(checked, { state: 'confirmed', error: null, documents: [doc(0, 'real-1')] })),
      );
      expect(homeIds()).toEqual(['real-1', 'existing-1']);
      expect(toastMessage()).toBe('Posted');
      expect(fakeEngine.method('posts.publish')).toHaveBeenCalledTimes(1);
      expect(fakeEngine.method('writes.retry')).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a resumed thread (no card) keeps its text off the draft while its call runs, and gets it back once that answers unproved', async () => {
    const t = publishTicket();
    fakeEngine.method('posts.publish').mockResolvedValue(t);
    const localId = publishPost(
      {
        identityId: VIEWER_ID,
        context: POST,
        parts: [{ text: 'one', postedId: 'root-1' }, ...parts('two', 'three')],
        sensitive: false,
        mediaUrl: null,
        target: null,
        author: viewerAuthor(VIEWER_ID, 'alice'),
      },
      hasVisibleContent,
    );
    await settle();
    expect(only()?.placement).toBe('none');

    // Still running: its parts may still land, so the draft does not offer them to post again.
    const stalled = advance(t, { state: 'unconfirmed', stage: null, error: stillSending });
    act(() => fakeEngine.emit('write.status', stalled));
    expect(loadDraft(VIEWER_ID, POST)).toBeNull();
    expect(usePendingPosts.getState().entries[localId]).toBeTruthy();
    expect(fakeEngine.method('writes.dismiss')).not.toHaveBeenCalled();

    // The call answers with a part it cannot prove: now the text comes back, the posted root kept posted.
    act(() => fakeEngine.emit('write.status', advance(stalled, { error: null, documents: [doc(1, 'two-1')] })));
    expect(loadDraft(VIEWER_ID, POST)?.parts).toEqual([
      { text: 'one', postedId: 'root-1' },
      { text: 'two', postedId: 'two-1' },
      { text: 'three', postedId: null },
    ]);
  });
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

it("signing out another account deletes that account's drafts and pending posts (SR-09, AUTH-11)", async () => {
  const OTHER = 'other-account';
  const account = (identityId: string, active: boolean): AccountDTO => ({
    identityId,
    username: null,
    method: 'key',
    lastUsedAt: new Date(0),
    active,
  });
  const draft = (text: string) => ({ context: POST, parts: parts(text), sensitive: false, mediaUrl: '', updatedAt: Date.now() });
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish', identityId: OTHER }));
  // A post the other account left on its way while it was active.
  publishPost(
    {
      identityId: OTHER,
      context: POST,
      parts: parts('Theirs'),
      sensitive: false,
      mediaUrl: null,
      target: null,
      author: viewerAuthor(OTHER, null),
    },
    hasVisibleContent,
  );
  await settle();
  saveDraft(OTHER, draft('SR-draft'));
  saveDraft(VIEWER_ID, draft('Mine'));
  act(() => useSessionStore.setState({ accounts: [account(VIEWER_ID, true), account(OTHER, false)] }));
  expect(Object.values(usePendingPosts.getState().entries).map((e) => e.identityId)).toEqual([OTHER]);

  // The engine announces no session change for a non-active account; only the list shrinks.
  act(() => useSessionStore.setState({ accounts: [account(VIEWER_ID, true)] }));

  expect(loadDraft(OTHER, POST)).toBeNull();
  expect(usePendingPosts.getState().entries).toEqual({});
  expect(loadDraft(VIEWER_ID, POST)?.parts[0]?.text).toBe('Mine');
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
