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
  name: 'mark' | 'wordmark' | 'lockup' | 'powered-by'
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

/** The "Powered by Dash" credit, linking to Dash Platform's source. */
export function PoweredByDash() {
  return (
    <a
      href="https://github.com/dashpay/platform"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex opacity-80 transition-opacity hover:opacity-100"
    >
      <Themed name="powered-by" alt="Powered by Dash" height={24} ratio={brand.ratio.poweredBy} />
    </a>
  )
}
