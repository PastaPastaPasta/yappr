import type { ConversationDTO, MessageDTO } from '@engine/api';

/**
 * Pure helpers for the Messages screens (PRD DM-01 – DM-11): titles,
 * previews, filtering, and the conversation timeline with day separators,
 * bubble runs and the status line under the last own message.
 */

/** A group's member count: "1 member", "3 members" (web `memberCount`). */
export const memberCount = (count: number): string => `${count} member${count === 1 ? '' : 's'}`;

/** "Builders", "Group" for an unnamed group, or the 1:1 peer's name. */
export function conversationTitle(conversation: Pick<ConversationDTO, 'kind' | 'name' | 'peer'>): string {
  if (conversation.kind === 'group') return conversation.name?.trim() || 'Group';
  return conversation.peer?.displayName ?? 'Conversation';
}

/** The inbox's preview line: "You: see you there", or the text alone. */
export function previewText(conversation: Pick<ConversationDTO, 'lastMessage' | 'flags' | 'kind'>): string {
  const { lastMessage, flags } = conversation;
  if (flags.ended) return 'This group has ended.';
  if (flags.removed) return 'You are no longer a member of this group.';
  if (flags.unreadable) return 'You cannot read this group yet.';
  if (!lastMessage) return flags.draft ? 'New conversation' : 'No messages yet';
  const text = lastMessage.text.replace(/\s+/g, ' ').trim();
  return lastMessage.own ? `You: ${text}` : text;
}

/**
 * PRD DM-01 search (P2): the group name, the peer's name, username or id,
 * or the loaded preview text contains the query, case-insensitively.
 */
export function matchesSearch(conversation: ConversationDTO, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const { name, peer, lastMessage } = conversation;
  return [name, peer?.displayName, peer?.username, peer?.id, lastMessage?.text].some((field) =>
    field?.toLowerCase().includes(needle),
  );
}

/**
 * The inbox order (PRD DM-01): by last activity, newest first. A 1:1 just
 * opened to write (a draft) goes on top; anything else without a time (no
 * message, no known join time) goes last, never above active conversations.
 */
export function sortConversations(conversations: readonly ConversationDTO[]): ConversationDTO[] {
  const at = (c: ConversationDTO) => {
    if (c.lastActivity) return new Date(c.lastActivity).getTime();
    return c.flags.draft ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  };
  return [...conversations].sort((a, b) => {
    const x = at(a);
    const y = at(b);
    return x === y ? 0 : y > x ? 1 : -1;
  });
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** True for a pasted base58 identity id (32 bytes: 43 or 44 characters, rarely fewer). */
export function isIdentityIdText(text: string): boolean {
  const value = text.trim();
  return value.length >= 32 && value.length <= 44 && BASE58.test(value);
}

/** How many bytes base58 `text` decodes to: each leading "1" is a zero byte, the rest a big number. */
function base58ByteLength(text: string): number {
  const bytes: number[] = [];
  for (const char of text) {
    let carry = BASE58_ALPHABET.indexOf(char);
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    for (; carry > 0; carry >>= 8) bytes.push(carry & 0xff);
  }
  const zeros = text.length - text.replace(/^1+/, '').length;
  return zeros + bytes.length;
}

/** A pasted id (`isIdentityIdText`) that is really one: it decodes to 32 bytes, so it is worth looking up. */
export function isValidIdentityId(text: string): boolean {
  const value = text.trim();
  return isIdentityIdText(value) && base58ByteLength(value) === 32;
}

/** Why the composer is replaced by a banner (DM-08, DM-10), or null when the user can send. */
export function composerBlockedReason(
  conversation: Pick<ConversationDTO, 'kind' | 'flags'> | undefined,
): string | null {
  if (!conversation) return null;
  const { flags } = conversation;
  if (conversation.kind === 'direct' && flags.blocked) return 'You blocked this person. Unblock them to send messages.';
  if (flags.ended) return 'This group has ended.';
  if (flags.removed) return 'You are no longer a member of this group.';
  if (flags.unreadable) {
    return 'You cannot read this group yet. Ask the owner to resend your keys: they can do it from the group settings.';
  }
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** "Today", "Yesterday", "Mon, Sep 29", or "Mon, Sep 29, 2025" for another year (PRD DM-03). */
export function dayLabel(date: Date, now: Date = new Date()): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const options: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  if (date.getFullYear() !== now.getFullYear()) options.year = 'numeric';
  return date.toLocaleDateString('en-US', options);
}

/** "10:42 PM", for the time a bubble reveals. */
export function timeLabel(date: Date): string {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** A local send's state, as its bubble shows it (DM-04). */
export type OutboxStatus = 'sending' | 'sent' | 'failed-retry' | 'failed-edit' | 'unconfirmed';

/** A message on screen: one from the engine, or a send of this device not read back yet. */
export interface TimelineMessage {
  id: string;
  sender: string;
  text: string;
  at: Date;
  own: boolean;
  pending: boolean;
  /** Set for a local send (its outbox id is `id`). */
  outbox?: OutboxStatus;
  /** A local send being checked now (the bubble shows a spinner by its status). */
  checking?: boolean;
}

export type TimelineItem =
  | { type: 'day'; id: string; label: string }
  | {
      type: 'message';
      id: string;
      message: TimelineMessage;
      /** First bubble of a run by one sender (groups: the sender's name above it). */
      firstOfRun: boolean;
      /** Last bubble of a run (its corner nearest the sender is squared; groups: the avatar). */
      lastOfRun: boolean;
      /** The status caption under it, if any. */
      status: string | null;
      /** The status is one the user can act on (tap to retry / edit / check). */
      statusIsError: boolean;
    };

/**
 * A local send's status (UX_SPEC §2.23). `unconfirmed` is shown only once
 * the automatic checks ran out: until then an unknown outcome reads
 * "Sending…".
 */
const OUTBOX_LABEL: Record<OutboxStatus, string> = {
  sending: 'Sending…',
  sent: 'Sent',
  'failed-retry': 'Not delivered · Tap to retry',
  'failed-edit': 'Not delivered · Tap to edit',
  unconfirmed: "Couldn't confirm · Tap to check",
};

/** Two messages more than this far apart start a new run even from the same sender. */
const RUN_GAP_MS = 5 * 60 * 1000;

export interface TimelineOptions {
  /** A send of this device is still on its way (its bubble may already be the engine's). */
  sending: boolean;
  /** Legacy with read receipts on: when the other person last read the conversation (DM-11). */
  peerReadAt: Date | null;
  now?: Date;
}

/**
 * The conversation as rows, oldest first: day separators, bubbles with their
 * run edges, and one status line under the last own message ("Sending…"
 * until the engine has read it back, then "Sent" or "Read"). A failed local send always shows its error, wherever it is.
 */
export function buildTimeline(messages: readonly TimelineMessage[], options: TimelineOptions): TimelineItem[] {
  const now = options.now ?? new Date();
  let lastOwn = -1;
  messages.forEach((m, i) => {
    if (m.own) lastOwn = i;
  });

  const items: TimelineItem[] = [];
  let previousDay: number | null = null;
  messages.forEach((message, index) => {
    const day = startOfDay(message.at);
    if (day !== previousDay) {
      items.push({ type: 'day', id: `day:${day}`, label: dayLabel(message.at, now) });
      previousDay = day;
    }
    const before = messages[index - 1];
    const after = messages[index + 1];
    const joins = (a: TimelineMessage | undefined, b: TimelineMessage | undefined) =>
      !!a &&
      !!b &&
      a.sender === b.sender &&
      startOfDay(a.at) === startOfDay(b.at) &&
      Math.abs(b.at.getTime() - a.at.getTime()) <= RUN_GAP_MS;

    let status: string | null = null;
    let statusIsError = false;
    if (message.outbox && message.outbox !== 'sending' && message.outbox !== 'sent') {
      status = OUTBOX_LABEL[message.outbox];
      statusIsError = true;
    } else if (index === lastOwn) {
      if (message.outbox) status = OUTBOX_LABEL[message.outbox];
      // The engine holds it but has not read it back from the chain yet (ENGINE §7: `pending`).
      else if (options.sending || message.pending) status = OUTBOX_LABEL.sending;
      else if (options.peerReadAt && options.peerReadAt.getTime() >= message.at.getTime()) status = 'Read';
      else status = 'Sent';
    }

    items.push({
      type: 'message',
      id: message.id,
      message,
      firstOfRun: !joins(before, message),
      lastOfRun: !joins(message, after),
      status,
      statusIsError,
    });
  });
  return items;
}

/** The engine's pages (newest first) as the timeline's messages, oldest first. */
export function chronological(messages: readonly MessageDTO[]): TimelineMessage[] {
  return [...messages].reverse().map((m) => ({ ...m, at: new Date(m.at) }));
}

/** v5 splits a send over this many UTF-8 bytes into several messages (`MAX_TEXT_BYTES`). */
export const MAX_TEXT_BYTES = 4081;

export function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** A group name: 1 to 100 characters, and at most 200 UTF-8 bytes (the engine's `dm.ts` limits). */
export const GROUP_NAME_MAX = 100;
const GROUP_NAME_MAX_BYTES = 200;

/**
 * Why the engine would refuse this group name, or undefined. The field caps
 * characters itself, but CJK or emoji pass that cap and still exceed the
 * byte limit, which the engine refuses with no reason the user sees.
 */
export function groupNameError(name: string): string | undefined {
  if (utf8Length(name.trim()) <= GROUP_NAME_MAX_BYTES) return undefined;
  return 'This is too long for the network once emoji and special characters are counted. Shorten it and try again.';
}

/**
 * Whether `message` (mine, from the engine) is part of a send of `text`:
 * the same text, or for a send v5 split into parts, one of its parts.
 */
export function isPartOfSend(message: Pick<MessageDTO, 'text'>, text: string): boolean {
  const sent = text.trim();
  if (message.text === sent) return true;
  return utf8Length(sent) > MAX_TEXT_BYTES && message.text.length > 0 && sent.includes(message.text);
}
