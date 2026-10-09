import { logger } from '@/lib/logger'
import { blockService } from '@/lib/services/block-service'
import type { BlockDocument } from '@/lib/types'
import { readFailure } from '../dto/hydrate'

export interface OwnBlock {
  blockedId: string
  message?: string
}

/** One of a viewer's own blocks as a list read tells it: who, and when it was made (block time, ms). */
export interface AccountBlock {
  blockedId: string
  createdAt: number
}

/** Told the whole of a viewer's own block list each time it is read. */
export type OwnBlocksListener = (viewer: string, blocks: AccountBlock[]) => void

const listeners = new Set<OwnBlocksListener>()

/**
 * Every one of the viewer's own blocks (`getUserBlocks`, read whole),
 * rejecting when the read fails: never a partial or empty list in its
 * place. Each read that succeeds tells the `onOwnBlocks` listeners
 * (DM v5 Messages follow it).
 */
export async function ownBlocks(viewer: string): Promise<OwnBlock[]> {
  let blocks: BlockDocument[]
  try {
    blocks = (await blockService.getUserBlocks(viewer)).filter(block => block.blockedId)
  } catch (error) {
    throw readFailure(error)
  }
  const told = blocks.map(block => ({ blockedId: block.blockedId, createdAt: block.$createdAt }))
  for (const listener of listeners) {
    try {
      listener(viewer, told)
    } catch (error) {
      // A listener's failure never costs the reader its list.
      logger.warn('A listener of the block list failed:', error)
    }
  }
  return blocks
}

/** Hear every successful `ownBlocks` read. Returns the unsubscribe. */
export function onOwnBlocks(listener: OwnBlocksListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
