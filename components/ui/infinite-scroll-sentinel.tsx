'use client';

import type { ReactNode } from 'react';
import { Spinner } from '@/components/ui/spinner';

interface InfiniteScrollSentinelProps {
  /** From `useInfiniteScroll`. */
  sentinelRef: (node: HTMLElement | null) => void;
  isLoading: boolean;
  /** From `useInfiniteScroll`: auto-loading stopped, offer the manual trigger. */
  isSuspended: boolean;
  onLoadMore: () => void;
  /** Label for the manual fallback button. */
  label?: string;
  className?: string;
  /** Overrides the fallback button styling (e.g. themed blog surfaces). */
  buttonClassName?: string;
}

/**
 * End-of-list marker that drives infinite scroll: it is what
 * `useInfiniteScroll` observes, it shows the in-flight spinner, and it falls
 * back to a button when auto-loading is suspended.
 */
export function InfiniteScrollSentinel({
  sentinelRef,
  isLoading,
  isSuspended,
  onLoadMore,
  label = 'Load More',
  className = '',
  buttonClassName = 'px-6 py-2 rounded-full bg-yappr-500 text-white hover:bg-yappr-600 transition-colors',
}: InfiniteScrollSentinelProps) {
  let content: ReactNode = null;
  if (isLoading) {
    content = <Spinner size="sm" />;
  } else if (isSuspended) {
    content = (
      <button type="button" onClick={onLoadMore} className={buttonClassName}>
        {label}
      </button>
    );
  }

  return (
    <div
      ref={sentinelRef}
      data-testid="infinite-scroll-sentinel"
      className={`flex min-h-[56px] items-center justify-center p-4 ${className}`}
    >
      {content}
    </div>
  );
}
