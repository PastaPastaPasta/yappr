'use client'

import { useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useIsModerator } from '@/hooks/use-is-moderator'
import { MODERATED_CONTRACTS, moderatedContract, type ModeratedContractKey } from '@/lib/moderated-contracts'
import { cn } from '@/lib/utils'
import { ContractModerationSettings, type ModerationCitation } from './contract-moderation-settings'

/** The contracts whose moderation team the signed-in identity is on, in a fixed order. */
export function useModeratedContracts(): ModeratedContractKey[] {
  const social = useIsModerator('social')
  const storefront = useIsModerator('storefront')
  const blog = useIsModerator('blog')
  return useMemo(() => {
    const on: Record<ModeratedContractKey, boolean> = { social, storefront, blog }
    return MODERATED_CONTRACTS.filter((key) => on[key])
  }, [social, storefront, blog])
}

const isContractKey = (value: string | null): value is ModeratedContractKey =>
  value !== null && (MODERATED_CONTRACTS as readonly string[]).includes(value)

/** `?author=<identity>&cite=<docType>:<documentId>`, as a document's moderator menu links here. */
function citationOf(author: string | null, cite: string | null): ModerationCitation | undefined {
  const [docType, documentId] = cite?.split(':') ?? []
  return author && docType && documentId ? { authorId: author, docType, documentId } : undefined
}

/**
 * The moderation settings of every contract the viewer moderates, one at a
 * time: social, storefront and blogs each have their own team, lists and pot,
 * so a tab picks which. `?contract=` selects it (a document's moderator menu
 * links straight to its contract, with its author and the document filled in).
 */
export function ContractModerationSections({ contracts }: { contracts: readonly ModeratedContractKey[] }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get('contract')
  const active = isContractKey(requested) && contracts.includes(requested) ? requested : contracts[0]
  const citation = active === requested ? citationOf(searchParams.get('author'), searchParams.get('cite')) : undefined
  if (!active) return null

  return (
    <div className="space-y-4">
      {contracts.length > 1 && (
        <div role="tablist" aria-label="Contract to moderate" className="flex gap-2">
          {contracts.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={key === active}
              onClick={() => router.replace(`/settings?section=moderation&contract=${key}`)}
              className={cn(
                'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
                key === active
                  ? 'bg-yappr-500 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
              )}
            >
              {moderatedContract(key).label}
            </button>
          ))}
        </div>
      )}
      <ContractModerationSettings
        key={`${active}:${citation ? `${citation.authorId}:${citation.docType}:${citation.documentId}` : ''}`}
        contract={active}
        citation={citation}
      />
    </div>
  )
}
