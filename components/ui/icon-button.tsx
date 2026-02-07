import * as React from 'react'
import { cn } from '@/lib/utils'

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger'
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          'group relative flex h-9 w-9 items-center justify-center rounded-xl transition-all duration-200',
          'hover:bg-zinc-100 dark:hover:bg-zinc-800/50',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yappr-500/50',
          'disabled:pointer-events-none disabled:opacity-50',
          'interactive-scale',
          {
            'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100': variant === 'default',
            'text-yappr-500 hover:text-yappr-600 hover:bg-yappr-50 dark:hover:bg-yappr-950': variant === 'primary',
            'text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950': variant === 'danger',
          },
          className
        )}
        {...props}
      />
    )
  }
)
IconButton.displayName = 'IconButton'
