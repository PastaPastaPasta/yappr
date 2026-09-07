'use client'

import type { ReactNode } from 'react'
import * as Tooltip from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'

interface TooltipButtonProps {
  /** The tooltip text; also used as the accessible name unless `aria-label` is given. */
  label: string
  'aria-label'?: string
  onClick: () => void
  children: ReactNode
  className?: string
  /** Extra tooltip classes, e.g. `max-w-xs` for long copy. */
  tooltipClassName?: string
}

/** A round bordered icon button with a tooltip. */
export function TooltipButton({ label, 'aria-label': ariaLabel, onClick, children, className, tooltipClassName }: TooltipButtonProps) {
  return (
    <Tooltip.Provider>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            onClick={onClick}
            aria-label={ariaLabel ?? label}
            className={cn(
              'p-2 rounded-full border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors',
              className
            )}
          >
            {children}
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className={cn('bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded', tooltipClassName)} sideOffset={5}>
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}

/** A small inline pill with a tooltip, for the badges under a display name. */
export function TooltipBadge({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <Tooltip.Provider>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span className={cn('inline-flex items-center gap-1 px-2 py-1 text-xs font-medium', className)}>{children}</span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="bg-gray-800 dark:bg-gray-700 text-white text-xs px-2 py-1 rounded max-w-xs" sideOffset={5}>
            {label}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
