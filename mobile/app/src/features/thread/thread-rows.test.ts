import type { ThreadDTO, ThreadReplyDTO } from '@engine/api/dto';

import { AUTHORS, fixturePost } from '~/ui/post/fixtures';

import { buildThreadRows, threadRowType, type ThreadRow } from './thread-rows';

const root = fixturePost({ id: 'root', author: AUTHORS.bob });

function reply(id: string, overrides: Partial<ThreadReplyDTO> = {}): ThreadReplyDTO {
  return {
    ...fixturePost({ id, kind: 'reply', author: AUTHORS.carol, parentId: 'root', rootPostId: 'root' }),
    depth: 0,
    isAuthorThread: false,
    hiddenReplyCount: 0,
    ...overrides,
  };
}

function thread(overrides: Partial<ThreadDTO> = {}, replies: ThreadReplyDTO[] = []): ThreadDTO {
  return {
    focus: root,
    ancestors: [],
    removedAncestorIds: [],
    replies: { items: replies, cursor: null, hasMore: false },
    ...overrides,
  };
}

const types = (rows: ThreadRow[]) => rows.map((row) => row.type);
const replyRow = (rows: ThreadRow[], id: string) =>
  rows.find((row): row is Extract<ThreadRow, { type: 'reply' }> => row.type === 'reply' && row.reply.id === id);

describe('buildThreadRows', () => {
  it('shows a skeleton and "Loading replies…" before anything is known (deep link)', () => {
    expect(types(buildThreadRows({}))).toEqual(['focusSkeleton', 'repliesLoading']);
  });

  it('paints the tapped card at once while the thread loads (POST-01)', () => {
    const rows = buildThreadRows({ seed: root });
    expect(types(rows)).toEqual(['focus', 'repliesLoading']);
    expect(rows[0]).toMatchObject({ post: root, lineAbove: false });
  });

  it('shows the read error under the seeded card when the thread fails', () => {
    const rows = buildThreadRows({ seed: root, repliesError: 'Down' });
    expect(rows[1]).toEqual({ type: 'repliesError', key: 'replies-error', message: 'Down' });
  });

  it('returns nothing for a thread with no focus and no seed (the screen shows "Post not found")', () => {
    expect(buildThreadRows({ thread: thread({ focus: null }) })).toEqual([]);
  });

  it('keeps a shown post as "unavailable" when the thread no longer finds it', () => {
    const rows = buildThreadRows({ thread: thread({ focus: null }), seed: root });
    expect(rows[0]).toMatchObject({ type: 'focusStub', state: 'unavailable', kind: 'post' });
  });

  it('turns the focus into the deleted stub after the viewer deletes it here', () => {
    const rows = buildThreadRows({ thread: thread(), focusRemoved: true });
    expect(rows[0]).toMatchObject({ type: 'focusStub', state: 'deleted' });
  });

  it('says "No replies yet" for a loaded thread without replies', () => {
    expect(types(buildThreadRows({ thread: thread() }))).toEqual(['focus', 'repliesEmpty']);
  });

  it('puts ancestors above a focused reply, joined by the thread line, with "Replying to" (POST-03)', () => {
    const focus = reply('r1', { parentId: 'root' });
    const rows = buildThreadRows({ thread: thread({ focus, ancestors: [root] }) });
    expect(types(rows)).toEqual(['ancestor', 'focus', 'repliesEmpty']);
    expect(rows[1]).toMatchObject({ lineAbove: true, replyingTo: 'bob' });
  });

  it('adds the direct parent a flat thread leaves out, or an unavailable stub when it is gone', () => {
    const focus = reply('r2', { parentId: 'r1' });
    const parent = reply('r1');
    const withParent = buildThreadRows({ thread: thread({ focus, ancestors: [root] }), parent });
    expect(types(withParent)).toEqual(['ancestor', 'ancestor', 'focus', 'repliesEmpty']);
    expect(withParent[2]).toMatchObject({ replyingTo: 'carol', lineAbove: true });

    const missing = buildThreadRows({ thread: thread({ focus, ancestors: [root] }), parentMissing: true });
    expect(types(missing)).toEqual(['ancestor', 'ancestorStub', 'focus', 'repliesEmpty']);
    expect(missing[2]).toMatchObject({ lineAbove: false, replyingTo: undefined });
  });

  it('never claims a removed ancestor was removed or deleted, and stubs it once', () => {
    const focus = reply('r1');
    const rows = buildThreadRows({ thread: thread({ focus, removedAncestorIds: ['root'] }), parentMissing: true });
    expect(types(rows)).toEqual(['ancestorStub', 'focus', 'repliesEmpty']);
    expect(rows[0]).toMatchObject({ type: 'ancestorStub', id: 'root' });
  });

  it('joins the author thread and labels its start (POST-02)', () => {
    const replies = [
      reply('a1', { author: AUTHORS.bob, isAuthorThread: true }),
      reply('a2', { author: AUTHORS.bob, isAuthorThread: true, parentId: 'a1' }),
      reply('o1'),
    ];
    const rows = buildThreadRows({ thread: thread({}, replies) });
    expect(replyRow(rows, 'a1')).toMatchObject({ authorThreadStart: true, lineAbove: false, lineBelow: true });
    expect(replyRow(rows, 'a2')).toMatchObject({ authorThreadStart: false, lineAbove: true, lineBelow: false });
    expect(replyRow(rows, 'o1')).toMatchObject({ authorThreadStart: false, lineAbove: false, lineBelow: false });
  });

  it('names the parent of an indented reply only when it is not the row above', () => {
    const replies = [
      reply('r1', { author: AUTHORS.carol }),
      reply('r1a', { depth: 1, parentId: 'r1', author: AUTHORS.alice }),
      reply('r1b', { depth: 1, parentId: 'r1a', author: AUTHORS.bob }),
      reply('r1c', { depth: 1, parentId: 'r1', author: AUTHORS.bob }),
    ];
    const rows = buildThreadRows({ thread: thread({}, replies) });
    expect(replyRow(rows, 'r1a')?.replyingTo).toBeUndefined();
    expect(replyRow(rows, 'r1b')?.replyingTo).toBeUndefined();
    expect(replyRow(rows, 'r1c')?.replyingTo).toBe('carol');
  });

  it('adds "Continue thread" under a reply with hidden descendants, never under a deleted stub', () => {
    const replies = [
      reply('r1', { depth: 1, hiddenReplyCount: 3 }),
      reply('gone', { depth: 0, hiddenReplyCount: 2, deletedStub: true }),
    ];
    const rows = buildThreadRows({ thread: thread({}, replies) });
    expect(types(rows)).toEqual(['focus', 'reply', 'continue', 'reply']);
    expect(rows[2]).toMatchObject({ replyId: 'r1', count: 3 });
  });

  it('marks the ?reply= target', () => {
    const rows = buildThreadRows({ thread: thread({}, [reply('r1'), reply('r2')]), highlightId: 'r2' });
    expect(replyRow(rows, 'r1')?.highlighted).toBe(false);
    expect(replyRow(rows, 'r2')?.highlighted).toBe(true);
  });

  it('keeps one recycling pool per row shape', () => {
    const rows = buildThreadRows({
      thread: thread({}, [reply('r1'), reply('r2', { depth: 1 }), reply('r3', { deleted: true })]),
    });
    expect(rows.map(threadRowType)).toEqual(['focus', 'reply0', 'reply1', 'replyStub']);
  });
});
