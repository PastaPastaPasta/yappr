import type { CapabilitiesDTO, SessionDTO, UserSummaryDTO } from '@engine/api';
import { useNetInfo } from '@react-native-community/netinfo';
import { notifyManager, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { ActionSheetIOS, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { queryKeys } from '~/data/keys';
import { useSessionStore } from '~/data/session';
import { fakeEngine, ticket } from '~/data/testing/fake-engine';
import { queryClient } from '~/state/query-client';
import { AUTHORS, VIEWER_ID, fixturePost } from '~/ui/post/fixtures';

import { ComposeScreen } from './ComposeScreen';
import { deleteDraft, isDraftSlotHeld, loadDraft, saveDraft, type ComposeContext } from './drafts';
import { usePendingPosts } from './pending-posts';

jest.mock('~/engine', () => jest.requireActual('~/data/testing/fake-engine').engineModule);
const mockNavigation = { addListener: jest.fn(() => () => undefined), dispatch: jest.fn() };
jest.mock('expo-router', () => ({
  router: { back: jest.fn(), push: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: jest.fn(() => ({})),
  useNavigation: () => mockNavigation,
}));
// The close guard: the latest callback the screen registered, as the native stack calls it on a swipe.
let mockPreventRemove: ((options: { data: { action: { type: string } } }) => void) | null = null;
jest.mock('expo-router/react-navigation', () => ({
  usePreventRemove: (prevent: boolean, callback: typeof mockPreventRemove) => {
    mockPreventRemove = prevent ? callback : null;
  },
}));
jest.mock('@react-native-community/netinfo', () => ({
  ...jest.requireActual('@react-native-community/netinfo/jest/netinfo-mock.js'),
  useNetInfo: jest.fn(() => ({ isConnected: true })),
}));

const viewer: SessionDTO = {
  identityId: VIEWER_ID,
  network: 'devnet',
  username: 'alice',
  credits: 1n,
  hasEncryptionKey: true,
  method: 'key',
};
const POST: ComposeContext = { mode: 'post', targetId: null };
const CAPABILITIES = { contentLimits: { chars: 20, bytes: 40 }, hashtagsInline: true } as CapabilitiesDTO;

const METRICS = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

const byId = (id: string) => screen.getByTestId(id);
const postButton = () => byId('compose-post');
const type = (text: string, index = 0) => fireEvent.changeText(byId(`compose-input-${index}`), text);

/** Renders compose and lets its reads (the viewer's profile, the target) settle. */
async function renderCompose() {
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={queryClient}>
        <ComposeScreen />
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
  await act(async () => {});
}

let sheet: { options: string[]; choose: (label: string) => void } | null = null;

beforeAll(() => notifyManager.setScheduler((callback) => callback()));
afterAll(() => queryClient.clear());

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  fakeEngine.reset();
  queryClient.clear();
  usePendingPosts.setState({ entries: {} });
  deleteDraft(VIEWER_ID, POST);
  fakeEngine.setStatus({ state: 'ready', info: { capabilities: CAPABILITIES } });
  useSessionStore.setState({ status: 'signed-in', session: viewer, accounts: [] });
  fakeEngine.method('profiles.get').mockResolvedValue(null);
  jest.mocked(useLocalSearchParams).mockReturnValue({});
  jest.mocked(useNetInfo).mockReturnValue({ isConnected: true } as ReturnType<typeof useNetInfo>);
  sheet = null;
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((options, callback) => {
    const labels = options.options;
    sheet = { options: labels, choose: (label) => callback(labels.indexOf(label)) };
  });
});

it('asks a signed-out user to sign in', async () => {
  useSessionStore.setState({ status: 'signed-out', session: null });
  await renderCompose();
  expect(screen.getByText('Sign in to post')).toBeTruthy();
  fireEvent.press(screen.getByText('Sign in'));
  expect(router.replace).toHaveBeenCalledWith('/sign-in');
});

it('enables Post once there is visible text, and posts: the sheet closes', async () => {
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  await renderCompose();
  expect(postButton()).toBeDisabled();

  type('​  ');
  expect(postButton()).toBeDisabled();

  type('Hello #dash');
  expect(postButton()).toBeEnabled();
  expect(byId('compose-counter')).toHaveAccessibleName('9 characters left');
  expect(byId('compose-counter')).toHaveTextContent('9');

  await act(async () => fireEvent.press(postButton()));
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledWith(
    expect.objectContaining({ parts: [{ text: 'Hello #dash' }], sensitive: false, mediaUrl: null }),
  );
  expect(router.back).toHaveBeenCalled();
  expect(Object.keys(usePendingPosts.getState().entries)).toHaveLength(1);
});

it('disables Post over the limit: the counter goes below 0 and the post says it is too long (#19)', async () => {
  await renderCompose();
  type('x'.repeat(20));
  expect(postButton()).toBeEnabled();
  expect(byId('compose-counter')).toHaveTextContent('0');
  expect(screen.queryByTestId('compose-too-long-0')).toBeNull();

  type('x'.repeat(23));
  expect(postButton()).toBeDisabled();
  expect(byId('compose-counter')).toHaveTextContent('-3');
  expect(byId('compose-counter')).toHaveAccessibleName('Too long by 3');
  expect(byId('compose-too-long-0')).toHaveTextContent('Your post is too long.');

  // 11 emoji are 11 characters but 44 bytes: the counter counts the bytes, and never says "bytes".
  type('😀'.repeat(11));
  expect(postButton()).toBeDisabled();
  expect(byId('compose-counter')).toHaveTextContent('-4');
  expect(byId('compose-counter')).toHaveAccessibleName('Too long by 4');
  expect(byId('compose-too-long-0')).toHaveTextContent('Your post is too long.');
  expect(screen.queryByText(/bytes/)).toBeNull();

  type('😀'.repeat(10));
  expect(postButton()).toBeEnabled();
  expect(byId('compose-counter')).toHaveTextContent('0');
});

it('says who a post with several mentions notifies, and nothing about tags (#11)', async () => {
  await renderCompose();
  type('gm @bob #a #b');
  expect(screen.queryByTestId('compose-mention-note-0')).toBeNull();
  type('@bob @alice #a #b');
  expect(byId('compose-mention-note-0')).toHaveTextContent('Only @bob will be notified.');
  expect(screen.queryByText(/tag page|Tags can be/)).toBeNull();
});

it('scrolls the end of a long paste, and the line saying why it is over, into view (D-L2i-001)', async () => {
  const scrollTo = jest.mocked(ScrollView.prototype.scrollTo);
  await renderCompose();
  const layout = (id: string, y: number, height: number) =>
    fireEvent(byId(id), 'layout', { nativeEvent: { layout: { x: 0, y, width: 390, height } } });
  // The space above the keyboard, and the editor before the paste.
  layout('compose-scroll', 0, 300);
  layout('compose-part-0', 8, 60);
  scrollTo.mockClear();

  type('😀'.repeat(11));
  // The editor grows with the pasted text and the too-long line under it.
  layout('compose-part-0', 8, 520);
  expect(scrollTo).toHaveBeenLastCalledWith({ y: 228, animated: true });

  // Scrolled there, a layout that changes nothing scrolls no further, nor does an edit in the middle.
  fireEvent.scroll(byId('compose-scroll'), { nativeEvent: { contentOffset: { x: 0, y: 228 } } });
  scrollTo.mockClear();
  layout('compose-part-0', 8, 520);
  type(`x${'😀'.repeat(11)}`);
  layout('compose-part-0', 8, 560);
  expect(scrollTo).not.toHaveBeenCalled();
});

it('leaves a later layout of the part, not an edit, where it is', async () => {
  const scrollTo = jest.mocked(ScrollView.prototype.scrollTo);
  await renderCompose();
  const layout = (id: string, y: number, height: number) =>
    fireEvent(byId(id), 'layout', { nativeEvent: { layout: { x: 0, y, width: 390, height } } });
  layout('compose-scroll', 0, 300);
  layout('compose-part-0', 8, 60);
  // Typed at the end without growing the editor: no layout follows the edit.
  type('Hi');
  // The frame after the edit has revealed what it had to (nothing: it fits).
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  scrollTo.mockClear();
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 2_000);
  try {
    // Seconds later the part lays out taller for another reason (its media row, a part removed above).
    layout('compose-part-0', 8, 520);
    expect(scrollTo).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

it('is offline: Post disabled and the bar says so', async () => {
  jest.mocked(useNetInfo).mockReturnValue({ isConnected: false } as ReturnType<typeof useNetInfo>);
  await renderCompose();
  type('Hello');
  expect(postButton()).toBeDisabled();
  expect(screen.getByText("You're offline")).toBeTruthy();
  expect(screen.queryByTestId('compose-add-part')).toBeNull();
});

it('builds a thread: add, count, remove', async () => {
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  await renderCompose();
  type('one');
  fireEvent.press(byId('compose-add-part'));
  type('two', 1);
  expect(screen.getByText('Post all (2)')).toBeTruthy();
  expect(byId('compose-input-1').props.placeholder).toBe('Continue your thread...');

  fireEvent.press(byId('compose-add-part'));
  fireEvent.press(byId('compose-remove-2'));
  expect(screen.queryByTestId('compose-input-2')).toBeNull();

  await act(async () => fireEvent.press(postButton()));
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledWith(
    expect.objectContaining({ parts: [{ text: 'one' }, { text: 'two' }] }),
  );
});

it('sets the NSFW flag', async () => {
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  await renderCompose();
  type('spicy');
  fireEvent.press(byId('compose-nsfw'));
  expect(byId('compose-nsfw')).toBeChecked();
  await act(async () => fireEvent.press(postButton()));
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledWith(expect.objectContaining({ sensitive: true }));
});

it('takes a hosted image link and refuses anything else, never naming URL schemes (#27)', async () => {
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  await renderCompose();
  type('look');
  expect(byId('compose-media-toggle')).toHaveAccessibleName('Add image link');
  fireEvent.press(byId('compose-media-toggle'));
  expect(byId('compose-media-url').props.placeholder).toBe('Paste an image link');
  fireEvent.changeText(byId('compose-media-url'), 'javascript:alert(1)');
  expect(postButton()).toBeDisabled();
  expect(byId('compose-media-error')).toHaveTextContent("That doesn't look like an image link.");
  expect(screen.queryByText(/https:\/\/|ipfs:\/\//)).toBeNull();

  // IPFS links are taken, without the field ever saying so.
  fireEvent.changeText(byId('compose-media-url'), 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
  expect(screen.queryByTestId('compose-media-error')).toBeNull();
  fireEvent.changeText(byId('compose-media-url'), `https://example.com/${'a'.repeat(520)}.png`);
  expect(byId('compose-media-error')).toHaveTextContent('That link is too long.');

  fireEvent.changeText(byId('compose-media-url'), 'https://example.com/cat.png');
  // The preview follows once typing pauses.
  expect(screen.queryByTestId('compose-media-preview')).toBeNull();
  expect(await screen.findByTestId('compose-media-preview', {}, { timeout: 2000 })).toBeTruthy();
  await act(async () => fireEvent.press(postButton()));
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledWith(
    expect.objectContaining({ mediaUrl: 'https://example.com/cat.png' }),
  );
});

it('restores the draft, and closing asks Save draft / Delete draft', async () => {
  saveDraft(VIEWER_ID, {
    context: POST,
    parts: [{ text: 'kept text', postedId: null }],
    sensitive: true,
    mediaUrl: '',
    updatedAt: Date.now(),
  });
  await renderCompose();
  expect(byId('compose-input-0')).toHaveTextContent('kept text');
  expect(byId('compose-nsfw')).toBeChecked();

  fireEvent.press(byId('compose-close'));
  expect(sheet?.options).toEqual(['Save draft', 'Delete draft', 'Cancel']);
  act(() => sheet?.choose('Delete draft'));
  expect(loadDraft(VIEWER_ID, POST)).toBeNull();
  expect(router.back).toHaveBeenCalled();
});

it('holds a native dismissal (a swipe) for Save draft / Delete draft / Cancel (COMP-09)', async () => {
  await renderCompose();
  type('swiped text');
  const pop = { type: 'POP' };

  act(() => mockPreventRemove?.({ data: { action: pop } }));
  expect(sheet?.options).toEqual(['Save draft', 'Delete draft', 'Cancel']);
  act(() => sheet?.choose('Cancel'));
  expect(mockNavigation.dispatch).not.toHaveBeenCalled();
  expect(byId('compose-input-0')).toHaveTextContent('swiped text');

  act(() => mockPreventRemove?.({ data: { action: pop } }));
  act(() => sheet?.choose('Save draft'));
  expect(loadDraft(VIEWER_ID, POST)?.parts[0]?.text).toBe('swiped text');
  expect(mockNavigation.dispatch).toHaveBeenCalledWith(pop);
});

it('saves the draft 500 ms after a change', async () => {
  jest.useFakeTimers();
  await renderCompose();
  type('draft me');
  act(() => jest.advanceTimersByTime(600));
  expect(loadDraft(VIEWER_ID, POST)?.parts[0]?.text).toBe('draft me');
  jest.useRealTimers();
});

it('closes an empty composer at once', async () => {
  await renderCompose();
  fireEvent.press(byId('compose-close'));
  expect(sheet).toBeNull();
  expect(router.back).toHaveBeenCalled();
});

it('suggests mentions after 3 characters and inserts the pick', async () => {
  jest.useFakeTimers();
  const sigrid: UserSummaryDTO = { ...AUTHORS.carol, id: 'sig-1', username: 'sigrid', displayName: 'Sigrid' };
  fakeEngine.method('posts.mentionCandidates').mockResolvedValue([sigrid]);
  await renderCompose();
  const input = byId('compose-input-0');
  fireEvent.changeText(input, 'hi @sig');
  fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 7, end: 7 } } });
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
  expect(fakeEngine.method('posts.mentionCandidates')).toHaveBeenCalledWith('sig');
  // A floor, not a fixed height: the row grows at the largest text sizes (G-12).
  expect(StyleSheet.flatten((await screen.findByTestId('mention-sigrid')).props.style)).toMatchObject({ minHeight: 56 });
  expect(StyleSheet.flatten(byId('mention-sigrid').props.style).height).toBeUndefined();
  fireEvent.press(await screen.findByTestId('mention-sigrid'));
  expect(byId('compose-input-0')).toHaveTextContent('hi @sigrid');
  jest.useRealTimers();
});

it('replies: the target preview, "Reply", and the reply target', async () => {
  const target = fixturePost({ id: 'target-1', author: AUTHORS.bob });
  queryClient.setQueryData(queryKeys.post.detail('target-1'), target);
  fakeEngine.method('posts.get').mockResolvedValue(target);
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  jest.mocked(useLocalSearchParams).mockReturnValue({ replyTo: 'target-1' });
  await renderCompose();

  expect(screen.getByText('Reply')).toBeTruthy();
  expect(byId('compose-input-0').props.placeholder).toBe('Post your reply');
  expect(screen.queryByTestId('compose-add-part')).toBeNull();
  expect(byId('compose-reply-context')).toHaveTextContent(`Replying to @${AUTHORS.bob.username}`, { exact: false });

  type('agreed');
  await act(async () => fireEvent.press(postButton()));
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledWith(
    expect.objectContaining({ replyTo: expect.objectContaining({ id: 'target-1', ownerId: AUTHORS.bob.id }) }),
  );
});

it('quotes: the embed and "Add a comment"', async () => {
  const target = fixturePost({ id: 'target-2' });
  queryClient.setQueryData(queryKeys.post.detail('target-2'), target);
  fakeEngine.method('posts.get').mockResolvedValue(target);
  jest.mocked(useLocalSearchParams).mockReturnValue({ quote: 'target-2' });
  await renderCompose();
  expect(byId('compose-input-0').props.placeholder).toBe('Add a comment');
  expect(byId('compose-quote')).toBeTruthy();
});

it('posting a draft that came back from a failed post replaces that card', async () => {
  jest.useFakeTimers();
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  usePendingPosts.setState({
    entries: { 'pending-old': { localId: 'pending-old', identityId: VIEWER_ID } as never },
  });
  saveDraft(VIEWER_ID, {
    context: POST,
    parts: [{ text: 'came back', postedId: null }],
    sensitive: false,
    mediaUrl: '',
    updatedAt: Date.now(),
    fromPending: 'pending-old',
  });
  await renderCompose();
  // Saved unedited, the draft keeps its link to the failed post.
  act(() => jest.advanceTimersByTime(600));
  expect(loadDraft(VIEWER_ID, POST)?.fromPending).toBe('pending-old');
  type('came back, edited');
  act(() => jest.advanceTimersByTime(600));
  expect(loadDraft(VIEWER_ID, POST)?.fromPending).toBeUndefined();

  await act(async () => fireEvent.press(postButton()));
  expect(usePendingPosts.getState().entries['pending-old']).toBeUndefined();
  expect(Object.keys(usePendingPosts.getState().entries)).toHaveLength(1);
  jest.useRealTimers();
});

it('removing the focused part moves the counter to the part that takes the focus', async () => {
  await renderCompose();
  type('one');
  fireEvent.press(byId('compose-add-part'));
  fireEvent(byId('compose-input-1'), 'focus');
  type('a longer second part', 1);
  expect(byId('compose-counter')).toHaveAccessibleName('0 characters left');

  fireEvent.press(byId('compose-remove-1'));
  expect(byId('compose-counter')).toHaveAccessibleName('17 characters left');
});

it('a target that could not be read is not "deleted": it offers Retry', async () => {
  queryClient.setQueryDefaults(queryKeys.post.detail('target-3'), { retry: false });
  fakeEngine.method('posts.get').mockRejectedValue(Object.assign(new Error('read failed'), { code: 'NETWORK' }));
  jest.mocked(useLocalSearchParams).mockReturnValue({ replyTo: 'target-3' });
  await renderCompose();
  expect(byId('compose-target-unread')).toHaveTextContent("Couldn't load the post", { exact: false });
  expect(screen.queryByText("This post was deleted, so it can't be replied to.")).toBeNull();
  type('hi');
  expect(postButton()).toBeDisabled();

  const target = fixturePost({ id: 'target-3', author: AUTHORS.bob });
  fakeEngine.method('posts.get').mockResolvedValue(target);
  await act(async () => fireEvent.press(screen.getByText('Retry')));
  expect(screen.queryByTestId('compose-target-unread')).toBeNull();
  expect(postButton()).toBeEnabled();
});

it('a target proved missing (deleted or removed on v10) is unavailable, with no Retry', async () => {
  fakeEngine.method('posts.get').mockResolvedValue(null);
  jest.mocked(useLocalSearchParams).mockReturnValue({ replyTo: 'target-5' });
  await renderCompose();
  expect(screen.getByText("This post is unavailable, so it can't be replied to.")).toBeTruthy();
  expect(screen.queryByTestId('compose-target-unread')).toBeNull();
  expect(screen.queryByText('Retry')).toBeNull();
  type('hi');
  expect(postButton()).toBeDisabled();

  jest.mocked(useLocalSearchParams).mockReturnValue({ quote: 'target-5' });
  screen.unmount();
  await renderCompose();
  expect(byId('compose-target-missing')).toHaveTextContent('This post is unavailable.', { exact: false });
});

it('lets the header and the NSFW chip grow with the text size (G-12)', async () => {
  await renderCompose();
  expect(byId('compose-header').props.className).toContain('min-h-14');
  expect(byId('compose-header').props.className).not.toMatch(/(^|\s)h-14/);
  expect(byId('compose-nsfw').props.className).not.toMatch(/(^|\s)h-8/);
  expect(screen.getByText('NSFW').props.maxFontSizeMultiplier).toBe(1.5);
});

it('holds its draft slot while open, so a failed post never lands where it saves (SR-06)', async () => {
  await renderCompose();
  expect(isDraftSlotHeld(VIEWER_ID, POST)).toBe(true);
  screen.unmount();
  expect(isDraftSlotHeld(VIEWER_ID, POST)).toBe(false);
});

it('a double tap on Post publishes once', async () => {
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  await renderCompose();
  type('Hello');
  await act(async () => {
    fireEvent.press(postButton());
    fireEvent.press(postButton());
  });
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledTimes(1);
  expect(Object.keys(usePendingPosts.getState().entries)).toHaveLength(1);
});

it('refuses an image URL over the contract limit of 512 characters', async () => {
  await renderCompose();
  type('pic');
  fireEvent.press(byId('compose-media-toggle'));
  fireEvent.changeText(byId('compose-media-url'), `https://img.example/${'a'.repeat(600)}.png`);
  expect(byId('compose-media-error')).toHaveTextContent('That link is too long.');
  expect(postButton()).toBeDisabled();
  fireEvent.changeText(byId('compose-media-url'), 'https://img.example/a.png');
  expect(postButton()).toBeEnabled();
});

it('counts the text as posted: whitespace that posting trims is not over the limit', async () => {
  await renderCompose();
  type(`${'a'.repeat(20)}\n\n`);
  expect(byId('compose-counter')).toHaveAccessibleName('0 characters left');
  expect(postButton()).toBeEnabled();
});

it('a deleted target says so', async () => {
  fakeEngine.method('posts.get').mockResolvedValue(fixturePost({ id: 'target-4', deleted: true }));
  jest.mocked(useLocalSearchParams).mockReturnValue({ replyTo: 'target-4' });
  await renderCompose();
  expect(screen.getByText("This post was deleted, so it can't be replied to.")).toBeTruthy();
});

it("edits a failed post on a slot of its own, leaving the context's draft alone", async () => {
  jest.useFakeTimers();
  fakeEngine.method('posts.publish').mockResolvedValue(ticket({ op: 'post.publish' }));
  usePendingPosts.setState({
    entries: {
      'pending-a': {
        localId: 'pending-a',
        identityId: VIEWER_ID,
        context: POST,
        draft: { parts: [{ text: 'Post A' }], sensitive: false, mediaUrl: null, resume: null },
        ticket: null,
        ticketId: null,
        refused: true,
      } as never,
    },
  });
  saveDraft(VIEWER_ID, { context: POST, parts: [{ text: 'Draft B', postedId: null }], sensitive: false, mediaUrl: '', updatedAt: Date.now() });
  jest.mocked(useLocalSearchParams).mockReturnValue({ pending: 'pending-a' });
  await renderCompose();
  expect(byId('compose-input-0').props.value ?? byId('compose-input-0').props.children).toBe('Post A');
  type('Post A, edited');
  act(() => jest.advanceTimersByTime(600));
  expect(loadDraft(VIEWER_ID, POST)?.parts[0]?.text).toBe('Draft B');

  await act(async () => fireEvent.press(postButton()));
  expect(usePendingPosts.getState().entries['pending-a']).toBeUndefined();
  expect(fakeEngine.method('posts.publish')).toHaveBeenCalledWith(expect.objectContaining({ parts: [{ text: 'Post A, edited' }] }));
  expect(loadDraft(VIEWER_ID, POST)?.parts[0]?.text).toBe('Draft B');
  expect(loadDraft(VIEWER_ID, { ...POST, pendingId: 'pending-a' })).toBeNull();
  jest.useRealTimers();
});
