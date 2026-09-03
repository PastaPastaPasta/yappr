'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { logger } from '@/lib/logger';

/**
 * Number of pages we are willing to fetch automatically before the user has to
 * scroll again. Short pages (heavy client-side filtering, tiny result sets) can
 * leave the sentinel on screen after a load, which would otherwise page through
 * the whole collection in one burst of DAPI requests.
 */
const MAX_AUTO_LOADS_PER_SCROLL = 3;

/** How many pixels below the viewport the sentinel starts loading. */
const ROOT_MARGIN_PX = 600;

/**
 * `active` auto-loads on sight, `paused` waits for the next user scroll (burst
 * budget spent), `failed` waits for an explicit retry.
 */
type AutoLoadStatus = 'active' | 'paused' | 'failed';

interface UseInfiniteScrollOptions {
  /** Whether another page exists. */
  hasMore: boolean;
  /** Whether a page request is currently in flight. */
  isLoading: boolean;
  /** Fetches the next page. Rejections suspend auto-loading. */
  onLoadMore: () => void | Promise<void>;
  /** Skips observation entirely (e.g. the list is on an inactive tab). */
  disabled?: boolean;
  /**
   * Identity of the list being paged. None of the call sites remount on a tab
   * switch or a post/profile navigation, so without this a `paused`/`failed`
   * status from the previous list would greet the next one with a manual
   * button it never earned.
   */
  resetKey?: unknown;
}

interface UseInfiniteScrollResult {
  /** Attach to an element rendered at the end of the list. */
  sentinelRef: (node: HTMLElement | null) => void;
  /** True when auto-loading stopped and the user must trigger the next page. */
  isSuspended: boolean;
  /** Loads the next page manually and re-arms auto-loading. */
  loadMore: () => void;
}

/**
 * Auto-loads the next page when a sentinel element scrolls into view, replacing
 * a "Load More" click. Callers keep a manual trigger around for the suspended
 * case: a failed request, or a burst of short pages with no scroll in between.
 */
export function useInfiniteScroll({
  hasMore,
  isLoading,
  onLoadMore,
  disabled = false,
  resetKey,
}: UseInfiniteScrollOptions): UseInfiniteScrollResult {
  const [isIntersecting, setIsIntersecting] = useState(false);
  const [status, setStatus] = useState<AutoLoadStatus>('active');
  // Bumped whenever a load settles, so the sentinel is re-checked even when the
  // page added nothing visible (everything filtered out) and no other input to
  // the effect below changed.
  const [loadCount, setLoadCount] = useState(0);

  // Kept in refs so the observer and scroll listener never need re-creating.
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  const autoLoadsRef = useRef(0);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const nodeRef = useRef<HTMLElement | null>(null);

  const sentinelRef = useCallback((node: HTMLElement | null) => {
    nodeRef.current = node;
    const observer = observerRef.current;
    if (!observer) return;
    observer.disconnect();
    if (node) observer.observe(node);
    else setIsIntersecting(false);
  }, []);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setIsIntersecting(entry.isIntersecting);
      },
      { rootMargin: `${ROOT_MARGIN_PX}px 0px` },
    );
    observerRef.current = observer;
    if (nodeRef.current) observer.observe(nodeRef.current);

    return () => {
      observer.disconnect();
      observerRef.current = null;
      setIsIntersecting(false);
    };
  }, []);

  // Any user scroll refills the burst budget. Capture phase so scrolls inside
  // nested scroll containers count too (scroll events don't bubble).
  useEffect(() => {
    const handleScroll = () => {
      autoLoadsRef.current = 0;
      setStatus((current) => (current === 'paused' ? 'active' : current));
    };
    window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    return () => window.removeEventListener('scroll', handleScroll, { capture: true });
  }, []);

  // A different list starts with a clean budget and no leftover suspension.
  useEffect(() => {
    autoLoadsRef.current = 0;
    setStatus('active');
  }, [resetKey]);

  const runLoadMore = useCallback(() => {
    const settle = () => setLoadCount((count) => count + 1);
    const fail = (error: unknown) => {
      logger.error('Infinite scroll load failed', error);
      setStatus('failed');
      settle();
    };
    try {
      const result = onLoadMoreRef.current();
      if (result instanceof Promise) result.then(settle, fail);
      else settle();
    } catch (error) {
      fail(error);
    }
  }, []);

  // Fires when the sentinel comes into view, and again after each load settles
  // while it is still visible (a short page leaves it on screen).
  useEffect(() => {
    if (disabled || status !== 'active' || !isIntersecting || !hasMore || isLoading) return;
    // Observer callbacks are async, so `isIntersecting` can still read true just
    // after a page pushed the sentinel far below the fold. Re-measure before
    // spending another round of requests.
    // A detached sentinel (the list just unmounted) can never be near the fold,
    // so bail rather than fetching a page nobody is going to see.
    const node = nodeRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const stillNear = rect.top <= viewportHeight + ROOT_MARGIN_PX && rect.bottom >= -ROOT_MARGIN_PX;
    if (!stillNear) return;
    if (autoLoadsRef.current >= MAX_AUTO_LOADS_PER_SCROLL) {
      setStatus('paused');
      return;
    }
    autoLoadsRef.current += 1;
    runLoadMore();
  }, [disabled, status, isIntersecting, hasMore, isLoading, loadCount, runLoadMore]);

  const loadMore = useCallback(() => {
    if (isLoading || !hasMore) return;
    autoLoadsRef.current = 0;
    setStatus('active');
    runLoadMore();
  }, [isLoading, hasMore, runLoadMore]);

  return { sentinelRef, isSuspended: status !== 'active', loadMore };
}
