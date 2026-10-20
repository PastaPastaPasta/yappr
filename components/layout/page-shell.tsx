'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Sidebar } from './sidebar'
import { RightRail, RightSidebar } from './right-sidebar'

interface PageShellProps {
  children: ReactNode
  /** Extra classes on the centre column, e.g. to centre a spinner. */
  mainClassName?: string
  /** Hide the right column (wide-mode reading views). */
  hideRightSidebar?: boolean
  /**
   * Content for the right column in place of search and trending. It only
   * shows from `lg` up, so the page must place it elsewhere on smaller screens.
   */
  rightSidebar?: ReactNode
}

/**
 * The three-column app frame every page uses: left navigation, a 700px
 * centre column, the right sidebar. Pages render their own content inside;
 * use {@link PageHeader} for the sticky title bar.
 */
export function PageShell({ children, mainClassName, hideRightSidebar = false, rightSidebar }: PageShellProps) {
  return (
    <div className="min-h-screen flex">
      <Sidebar />
      <div className="flex-1 flex justify-center min-w-0">
        <main className={cn('w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800', mainClassName)}>
          {children}
        </main>
      </div>
      {!hideRightSidebar && (rightSidebar ? <RightRail>{rightSidebar}</RightRail> : <RightSidebar />)}
    </div>
  )
}

interface PageHeaderProps {
  children: ReactNode
  /** Drop the bottom border, for headers that carry their own tab strip. */
  borderless?: boolean
  className?: string
}

/**
 * The sticky bar at the top of the centre column. Opaque, as on Bluesky:
 * a translucent bar let scrolled text read through the tab labels wherever
 * the backdrop blur didn't apply. Children supply the row layout.
 */
export function PageHeader({ children, borderless = false, className }: PageHeaderProps) {
  return (
    <header
      className={cn(
        'sticky top-0 z-40 bg-white dark:bg-neutral-900',
        !borderless && 'border-b border-gray-200 dark:border-gray-800',
        className
      )}
    >
      {children}
    </header>
  )
}
