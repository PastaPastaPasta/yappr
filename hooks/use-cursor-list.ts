'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'

/** One page of a cursor-paged list: its items and where the next page starts (undefined at the end). */
export interface CursorPage<T> {
  items: T[]
  nextCursor?: string
}

interface CursorListOptions {
  /** Load nothing until true (the SDK is not ready yet, say). */
  enabled: boolean
  /** Shown in place of the list when the first page fails. */
  loadError: string
  /** Toasted when a later page fails; the list read so far stays. */
  moreError: string
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
  { enabled, loadError, moreError }: CursorListOptions
) {
  const [items, setItems] = useState<T[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const currentLoad = useRef(loadPage)

  useEffect(() => {
    currentLoad.current = loadPage
    if (!enabled) return
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError(null)
      setItems([])
      setCursor(undefined)
      try {
        const page = await loadPage()
        if (cancelled) return
        setItems(page.items)
        setCursor(page.nextCursor)
      } catch {
        if (!cancelled) setError(loadError)
      } finally {
        if (!cancelled) setLoading(false)
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
    }
  }, [enabled, loadPage, loadError])

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return
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

  return { items, cursor, loading, loadingMore, error, loadMore }
}
