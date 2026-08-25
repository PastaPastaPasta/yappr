import type { SocialLink, LegacyStoreContactMethods } from '@/lib/types'

/**
 * Convert legacy StoreContactMethods object to SocialLink[] format
 * Used for backward compatibility when loading old store data
 */
export function legacyContactMethodsToSocialLinks(methods: LegacyStoreContactMethods | undefined): SocialLink[] {
  if (!methods) return []

  const links: SocialLink[] = []
  if (methods.email) links.push({ platform: 'email', handle: methods.email })
  if (methods.signal) links.push({ platform: 'signal', handle: methods.signal })
  if (methods.twitter) links.push({ platform: 'twitter', handle: methods.twitter })
  if (methods.telegram) links.push({ platform: 'telegram', handle: methods.telegram })

  return links
}
