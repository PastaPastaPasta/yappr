import type { Post, Reply, ReplyThread } from '@/lib/types'
import { targetKindOf } from '@/lib/contract-topology'
import { pruneHiddenTombstones } from './hidden-tombstones'

const byCreatedAtAsc = (a: Reply, b: Reply) => a.createdAt.getTime() - b.createdAt.getTime()

/**
 * Nesting levels rendered inline below a top-level reply. Its children (level 1)
 * indent once and level 2 renders flattened at that same indent; anything deeper
 * is reachable through the "Continue thread" row instead of being rendered.
 */
const MAX_NESTED_DEPTH = 2

/**
 * Count the descendants of a reply that the tree will not render, so the
 * "Continue thread" row can say how much lies past the cut. Excluded ids
 * (author-thread posts hoisted to the top level) are neither counted nor
 * descended into — they and their subtrees are already visible elsewhere.
 */
function countHiddenDescendants(
  rootId: string,
  childrenOf: Map<string, Reply[]>,
  exclude: Set<string>
): number {
  let count = 0
  const visited = new Set<string>([rootId])
  const stack = [rootId]
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    for (const child of childrenOf.get(id) ?? []) {
      if (exclude.has(child.id) || visited.has(child.id)) continue
      visited.add(child.id)
      count++
      stack.push(child.id)
    }
  }
  return count
}

/**
 * Build the nested subtree under one reply, recursing down to MAX_NESTED_DEPTH.
 * A node at the cap that still has known children records them as
 * `hiddenReplyCount` instead. On v2 `childrenOf` only holds one level, so the
 * recursion naturally stops early and hidden counts stay 0 — the renderer falls
 * back to enrichment counts there.
 */
function buildNestedThreads(
  parentId: string,
  childrenOf: Map<string, Reply[]>,
  exclude: Set<string>,
  depth: number
): ReplyThread[] {
  const atCap = depth >= MAX_NESTED_DEPTH
  return (childrenOf.get(parentId) ?? [])
    .filter(reply => !exclude.has(reply.id))
    .map(reply => ({
      content: reply,
      isAuthorThread: false,
      isThreadContinuation: false,
      nestedReplies: atCap ? [] : buildNestedThreads(reply.id, childrenOf, exclude, depth + 1),
      hiddenReplyCount: atCap ? countHiddenDescendants(reply.id, childrenOf, exclude) : 0
    }))
}

/**
 * Build a threaded reply tree from flat replies and nested replies.
 * Author's thread is shown first (all at same indent level), then other replies with nesting.
 *
 * @param authorThreadChain - Pre-fetched complete author thread chain (all levels)
 * @param otherDirectReplies - All other direct replies that are NOT part of author thread
 * @param childrenOf - Map of replyId -> child replies (full thread on v9, one level on v2)
 */
export function buildReplyTree(
  authorThreadChain: Reply[],
  otherDirectReplies: Reply[],
  childrenOf: Map<string, Reply[]>
): ReplyThread[] {
  const threads: ReplyThread[] = []
  const authorThreadIds = new Set(authorThreadChain.map(r => r.id))

  // Add author's thread first - all at same level (no nesting within thread)
  authorThreadChain.forEach((reply, index) => {
    threads.push({
      content: reply,
      isAuthorThread: true,
      isThreadContinuation: index > 0,
      nestedReplies: buildNestedThreads(reply.id, childrenOf, authorThreadIds, 1)
    })
  })

  // Add other direct replies (not part of author thread)
  otherDirectReplies.forEach(reply => {
    threads.push({
      content: reply,
      isAuthorThread: false,
      isThreadContinuation: false,
      nestedReplies: buildNestedThreads(reply.id, childrenOf, authorThreadIds, 1)
    })
  })

  return threads
}

/**
 * Assemble a thread from the flat reply list a v9 `rootAndTime` (v10 `repliesOf`)
 * query returns.
 *
 * Every reply in a thread names the same `rootPostId`, so one query has all of
 * them and the shape is reconstructed here rather than discovered by walking the
 * chain: children group under `replyToReplyId`, and the author's own
 * continuation is a local filter instead of the recursive round-trips v2 needs.
 */
export function assembleFlatThread(mainPost: Post, allReplies: Reply[]): ReplyThread[] {
  const childrenOf = new Map<string, Reply[]>()
  const topOfThread: Reply[] = []

  // v11: a tombstoned reply goes unless a reply still nests under it.
  for (const reply of pruneHiddenTombstones(allReplies).sort(byCreatedAtAsc)) {
    const parentId = reply.replyToReplyId
    if (!parentId) {
      topOfThread.push(reply)
      continue
    }
    const siblings = childrenOf.get(parentId)
    if (siblings) siblings.push(reply)
    else childrenOf.set(parentId, [reply])
  }

  // Viewing a reply shows ITS subtree; viewing the root post shows the thread's
  // top level. (A reply's page still loads the whole thread — one query — and
  // simply renders a slice of it.)
  const directReplies = targetKindOf(mainPost) === 'reply'
    ? childrenOf.get(mainPost.id) ?? []
    : topOfThread

  // Depth-first, oldest branch first: finish each continuation before a
  // later direct reply from the author, matching mobile's reading order.
  const authorThreadChain: Reply[] = []
  const authorThreadIds = new Set<string>()
  const stack = directReplies.filter((reply) => reply.author.id === mainPost.author.id).reverse()
  for (let reply = stack.pop(); reply !== undefined; reply = stack.pop()) {
    if (authorThreadIds.has(reply.id)) continue
    authorThreadChain.push(reply)
    authorThreadIds.add(reply.id)
    stack.push(...(childrenOf.get(reply.id) ?? []).filter((child) => child.author.id === mainPost.author.id).reverse())
  }

  const otherDirectReplies = directReplies.filter((reply) => !authorThreadIds.has(reply.id))
  return buildReplyTree(authorThreadChain, otherDirectReplies, childrenOf)
}

