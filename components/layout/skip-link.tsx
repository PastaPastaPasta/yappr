'use client'

import type { MouseEvent } from 'react'

/**
 * "Skip to content": the first stop for keyboard users, visible only while
 * focused. It moves focus to the page's `<main>`, which every page frame
 * renders, so no page has to carry an id for it.
 */
export function SkipLink() {
  const skip = (event: MouseEvent<HTMLAnchorElement>) => {
    const main = document.querySelector('main')
    if (!main) return
    event.preventDefault()
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1')
    main.focus()
    main.scrollIntoView()
  }

  return (
    <a
      href="#main"
      onClick={skip}
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-full focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-gray-900 focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-yappr-600 dark:focus:bg-neutral-900 dark:focus:text-white"
    >
      Skip to content
    </a>
  )
}
