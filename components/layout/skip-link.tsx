'use client'

import type { MouseEvent } from 'react'

/**
 * "Skip to content": the first stop for keyboard users, visible only while
 * focused. It moves focus to the page's `<main>`, which every page frame
 * renders; a standalone page without one gets its first heading instead.
 */
export function SkipLink() {
  const skip = (event: MouseEvent<HTMLAnchorElement>) => {
    const target = document.querySelector<HTMLElement>('main') ?? document.querySelector<HTMLElement>('h1, h2')
    if (!target) return
    event.preventDefault()
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
    target.focus()
    target.scrollIntoView()
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
