import blog from '@/contracts/yappr-blog-contract.json'
import storefront from '@/contracts/yappr-storefront-contract.json'
import { contentLimits, socialTextFieldLimits } from '@/lib/contract-topology'
import type { ModeratedContractKey } from '@/lib/moderated-contracts'
import type { TextLimits } from './text-limits'

const contracts = { blog, storefront }
export function fieldLimits(contract: ModeratedContractKey, document: string, field: string): TextLimits {
  if (contract === 'social' && (document === 'post' || document === 'reply') && field === 'content') return contentLimits()
  if (contract === 'social') return socialTextFieldLimits(document, field)
  const schemas = contracts[contract].documentSchemas as Record<string, { properties?: Record<string, TextLimits & { items?: TextLimits }> }>
  const property = schemas[document]?.properties?.[field.replace(/\[\]$/, '')]
  const declared = (field.endsWith('[]') ? property?.items : property) ?? {}
  return { maxLength: declared.maxLength, maxBytes: declared.maxBytes }
}
