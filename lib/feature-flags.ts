import { isAppConnectBuild } from '@/lib/app-connect/config'

/**
 * Build-time product switches (`NEXT_PUBLIC_FEATURE_*`).
 *
 * They change what the UI offers, never what it reads: a Beta product still
 * loads every document, and hiding credit tips leaves the tips already sent
 * untouched. Every `process.env.NEXT_PUBLIC_*` read is spelled out literally so
 * Next inlines it into the static export.
 */

/** Products that launch with a Beta label until they are switched to `ga`. */
export type BetaProduct = 'store' | 'blog'

function featureValue(product: BetaProduct): string | undefined {
  return product === 'store' ? process.env.NEXT_PUBLIC_FEATURE_STORE : process.env.NEXT_PUBLIC_FEATURE_BLOG
}

/** Whether a product carries its Beta label. Anything but `ga` keeps it. */
export function isBeta(product: BetaProduct): boolean {
  return featureValue(product)?.trim() !== 'ga'
}

/**
 * Whether the tip dialog offers a direct credit transfer. It needs a transfer
 * key pasted into the browser, and wallet (App Connect) sign-ins hold none, so
 * those builds leave it out unless `NEXT_PUBLIC_FEATURE_CREDIT_TIPS=on`. `off`
 * hides it on every build. Tips to a profile's payment addresses always stay.
 */
export function creditTipsEnabled(): boolean {
  const value = process.env.NEXT_PUBLIC_FEATURE_CREDIT_TIPS?.trim()
  if (value === 'on') return true
  if (value === 'off') return false
  return !isAppConnectBuild()
}
