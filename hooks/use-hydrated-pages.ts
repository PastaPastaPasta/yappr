'use client'

import { useCallback, useRef, useState } from 'react'
import { appendPage, dropFromPages, withoutDropped, type HydratedPages, type PagesDrop } from '@/lib/hydrated-pages'

/**
 * A list read whole (every id, no cap) but hydrated a page at a time: only
 * the shown slice pays for profiles, posts and counts, so a long followers or
 * mentions list costs one page per scroll instead of everything up front.
 *
 * `reset` starts over with a new key list and hydrates its first page;
 * `loadMore` hydrates the next. Both reject when hydration fails, and a
 * `reset` makes any hydration still in flight for the previous list a no-op.
 */
export function useHydratedPages<K, V>(hydrate: (slice: K[]) => Promise<V[]>, pageSize: number) {
  const [pages, setPagesState] = useState<HydratedPages<K, V> | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const pagesRef = useRef(pages)
  const generation = useRef(0)
  const loadingRef = useRef(false)
  const hydrateRef = useRef(hydrate)
  hydrateRef.current = hydrate
  // Drops made while a reset or loadMore is in flight, applied when it lands.
  const inFlightDrops = useRef<PagesDrop<K, V>[]>([])

  const setPages = useCallback((update: HydratedPages<K, V> | null | ((prev: HydratedPages<K, V> | null) => HydratedPages<K, V> | null)) => {
    const next = typeof update === 'function' ? update(pagesRef.current) : update
    pagesRef.current = next
    setPagesState(next)
  }, [])

  /** Resolves to the new pages, or null when a later reset or clear superseded it. */
  const reset = useCallback(async (keys: K[]): Promise<HydratedPages<K, V> | null> => {
    const current = ++generation.current
    // Held for the whole reset: a loadMore now would page the list being replaced.
    loadingRef.current = true
    inFlightDrops.current = []
    setLoadingMore(false)
    try {
      const slice = keys.slice(0, pageSize)
      const hydrated = slice.length > 0 ? await hydrateRef.current(slice) : []
      if (current !== generation.current) return null
      const kept = withoutDropped(inFlightDrops.current, keys, hydrated)
      const next = { keys: kept.keys, loaded: withoutDropped(inFlightDrops.current, slice, []).keys.length, items: kept.items }
      setPages(next)
      return next
    } finally {
      if (current === generation.current) loadingRef.current = false
    }
  }, [pageSize, setPages])

  const loadMore = useCallback(async () => {
    const start = pagesRef.current
    if (!start || start.loaded >= start.keys.length || loadingRef.current) return
    const current = generation.current
    loadingRef.current = true
    inFlightDrops.current = []
    setLoadingMore(true)
    try {
      const slice = start.keys.slice(start.loaded, start.loaded + pageSize)
      const hydrated = await hydrateRef.current(slice)
      if (current !== generation.current) return
      const { items } = withoutDropped(inFlightDrops.current, [], hydrated)
      setPages((prev) => prev && appendPage(prev, slice, items))
    } finally {
      if (current === generation.current) {
        loadingRef.current = false
        setLoadingMore(false)
      }
    }
  }, [pageSize, setPages])

  /**
   * Remove keys and their items (an unfollow, a deleted bookmark), including
   * from a page still hydrating, so a load that lands later cannot bring them back.
   */
  const drop = useCallback((keepKey: (key: K) => boolean, keepItem: (item: V) => boolean) => {
    if (loadingRef.current) inFlightDrops.current.push({ keepKey, keepItem })
    setPages((prev) => prev && dropFromPages(prev, keepKey, keepItem))
  }, [setPages])

  /** Forget the list (and anything in flight for it). */
  const clear = useCallback(() => {
    generation.current++
    loadingRef.current = false
    setLoadingMore(false)
    setPages(null)
  }, [setPages])

  return {
    pages,
    setPages,
    drop,
    reset,
    loadMore,
    clear,
    loadingMore,
    hasMore: pages !== null && pages.loaded < pages.keys.length,
  }
}
