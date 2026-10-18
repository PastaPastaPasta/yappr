import { storefrontStatusIsSealed } from '@/lib/constants'

/**
 * Facts the legal pages, the sign-in consent line and the support links share,
 * so they cannot drift apart.
 */

/** Where users, rights holders and reporters reach the Yappr team (the address the mobile apps use too). */
export const SUPPORT_EMAIL = 'support@yap.pr'

export const SUPPORT_MAILTO = `mailto:${SUPPORT_EMAIL}`

/** Bugs and feature requests. */
export const ISSUES_URL = 'https://github.com/PastaPastaPasta/yappr/issues'

export const SOURCE_URL = 'https://github.com/PastaPastaPasta/yappr'

/** The youngest age the Terms allow. */
export const MINIMUM_AGE = 18

/** Printed as "Last updated" on Terms, Privacy, Cookies and About. Bump it with any change to what they say. */
export const LEGAL_UPDATED = '18 October 2026'

/** The Community Rules, a section of the Terms. */
export const COMMUNITY_RULES_HREF = '/terms#community-rules'

/** Status and timestamps are public on every storefront; the note fields depend on the deployed contract. */
export function orderStatusPrivacyDisclosure(): string {
  return storefrontStatusIsSealed()
    ? 'Tracking numbers, carrier details and seller notes are encrypted for you and the seller.'
    : 'Tracking numbers, carrier details and seller notes are public. Do not include private information in them.'
}
