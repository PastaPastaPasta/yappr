/**
 * Placeholders for a blog's own pages, shaped like what replaces them so
 * nothing jumps as the blog, then its posts, arrive. Inside a blog they take
 * its border colour; before the blog loads (its colours unknown), plain grays.
 */

const BAR = 'rounded bg-[var(--blog-border,#e5e7eb)] dark:bg-[var(--blog-border,#1f2937)]'

/**
 * The blog owner's handle, or a text-height placeholder while their username
 * is still being looked up; `fallback` only once the lookup found no name.
 */
export function OwnerHandle({ username, pending, fallback }: { username?: string; pending?: boolean; fallback: string }) {
  if (username) return <>@{username}</>
  if (pending) return <span className={`inline-block h-[0.8em] w-24 align-middle ${BAR} animate-pulse`} role="status" aria-label="Loading username" />
  return <>{fallback}</>
}

/** One post card in a blog's list (cover, title, excerpt, meta). */
export function BlogPostCardSkeleton() {
  return (
    <div className="rounded-xl border border-[var(--blog-border,#e5e7eb)] p-4 dark:border-[var(--blog-border,#1f2937)]" aria-hidden="true">
      <div className={`mb-3 h-44 w-full rounded-lg ${BAR}`} />
      <div className={`h-5 w-2/3 ${BAR}`} />
      <div className={`mt-3 h-3.5 w-full ${BAR}`} />
      <div className={`mt-2 h-3.5 w-4/5 ${BAR}`} />
      <div className={`mt-3 h-3 w-1/3 ${BAR}`} />
    </div>
  )
}

/** A list of post cards, while a blog's posts load. */
export function BlogPostListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-3 animate-pulse" role="status" aria-label="Loading posts">
      {Array.from({ length: count }, (_, index) => <BlogPostCardSkeleton key={index} />)}
    </div>
  )
}

/** A blog's home page before the blog itself has loaded: header, labels, posts. */
export function BlogHomeSkeleton() {
  return (
    <section className="rounded-2xl border border-gray-200 p-4 md:p-6 dark:border-gray-800" role="status" aria-label="Loading blog">
      <div className="mx-auto max-w-2xl animate-pulse" aria-hidden="true">
        <div className="mb-4 rounded-xl border border-gray-200 p-4 dark:border-gray-800">
          <div className={`h-3 w-24 ${BAR}`} />
          <div className={`mt-3 h-7 w-1/2 ${BAR}`} />
          <div className={`mt-3 h-3.5 w-full ${BAR}`} />
          <div className={`mt-2 h-3.5 w-3/4 ${BAR}`} />
          <div className="mt-4 flex items-center gap-3">
            <div className={`h-9 w-9 rounded-full ${BAR}`} />
            <div className={`ml-auto h-7 w-20 rounded-full ${BAR}`} />
          </div>
        </div>
        <div className="mb-4 flex gap-2">
          {[10, 14, 12, 16].map((width) => <div key={width} className={`h-6 rounded-full ${BAR}`} style={{ width: `${width * 4}px` }} />)}
        </div>
        <div className="space-y-3">
          {[0, 1, 2].map((index) => <BlogPostCardSkeleton key={index} />)}
        </div>
      </div>
    </section>
  )
}

/** A blog post before it has loaded: title, author row, cover, opening paragraphs. */
export function BlogPostSkeleton({ narrow = false }: { narrow?: boolean }) {
  return (
    <section role="status" aria-label="Loading post">
      <div className={`mx-auto ${narrow ? 'max-w-2xl' : 'max-w-5xl'} animate-pulse`} aria-hidden="true">
        <div className={`h-9 w-3/4 ${BAR}`} />
        <div className={`mt-3 h-4 w-full ${BAR}`} />
        <div className={`mt-2 h-4 w-2/3 ${BAR}`} />
        <div className="mt-6 flex items-center gap-3">
          <div className={`h-9 w-9 rounded-full ${BAR}`} />
          <div className="space-y-2">
            <div className={`h-3.5 w-32 ${BAR}`} />
            <div className={`h-3 w-24 ${BAR}`} />
          </div>
        </div>
        <div className={`mt-6 aspect-[16/9] w-full rounded-2xl ${BAR}`} />
        <div className="mt-6 space-y-3">
          {['w-full', 'w-11/12', 'w-full', 'w-4/5', 'w-full', 'w-3/4'].map((width, index) => <div key={index} className={`h-4 ${width} ${BAR}`} />)}
        </div>
      </div>
    </section>
  )
}
