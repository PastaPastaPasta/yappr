import {
  buildTimeline,
  composerBlockedReason,
  conversationTitle,
  dayLabel,
  groupNameError,
  isIdentityIdText,
  isPartOfSend,
  matchesSearch,
  memberCount,
  previewText,
  sortConversations,
  type TimelineMessage,
} from './dm-model';
import { conversation, FLAGS } from './test-fixtures';

const message = (id: string, minutes: number, overrides: Partial<TimelineMessage> = {}): TimelineMessage => ({
  id,
  sender: 'alice',
  text: id,
  at: new Date(2026, 8, 30, 10, minutes),
  own: true,
  pending: false,
  ...overrides,
});

describe('titles and previews (DM-01)', () => {
  it('names a 1:1 by the peer and a group by its name, or "Group"', () => {
    expect(conversationTitle(conversation())).toBe('Bob Builder');
    expect(conversationTitle(conversation({ kind: 'group', peer: null, name: 'Builders' }))).toBe('Builders');
    expect(conversationTitle(conversation({ kind: 'group', peer: null, name: '  ' }))).toBe('Group');
  });

  it('prefixes own previews with "You: " and collapses whitespace', () => {
    expect(previewText(conversation())).toBe('see you there');
    expect(previewText(conversation({ lastMessage: { text: 'on my\nway', at: new Date(), own: true } }))).toBe(
      'You: on my way',
    );
  });

  it('says why a group cannot be read instead of a preview', () => {
    expect(previewText(conversation({ flags: { ...FLAGS, ended: true } }))).toBe('This group has ended.');
    expect(previewText(conversation({ flags: { ...FLAGS, unreadable: true } }))).toBe('You cannot read this group yet.');
    expect(previewText(conversation({ lastMessage: null, flags: { ...FLAGS, draft: true } }))).toBe('New conversation');
  });

  it('counts members', () => {
    expect(memberCount(1)).toBe('1 member');
    expect(memberCount(3)).toBe('3 members');
  });
});

describe('search and order', () => {
  it('matches the peer name, username, id and the preview, case-insensitively', () => {
    const c = conversation();
    expect(matchesSearch(c, 'BUILDER')).toBe(true);
    expect(matchesSearch(c, 'bob')).toBe(true);
    expect(matchesSearch(c, 'BobId11')).toBe(true);
    expect(matchesSearch(c, 'there')).toBe(true);
    expect(matchesSearch(c, 'carol')).toBe(false);
    expect(matchesSearch(c, '  ')).toBe(true);
  });

  it('orders by last activity, with fresh drafts on top', () => {
    const old = conversation({ key: 'old', lastActivity: new Date(1000) });
    const recent = conversation({ key: 'recent', lastActivity: new Date(5000) });
    const draft = conversation({ key: 'draft', lastActivity: null });
    expect(sortConversations([old, recent, draft]).map((c) => c.key)).toEqual(['draft', 'recent', 'old']);
  });
});

describe('isIdentityIdText', () => {
  it('accepts a base58 identity id and rejects names and other text', () => {
    expect(isIdentityIdText('BCtPfY75SUK6S47ipXyeUxHWcWWKBAnQreiZ1SZznMHs')).toBe(true);
    expect(isIdentityIdText('  3ZMisEx3ybPn4b1JMEppThBoKu3fLHRvNSd7HiZwLSG2 ')).toBe(true);
    expect(isIdentityIdText('writes-mina4')).toBe(false);
    // 0, O, I and l are not base58.
    expect(isIdentityIdText('0CtPfY75SUK6S47ipXyeUxHWcWWKBAnQreiZ1SZznMHs')).toBe(false);
  });
});

describe('composerBlockedReason (DM-08, DM-10)', () => {
  it('replaces the composer for a blocked peer, an ended or left group, and missing keys', () => {
    expect(composerBlockedReason(conversation())).toBeNull();
    expect(composerBlockedReason(undefined)).toBeNull();
    expect(composerBlockedReason(conversation({ flags: { ...FLAGS, blocked: true } }))).toBe(
      'You blocked this person. Unblock them to send messages.',
    );
    const group = { kind: 'group' as const, peer: null };
    expect(composerBlockedReason(conversation({ ...group, flags: { ...FLAGS, ended: true } }))).toBe('This group has ended.');
    expect(composerBlockedReason(conversation({ ...group, flags: { ...FLAGS, removed: true } }))).toBe(
      'You are no longer a member of this group.',
    );
    expect(composerBlockedReason(conversation({ ...group, flags: { ...FLAGS, unreadable: true } }))).toMatch(
      /Ask the owner to resend your keys/,
    );
  });
});

describe('dayLabel (DM-03)', () => {
  const now = new Date(2026, 8, 30, 15, 0);
  it('says Today, Yesterday, then the date, with the year only when it differs', () => {
    expect(dayLabel(new Date(2026, 8, 30, 1, 0), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 8, 29, 23, 59), now)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 8, 22, 12, 0), now)).toBe('Tue, Sep 22');
    expect(dayLabel(new Date(2025, 8, 22, 12, 0), now)).toBe('Mon, Sep 22, 2025');
  });
});

describe('buildTimeline', () => {
  const now = new Date(2026, 8, 30, 15, 0);

  it('adds day separators and marks run edges', () => {
    const items = buildTimeline(
      [
        message('a', 0, { own: false, sender: 'bob' }),
        message('b', 1, { own: false, sender: 'bob' }),
        message('c', 2),
        message('d', 30),
      ],
      { sending: false, peerReadAt: null, now },
    );
    expect(items.map((i) => i.type)).toEqual(['day', 'message', 'message', 'message', 'message']);
    const bubbles = items.filter((i) => i.type === 'message');
    expect(bubbles.map((b) => [b.id, b.firstOfRun, b.lastOfRun])).toEqual([
      ['a', true, false],
      ['b', false, true],
      ['c', true, true],
      // 28 minutes later starts a new run.
      ['d', true, true],
    ]);
  });

  it('puts "Sent" under the last own message only, and "Read" once the peer read it', () => {
    const messages = [message('a', 0), message('b', 1), message('c', 2, { own: false, sender: 'bob' })];
    const statuses = (peerReadAt: Date | null, sending = false) =>
      buildTimeline(messages, { sending, peerReadAt, now }).flatMap((i) => (i.type === 'message' ? [i.status] : []));
    expect(statuses(null)).toEqual([null, 'Sent', null]);
    expect(statuses(new Date(2026, 8, 30, 10, 5))).toEqual([null, 'Read', null]);
    expect(statuses(new Date(2026, 8, 30, 10, 0))).toEqual([null, 'Sent', null]);
    expect(statuses(null, true)).toEqual([null, 'Sending…', null]);
  });

  it('says "Sending…", not "Sent", under an own message the engine has not read back yet (SR-22)', () => {
    const items = buildTimeline([message('a', 0), message('b', 1, { pending: true })], { sending: false, peerReadAt: null, now });
    expect(items.flatMap((i) => (i.type === 'message' ? [i.status] : []))).toEqual([null, 'Sending…']);
    // Read back (or confirmed when sent): "Sent".
    const readBack = buildTimeline([message('a', 0), message('b', 1, { pending: false })], { sending: false, peerReadAt: null, now });
    expect(readBack.flatMap((i) => (i.type === 'message' ? [i.status] : []))).toEqual([null, 'Sent']);
  });

  it('shows a failed local send with its action wherever it is', () => {
    const items = buildTimeline(
      [message('a', 0, { outbox: 'failed-retry' }), message('b', 1, { outbox: 'sending' })],
      { sending: true, peerReadAt: null, now },
    ).filter((i) => i.type === 'message');
    expect(items.map((i) => [i.status, i.statusIsError])).toEqual([
      ['Failed · Tap to retry', true],
      ['Sending…', false],
    ]);
  });

  it('starts a new day with a separator', () => {
    const items = buildTimeline(
      [message('a', 0, { at: new Date(2026, 8, 29, 23, 59) }), message('b', 0, { at: new Date(2026, 8, 30, 0, 1) })],
      { sending: false, peerReadAt: null, now },
    );
    expect(items.flatMap((i) => (i.type === 'day' ? [i.label] : []))).toEqual(['Yesterday', 'Today']);
  });
});

describe('isPartOfSend', () => {
  it('matches the same text, and the parts of a long send', () => {
    expect(isPartOfSend({ text: 'hello' }, '  hello ')).toBe(true);
    expect(isPartOfSend({ text: 'hell' }, 'hello')).toBe(false);
    const long = 'x'.repeat(5000);
    expect(isPartOfSend({ text: 'x'.repeat(4000) }, long)).toBe(true);
  });
});

describe('groupNameError (SR-38)', () => {
  it('passes names within 200 UTF-8 bytes, trimmed', () => {
    expect(groupNameError('Builders')).toBeUndefined();
    expect(groupNameError(`  ${'中'.repeat(66)}  `)).toBeUndefined();
  });

  it('refuses names the character cap lets through but the engine would refuse', () => {
    expect(groupNameError('中'.repeat(67))).toMatch(/too long for the network/);
    expect(groupNameError('😀'.repeat(51))).toMatch(/too long for the network/);
  });
});
