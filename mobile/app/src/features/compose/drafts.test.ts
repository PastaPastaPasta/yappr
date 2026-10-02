import { syncStorage } from '~/state/storage';

import { deleteDraft, loadDraft, saveDraft, type ComposeContext, type ComposeDraft } from './drafts';

jest.mock('~/state/storage', () => {
  const items = new Map<string, string>();
  return {
    syncStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
    },
  };
});

const ME = 'identity-a';
const POST: ComposeContext = { mode: 'post', targetId: null };
const reply = (id: string): ComposeContext => ({ mode: 'reply', targetId: id });
const DAY = 24 * 60 * 60 * 1000;

const draft = (context: ComposeContext, text: string, updatedAt = Date.now()): ComposeDraft => ({
  context,
  parts: [{ text, postedId: null }],
  sensitive: false,
  mediaUrl: '',
  updatedAt,
});

beforeEach(() => {
  syncStorage.removeItem(`yappr.compose.drafts.${ME}`);
  syncStorage.removeItem('yappr.compose.drafts.identity-b');
});

it('keeps one draft per account and context', () => {
  saveDraft(ME, draft(POST, 'new post'));
  saveDraft(ME, draft(reply('p1'), 'reply to p1'));
  saveDraft('identity-b', draft(POST, 'someone else'));

  expect(loadDraft(ME, POST)?.parts[0]?.text).toBe('new post');
  expect(loadDraft(ME, reply('p1'))?.parts[0]?.text).toBe('reply to p1');
  expect(loadDraft(ME, reply('p2'))).toBeNull();
  expect(loadDraft(ME, { mode: 'quote', targetId: 'p1' })).toBeNull();
  expect(loadDraft('identity-b', POST)?.parts[0]?.text).toBe('someone else');
});

it('drops drafts older than 30 days', () => {
  const now = Date.now();
  saveDraft(ME, draft(POST, 'old', now - 31 * DAY));
  expect(loadDraft(ME, POST, now)).toBeNull();
});

it('keeps the newest 20 reply and quote drafts', () => {
  const now = Date.now();
  for (let i = 0; i < 22; i++) saveDraft(ME, draft(reply(`p${i}`), `r${i}`, now - (22 - i) * 1000));
  saveDraft(ME, draft(POST, 'post', now - DAY));

  expect(loadDraft(ME, reply('p0'), now)).toBeNull();
  expect(loadDraft(ME, reply('p1'), now)).toBeNull();
  expect(loadDraft(ME, reply('p2'), now)?.parts[0]?.text).toBe('r2');
  expect(loadDraft(ME, reply('p21'), now)?.parts[0]?.text).toBe('r21');
  expect(loadDraft(ME, POST, now)?.parts[0]?.text).toBe('post');
});

it('deletes a draft that came back from a failed post only while it is unedited', () => {
  saveDraft(ME, { ...draft(POST, 'came back'), fromPending: 'pending-1' });
  deleteDraft(ME, POST, 'pending-2');
  expect(loadDraft(ME, POST)).not.toBeNull();
  deleteDraft(ME, POST, 'pending-1');
  expect(loadDraft(ME, POST)).toBeNull();

  saveDraft(ME, draft(POST, 'edited since'));
  deleteDraft(ME, POST, 'pending-1');
  expect(loadDraft(ME, POST)).not.toBeNull();
  deleteDraft(ME, POST);
  expect(loadDraft(ME, POST)).toBeNull();
});
