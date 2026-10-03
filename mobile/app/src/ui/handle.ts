import { truncateId } from '~/lib-allowlist';

/** "@alice", or the truncated identity id for an author with no DPNS name (UX_SPEC §2.4.3). */
export function handleOf({ id, username }: { id: string; username: string | null }): string {
  return username ? `@${username}` : truncateId(id);
}

/** U+2060: no line break on either side, and draws nothing. */
const WORD_JOINER = '⁠';
/** U+2011: a hyphen that never ends a line. */
const NON_BREAKING_HYPHEN = '‑';
/** A handle inside a title: `@` and a DPNS label (letters, digits, `-`). */
const HANDLE = /@[\w-]+/g;

/**
 * A native menu title with each "@handle" kept on one line (D-L3i-006).
 * iOS menus wrap a long title and hyphenate the word they break
 * ("Unfollow @siob-han76"), and a handle's own `-` is a break point too:
 * a handle that moves to the next line must move whole. Its characters are
 * glued with word joiners (no break or hyphenation point inside it) and its
 * hyphens made non-breaking; it looks and reads the same.
 */
export function keepHandlesWhole(title: string): string {
  return title.replace(HANDLE, (handle) =>
    Array.from(handle, (ch) => (ch === '-' ? NON_BREAKING_HYPHEN : ch)).join(WORD_JOINER),
  );
}
