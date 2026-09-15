'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/lib/store'
import { Sidebar } from './sidebar'
import { RightSidebar } from './right-sidebar'

interface PageShellProps {
  children: ReactNode
  /** Extra classes on the centre column, e.g. to centre a spinner. */
  mainClassName?: string
  /** Hide the right column (wide-mode reading views). */
  hideRightSidebar?: boolean
}

/**
 * The three-column app frame every signed-in page uses: left navigation, a
 * 700px centre column, the right sidebar. Pages render their own content
 * inside; use {@link PageHeader} for the sticky title bar.
 */
export function PageShell({ children, mainClassName, hideRightSidebar = false }: PageShellProps) {
  return (
    <div className="min-h-[calc(100vh-40px)] flex">
      <Sidebar />
      <div className="flex-1 flex justify-center min-w-0">
        <main className={cn('w-full max-w-[700px] md:border-x border-gray-200 dark:border-gray-800', mainClassName)}>
          {children}
        </main>
      </div>
      {!hideRightSidebar && <RightSidebar />}
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
 * The translucent sticky bar at the top of the centre column. The blur is
 * skipped in potato mode. Children supply the row layout.
 */
export function PageHeader({ children, borderless = false, className }: PageHeaderProps) {
  const potatoMode = useSettingsStore((s) => s.potatoMode)
  return (
    <header
      className={cn(
        'sticky top-[32px] sm:top-[40px] z-40 bg-white/80 dark:bg-neutral-900/80',
        !borderless && 'border-b border-gray-200 dark:border-gray-800',
        !potatoMode && 'backdrop-blur-xl',
        className
      )}
    >
      {children}
    </header>
  )
}
