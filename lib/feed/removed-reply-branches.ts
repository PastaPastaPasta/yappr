import type { Reply } from '@/lib/types';

/**
 * Where each reply of a flat thread nests (v20 removed-reply placeholders,
 * shared by the web and mobile thread assemblers): under its `replyToReplyId`,
 * else under its `keptParentId` once that reply connects to the thread (the
 * focus, or a chain of loaded replies up to the top). A placeholder whose kept
 * parent is loaded but not yet connected stays at the top, so the rows it
 * holds stay visible until the rest of the chain arrives.
 */
export function threadParentOf(focusId: string, replies: readonly Reply[]): (reply: Reply) => string | undefined {
  const byId = new Map(replies.map((reply) => [reply.id, reply]));
  const connected = new Map<string, boolean>();
  const parentOf = (reply: Reply, seen: Set<string>): string | undefined => {
    if (reply.replyToReplyId) return reply.replyToReplyId;
    const kept = reply.keptParentId;
    return kept && connects(kept, seen) ? kept : undefined;
  };
  const connects = (id: string, seen: Set<string>): boolean => {
    if (id === focusId) return true;
    const known = connected.get(id);
    if (known !== undefined) return known;
    const reply = byId.get(id);
    if (!reply || seen.has(id)) return false;
    seen.add(id);
    const parent = parentOf(reply, seen);
    const result = parent === undefined || connects(parent, seen);
    connected.set(id, result);
    return result;
  };
  return (reply) => parentOf(reply, new Set([reply.id]));
}

/**
 * Whether a reply's subtree holds a removed reply's placeholder. A "Continue
 * thread" page finds a reply's subtree by walking listed replies down from it,
 * and a removed reply is not listed, so a branch through one is rendered in
 * place past the depth cap instead of being left behind that row.
 */
export function holdsRemovedReply(childrenOf: ReadonlyMap<string, readonly Reply[]>): (replyId: string) => boolean {
  const memo = new Map<string, boolean>();
  const holds = (replyId: string, seen: Set<string>): boolean => {
    const known = memo.get(replyId);
    if (known !== undefined) return known;
    if (seen.has(replyId)) return false;
    seen.add(replyId);
    const result = (childrenOf.get(replyId) ?? []).some((child) => child.deletedStub === true || holds(child.id, seen));
    memo.set(replyId, result);
    return result;
  };
  return (replyId) => holds(replyId, new Set());
}
