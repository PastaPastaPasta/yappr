import * as React from "react"
import { cn } from "@/lib/utils"

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-xl border border-surface-200 bg-white px-3.5 py-2 text-sm transition-colors placeholder:text-surface-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yappr-500/40 focus-visible:border-yappr-500/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-surface-700 dark:bg-surface-900 dark:placeholder:text-surface-500 dark:focus-visible:border-yappr-500/50",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
