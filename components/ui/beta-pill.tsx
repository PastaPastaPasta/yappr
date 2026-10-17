import { cn } from '@/lib/utils'
import { isBeta, type BetaProduct } from '@/lib/feature-flags'

/** The small "Beta" label beside a product's name, shown while the build marks it Beta. */
export function BetaPill({ product, className }: { product: BetaProduct; className?: string }) {
  if (!isBeta(product)) return null
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border border-yappr-200 bg-yappr-50 px-1.5 text-[10px] font-semibold uppercase leading-4 tracking-wider text-yappr-700',
        'dark:border-yappr-800 dark:bg-yappr-950 dark:text-yappr-300',
        className
      )}
    >
      Beta
    </span>
  )
}
