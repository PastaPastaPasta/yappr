import { syncStorage } from '~/state/storage';

/**
 * Compose drafts (PRD COMP-09, PD-4): per account and per context (a new
 * post, a reply to X, a quote of X), on the device only (MMKV). At most one
 * new-post draft and 20 reply or quote drafts per account; the oldest reply
 * or quote draft goes first, and anything older than 30 days is dropped.
 */

export type ComposeMode = 'post' | 'reply' | 'quote';

export interface ComposeContext {
  mode: ComposeMode;
  /** The post replied to or quoted; null for a new post. */
  targetId: string | null;
}

export interface DraftPart {
  text: string;
  /** Set once this part of a thread is on chain: it is shown as "Posted" and never posted again. */
  postedId: string | null;
}

export interface ComposeDraft {
  context: ComposeContext;
  parts: DraftPart[];
  sensitive: boolean;
  mediaUrl: string;
  updatedAt: number;
  /**
   * The failed post this draft came back from. A later success of that post
   * deletes the draft only while it still carries this mark (the user has
   * not edited it since).
   */
  fromPending?: string;
}

const MAX_TARGET_DRAFTS = 20;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const storageKey = (identityId: string) => `yappr.compose.drafts.${identityId}`;

export function contextKey({ mode, targetId }: ComposeContext): string {
  return mode === 'post' ? 'post' : `${mode}:${targetId ?? ''}`;
}

function readAll(identityId: string): Record<string, ComposeDraft> {
  try {
    const parsed = JSON.parse(syncStorage.getItem(storageKey(identityId)) ?? '{}') as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, ComposeDraft>) : {};
  } catch {
    return {};
  }
}

/** Drops expired drafts and keeps the newest 20 reply and quote drafts. */
function prune(all: Record<string, ComposeDraft>, now: number): Record<string, ComposeDraft> {
  const fresh = Object.entries(all).filter(
    ([, draft]) => Array.isArray(draft?.parts) && now - (draft.updatedAt ?? 0) <= MAX_AGE_MS,
  );
  const targeted = fresh
    .filter(([key]) => key !== 'post')
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_TARGET_DRAFTS);
  const post = fresh.filter(([key]) => key === 'post');
  return Object.fromEntries([...post, ...targeted]);
}

function writeAll(identityId: string, all: Record<string, ComposeDraft>): void {
  if (Object.keys(all).length === 0) syncStorage.removeItem(storageKey(identityId));
  else syncStorage.setItem(storageKey(identityId), JSON.stringify(all));
}

export function loadDraft(identityId: string, context: ComposeContext, now = Date.now()): ComposeDraft | null {
  const all = prune(readAll(identityId), now);
  return all[contextKey(context)] ?? null;
}

export function saveDraft(identityId: string, draft: ComposeDraft): void {
  const all = readAll(identityId);
  all[contextKey(draft.context)] = draft;
  writeAll(identityId, prune(all, draft.updatedAt));
}

/** Deletes a context's draft; with `onlyFromPending`, only a draft that came back from that post, unedited. */
export function deleteDraft(identityId: string, context: ComposeContext, onlyFromPending?: string): void {
  const all = readAll(identityId);
  const key = contextKey(context);
  const draft = all[key];
  if (!draft) return;
  if (onlyFromPending !== undefined && draft.fromPending !== onlyFromPending) return;
  delete all[key];
  writeAll(identityId, all);
}
