import type { Reply, ReplyThread } from '@/lib/types'

/**
 * Thread assembly, ported from `hooks/use-post-detail.ts` (module-private
 * there, so it cannot be imported): the focus author's own continuation
 * first, then the other replies, each with its subtree down to
 * `MAX_NESTED_DEPTH`. Pure; the loaders live in `api/posts.ts`.
 */

/** Levels rendered below a top-level reply; deeper ones are counted as hidden ("Continue thread"). */
const MAX_NESTED_DEPTH = 2

/** Nesting levels `posts.thread` fetches below a focused reply: the rendered depth (web's `renderedDepth`). */
export const RENDERED_DEPTH = MAX_NESTED_DEPTH + 1

const byCreatedAtAsc = (a: Reply, b: Reply) => a.createdAt.getTime() - b.createdAt.getTime()

function countHiddenDescendants(rootId: string, childrenOf: Map<string, Reply[]>, exclude: Set<string>): number {
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

function buildNestedThreads(parentId: string, childrenOf: Map<string, Reply[]>, exclude: Set<string>, depth: number): ReplyThread[] {
  const atCap = depth >= MAX_NESTED_DEPTH
  return (childrenOf.get(parentId) ?? [])
    .filter(reply => !exclude.has(reply.id))
    .map(reply => ({
      content: reply,
      isAuthorThread: false,
      isThreadContinuation: false,
      nestedReplies: atCap ? [] : buildNestedThreads(reply.id, childrenOf, exclude, depth + 1),
      hiddenReplyCount: atCap ? countHiddenDescendants(reply.id, childrenOf, exclude) : 0,
    }))
}

/** The author's thread first (one level, no nesting within it), then the other direct replies with their subtrees. */
function buildReplyTree(authorThreadChain: Reply[], otherDirectReplies: Reply[], childrenOf: Map<string, Reply[]>): ReplyThread[] {
  const authorThreadIds = new Set(authorThreadChain.map(reply => reply.id))
  const thread = (reply: Reply, isAuthorThread: boolean, isThreadContinuation: boolean): ReplyThread => ({
    content: reply,
    isAuthorThread,
    isThreadContinuation,
    nestedReplies: buildNestedThreads(reply.id, childrenOf, authorThreadIds, 1),
  })
  return [
    ...authorThreadChain.map((reply, index) => thread(reply, true, index > 0)),
    ...otherDirectReplies.map(reply => thread(reply, false, false)),
  ]
}

/**
 * A flat thread (v9 `rootAndTime`, v10 `repliesOf`): every reply names the
 * root, so one query holds them all and the shape is rebuilt here. Viewing a
 * reply renders its subtree; viewing the root post, the thread's top level.
 */
export function assembleFlatThread(focus: { id: string; authorId: string; isReply: boolean }, allReplies: Reply[]): ReplyThread[] {
  const childrenOf = new Map<string, Reply[]>()
  const topOfThread: Reply[] = []
  for (const reply of [...allReplies].sort(byCreatedAtAsc)) {
    const parentId = reply.replyToReplyId
    if (!parentId) {
      topOfThread.push(reply)
      continue
    }
    const siblings = childrenOf.get(parentId)
    if (siblings) siblings.push(reply)
    else childrenOf.set(parentId, [reply])
  }

  const directReplies = focus.isReply ? childrenOf.get(focus.id) ?? [] : topOfThread

  // The author's own continuation: their direct replies, their replies to those, and so on.
  const authorThreadChain: Reply[] = []
  const authorThreadIds = new Set<string>()
  let frontier = directReplies.filter(reply => reply.author.id === focus.authorId)
  while (frontier.length > 0) {
    const next: Reply[] = []
    for (const reply of frontier) {
      if (authorThreadIds.has(reply.id)) continue
      authorThreadChain.push(reply)
      authorThreadIds.add(reply.id)
      next.push(...(childrenOf.get(reply.id) ?? []).filter(child => child.author.id === focus.authorId))
    }
    frontier = next
  }

  return buildReplyTree(authorThreadChain, directReplies.filter(reply => !authorThreadIds.has(reply.id)), childrenOf)
}

/**
 * v2: `reply.parentId` names only the direct parent, so the author's
 * continuation is discovered one level at a time. `nestedOf` is
 * `replyService.getNestedReplies` (one level per call).
 */
export async function assembleV2Thread(
  focus: { id: string; authorId: string },
  directReplies: Reply[],
  nestedOf: (parentIds: string[]) => Promise<Map<string, Reply[]>>,
): Promise<ReplyThread[]> {
  const authorThreadChain = [...directReplies].sort(byCreatedAtAsc).filter(reply => reply.author.id === focus.authorId)
  const authorThreadIds = new Set<string>([focus.id, ...authorThreadChain.map(reply => reply.id)])

  for (let parents = authorThreadChain.map(reply => reply.id); parents.length > 0;) {
    const continuations: Reply[] = []
    for (const [parentId, nested] of await nestedOf(parents)) {
      for (const reply of nested) {
        if (reply.author.id === focus.authorId && authorThreadIds.has(parentId)) {
          continuations.push(reply)
          authorThreadIds.add(reply.id)
        }
      }
    }
    continuations.sort(byCreatedAtAsc)
    authorThreadChain.push(...continuations)
    parents = continuations.map(reply => reply.id)
  }

  const nestedIds = Array.from(new Set([...directReplies, ...authorThreadChain].map(reply => reply.id)))
  const childrenOf = nestedIds.length > 0 ? await nestedOf(nestedIds) : new Map<string, Reply[]>()
  return buildReplyTree(authorThreadChain, directReplies.filter(reply => !authorThreadIds.has(reply.id)), childrenOf)
}

export interface FlatReply {
  reply: Reply
  depth: 0 | 1
  isAuthorThread: boolean
  hiddenReplyCount: number
}

/** Pre-order, one indent level: top-level replies at 0, everything nested at 1 (web flattens level 2 the same way). */
export function flattenThreads(threads: ReplyThread[], depth: 0 | 1 = 0): FlatReply[] {
  return threads.flatMap(thread => [
    { reply: thread.content, depth, isAuthorThread: thread.isAuthorThread, hiddenReplyCount: thread.hiddenReplyCount ?? 0 },
    ...flattenThreads(thread.nestedReplies, 1),
  ])
}
