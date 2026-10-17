import { useEffect } from 'react'

/**
 * Name the browser tab after what a page shows once it has loaded (a profile,
 * a post, a tag). The static export can only give each route one title, set in
 * its layout; this refines it on the client and restores it on the way out.
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (!title) return
    const previous = document.title
    const next = `${title} · Yappr`
    document.title = next
    return () => {
      // The next route may already have set its own title; only undo ours.
      if (document.title === next) document.title = previous
    }
  }, [title])
}
