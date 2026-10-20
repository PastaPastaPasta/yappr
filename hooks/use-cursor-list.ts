'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'

/** One page of a cursor-paged list: its items and where the next page starts (undefined at the end). */
export interface CursorPage<T> {
  items: T[]
  nextCursor?: string
  /** The first page read only part of the data it orders (a capped scan); callers say so. */
  incomplete?: boolean
}

interface CursorListOptions {
  /** Load nothing until true (the SDK is not ready yet, say). */
  enabled: boolean
  /** Shown in place of the list when the first page fails. */
  loadError: string
  /** Toasted when a later page fails; the list read so far stays. */
  moreError: string
  /**
   * Names the list `loadPage` reads (its sort, say). Switching back to a key
   * already read shows its first page at once and refreshes it quietly,
   * instead of blanking to the loading state.
   */
  cacheKey?: string
}

/**
 * A list read page by page through `loadPage(cursor)`. A new `loadPage` (a
 * new sort, say; pass it through `useCallback`) restarts the list from the
 * first page. A later page is appended without the ids already listed, and
 * one still in flight when `loadPage` changes is dropped: it belongs to the
 * list the reader left.
 */
export function useCursorList<T extends { id: string }>(
  loadPage: (cursor?: string) => Promise<CursorPage<T>>,
  { enabled, loadError, moreError, cacheKey }: CursorListOptions
) {
  const [items, setItems] = useState<T[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [incomplete, setIncomplete] = useState(false)
  const currentLoad = useRef(loadPage)
  const firstPages = useRef(new Map<string, CursorPage<T>>())
  // A kept list refreshing in the background: a next page waits for it, so
  // the refreshed first page cannot overwrite pages appended meanwhile.
  const refreshing = useRef(false)

  useEffect(() => {
    currentLoad.current = loadPage
    if (!enabled) return
    let cancelled = false
    const kept = cacheKey === undefined ? undefined : firstPages.current.get(cacheKey)

    const load = async () => {
      setError(null)
      if (kept) {
        // Show the list read before at once; the read below refreshes it.
        refreshing.current = true
        setItems(kept.items)
        setCursor(kept.nextCursor)
        setIncomplete(kept.incomplete === true)
        setLoading(false)
      } else {
        setLoading(true)
        setItems([])
        setCursor(undefined)
        setIncomplete(false)
      }
      try {
        const page = await loadPage()
        if (cancelled) return
        if (cacheKey !== undefined) firstPages.current.set(cacheKey, page)
        setItems(page.items)
        setCursor(page.nextCursor)
        setIncomplete(page.incomplete === true)
      } catch {
        // A failed refresh keeps the kept list; only a first read shows the error.
        if (!cancelled && !kept) setError(loadError)
      } finally {
        if (!cancelled) {
          refreshing.current = false
          setLoading(false)
        }
      }
    }

    load().catch(() => {
      if (!cancelled) {
        setLoading(false)
        setError(loadError)
      }
    })
    return () => {
      cancelled = true
      refreshing.current = false
    }
  }, [enabled, loadPage, loadError, cacheKey])

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore || refreshing.current) return
    const source = loadPage
    setLoadingMore(true)
    try {
      const page = await source(cursor)
      if (currentLoad.current !== source) return
      setItems((prev) => {
        const seen = new Set(prev.map((item) => item.id))
        return [...prev, ...page.items.filter((item) => !seen.has(item.id))]
      })
      setCursor(page.nextCursor)
    } catch {
      if (currentLoad.current === source) toast.error(moreError)
    } finally {
      setLoadingMore(false)
    }
  }, [cursor, loadingMore, loadPage, moreError])

  return { items, cursor, loading, loadingMore, error, incomplete, loadMore }
}
