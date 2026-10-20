import brand from '@/public/brand/brand.json'
import { publicAsset } from '@/lib/public-asset'
import { cn } from '@/lib/utils'

/** The wide assets' viewBox height. */
const VIEW_HEIGHT = 64

/**
 * The brand set in public/brand/ (one folder; `npm run brand -- --use <style>` swaps it, see
 * docs/brand/README.md). Each asset has a light-background and a dark-background file, and the
 * theme's `dark` class picks one.
 */
function Themed({ name, alt, height, ratio, className, style }: {
  name: 'mark' | 'wordmark' | 'lockup'
  alt: string
  height: number
  ratio: number
  className?: string
  style?: React.CSSProperties
}) {
  const props = { width: Math.round(height * ratio), height, style, draggable: false }
  return (
    <>
      <img src={publicAsset(`/brand/${name}.svg`)} alt={alt} className={cn('inline-block dark:hidden', className)} {...props} />
      <img src={publicAsset(`/brand/${name}-dark.svg`)} alt={alt} className={cn('hidden dark:inline-block', className)} {...props} />
    </>
  )
}

/** The icon mark, square. */
export function BrandMark({ size = 32, alt = 'Yappr' }: { size?: number; alt?: string }) {
  return <Themed name="mark" alt={alt} height={size} ratio={1} />
}

/** Mark and wordmark side by side, `height` tall. */
export function Lockup({ height = 32, className }: { height?: number; className?: string }) {
  return <Themed name="lockup" alt="Yappr" height={height} ratio={brand.ratio.lockup} className={className} />
}

/**
 * The "yappr" wordmark sized to the surrounding text and sitting on its baseline, for headings
 * like "Sign in to yappr". 1.15em makes its letters about as tall as the text's.
 */
export function Wordmark() {
  const em = 1.15
  return (
    <Themed
      name="wordmark"
      alt="Yappr"
      height={VIEW_HEIGHT}
      ratio={brand.ratio.wordmark}
      style={{ height: `${em}em`, width: 'auto', verticalAlign: `${-(em * (VIEW_HEIGHT - brand.baseline)) / VIEW_HEIGHT}em` }}
    />
  )
}

/**
 * The "Powered by Dash" credit, linking to Dash Platform's source. Plain text in the app's font:
 * "Dash" is semibold Dash blue (#008DE4), which is 5.1:1 on the dark page but only 3.5:1 on
 * white, so light mode uses #0072BC (5.1:1) to stay above WCAG AA.
 */
export function PoweredByDash() {
  return (
    <a
      href="https://github.com/dashpay/platform"
      target="_blank"
      rel="noopener noreferrer"
      className="group inline-flex items-baseline gap-1 text-sm leading-5 text-gray-500 transition-colors hover:text-gray-900 dark:hover:text-gray-100"
    >
      Powered by{' '}
      <span className="font-semibold text-[#0072BC] group-hover:underline dark:text-[#008DE4]">Dash</span>
    </a>
  )
}
