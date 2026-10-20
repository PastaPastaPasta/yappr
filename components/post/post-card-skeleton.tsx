/** Sized like a one-line-name, two-line-text post card so the list does not jump when posts land. */
export function PostCardSkeleton() {
  return (
    <div className="border-b border-gray-200 px-4 pb-3 pt-3 dark:border-gray-800" aria-hidden="true">
      <div className="flex gap-3">
        <div className="h-12 w-12 shrink-0 animate-pulse rounded-full bg-gray-200 dark:bg-gray-800" />
        <div className="flex-1 space-y-2 pt-2">
          <div className="h-4 w-48 max-w-full animate-pulse rounded bg-gray-200 dark:bg-gray-800" />
          <div className="h-4 w-full animate-pulse rounded bg-gray-100 dark:bg-gray-900" />
          <div className="h-4 w-3/4 animate-pulse rounded bg-gray-100 dark:bg-gray-900" />
          <div className="h-9" />
        </div>
      </div>
    </div>
  )
}

/** A loading list of post cards, announced once to screen readers. */
export function PostListSkeleton({ count = 5, label, testId }: { count?: number; label: string; testId?: string }) {
  return (
    <div role="status" data-testid={testId}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }, (_, i) => <PostCardSkeleton key={i} />)}
    </div>
  )
}
