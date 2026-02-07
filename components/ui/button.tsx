import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-semibold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yappr-500/40 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 interactive-scale',
  {
    variants: {
      variant: {
        default: 'bg-gradient-yappr text-white hover:shadow-yappr hover:brightness-110',
        destructive: 'bg-red-500 text-white hover:bg-red-600 hover:shadow-lg hover:shadow-red-500/20',
        outline: 'border border-surface-200 dark:border-surface-700 bg-transparent hover:bg-surface-50 dark:hover:bg-surface-800/50 text-gray-700 dark:text-gray-200',
        secondary: 'bg-surface-100 dark:bg-surface-800 text-gray-800 dark:text-gray-200 hover:bg-surface-200 dark:hover:bg-surface-700',
        ghost: 'hover:bg-surface-100 dark:hover:bg-surface-800 text-gray-700 dark:text-gray-300',
        link: 'text-yappr-500 underline-offset-4 hover:underline',
        accent: 'bg-gradient-accent text-white hover:shadow-lg hover:shadow-accent-500/20 hover:brightness-110',
      },
      size: {
        default: 'h-10 px-5 py-2',
        sm: 'h-8 px-3.5 text-xs',
        lg: 'h-12 px-7 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    if (asChild) {
      const child = React.Children.only(props.children as React.ReactElement)
      return React.cloneElement(child, {
        className: cn(buttonVariants({ variant, size, className }), child.props.className),
        ref,
      })
    }

    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
