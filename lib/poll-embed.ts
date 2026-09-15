/**
 * Helpers for the cross-contract post embed used by native polls.
 *
 * A poll post sets the post document's `embedContractId` / `embedDocType` /
 * `embedId` triple to (Pollr contract, 'poll', poll document id). Older posts
 * (and posts written by the standalone Pollr app) only carry a link to the
 * Pollr web app in their text, so those are hydrated by pattern-matching the URL.
 */

import { POLLR_APP_CONTRACT_ID, POLLR_APP_URL, POLLR_CONTRACT_ID, POLLR_DOCUMENT_TYPES } from '@/lib/constants';
import { identifierToBase58 } from '@/lib/services/sdk-helpers';
import type { Post } from '@/lib/types';

/** The embed triple as carried on a post document. */
export interface PostEmbed {
  contractId: string;
  docType: string;
  id: string;
}

export interface PostEmbedFields {
  embedContractId?: string;
  embedDocType?: string;
  embedId?: string;
}

/**
 * Read the embed triple off a raw post document, normalizing the two
 * identifier fields to base58 (the same treatment `quotedPostId` gets).
 * Returns an empty object unless all three fields are present.
 */
export function extractPostEmbedFields(
  data: Record<string, unknown>,
  doc: Record<string, unknown>
): PostEmbedFields {
  // identifierToBase58 already returns null for missing/undecodable values.
  const embedContractId = identifierToBase58(data.embedContractId ?? doc.embedContractId);
  const embedId = identifierToBase58(data.embedId ?? doc.embedId);
  const rawDocType = data.embedDocType ?? doc.embedDocType;
  const embedDocType = typeof rawDocType === 'string' && rawDocType.length > 0 ? rawDocType : undefined;

  if (!embedContractId || !embedId || !embedDocType) return {};
  return { embedContractId, embedDocType, embedId };
}

/** Build the poll embed triple for a newly created poll. */
export function buildPollEmbed(pollId: string): PostEmbed {
  return { contractId: POLLR_CONTRACT_ID, docType: POLLR_DOCUMENT_TYPES.POLL, id: pollId };
}

/** The poll id a post natively embeds, or null when it embeds something else. */
export function getEmbeddedPollId(post: Post): string | null {
  if (post.embedDocType !== POLLR_DOCUMENT_TYPES.POLL) return null;
  if (post.embedContractId !== POLLR_CONTRACT_ID) return null;
  return post.embedId || null;
}

/**
 * Public permalink for a poll on the Pollr web app, or null when that app
 * cannot resolve it — the configured contract (e.g. the devnet clone) is not
 * the one the standalone app reads.
 */
export function pollrPollUrl(pollId: string): string | null {
  if (POLLR_CONTRACT_ID !== POLLR_APP_CONTRACT_ID) return null;
  return `${POLLR_APP_URL}/poll?id=${pollId}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Legacy poll posts (and posts made from the Pollr app) just carry a link.
// The trailing slash before `?` is optional — GitHub Pages serves both.
// Deliberately case-sensitive: the base58 class excludes 0/O/I/l.
// The trailing boundary keeps a longer base58 run from being truncated to its
// first 44 characters and mis-read as a valid id.
const POLLR_POLL_LINK_PATTERN = new RegExp(
  `${escapeRegExp(POLLR_APP_URL)}/poll/?\\?id=([1-9A-HJ-NP-Za-km-z]{32,44})(?![1-9A-HJ-NP-Za-km-z])`
);

/** Find a Pollr poll link in post text. */
export function findPollrPollLink(content: string): { url: string; pollId: string } | null {
  const match = content.match(POLLR_POLL_LINK_PATTERN);
  if (!match) return null;
  return { url: match[0], pollId: match[1] };
}

/** Remove a matched Pollr poll link from the text that gets displayed. */
export function stripPollrPollLink(content: string, url: string): string {
  return content.split(url).join('').replace(/[ \t]+\n/g, '\n').trim();
}
