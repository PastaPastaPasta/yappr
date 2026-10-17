'use client'

import { useEffect, useState } from 'react'
import { useSdk } from '@/contexts/sdk-context'
import { watchModeratedTypeOpen } from '@/lib/moderated-type-gate'
import { moderatedContract, type ModeratedContractKey } from '@/lib/moderated-contracts'
import { moderationServiceFor } from '@/lib/services/moderation-service'

/**
 * Whether `docType` on `contract` (social by default) can be written now. A
 * contract registered with a `notYetUsable` interim (testnet and mainnet)
 * refuses every write of its moderated types (41200) until masternodes seat
 * its first moderation team: posts, replies, reports and the profile extension
 * on social; stores, listings and reviews on the storefront; blogs, posts and
 * comments on blogs. Each contract seats its own team, so each opens on its own
 * schedule. On an elected contract the registered declaration and the seated
 * team are read (cached, shared with the moderator checks); off one it is open
 * without a read. Until the read answers, and when it fails, it counts as
 * open: the write itself is refused with the same explanation if it is not.
 *
 * While `active` (the screen or dialog that writes it is shown), the gate
 * reads again on every activation, every minute while it is closed, and
 * whenever the window regains focus, so a session opened before the first team
 * was seated opens once one is, without a reload. It starts once the SDK is
 * ready: a page that shows the gate from first paint renders before
 * SdkProvider has initialised it, and a read then would only fail.
 */
export function useModeratedTypeOpen(docType: string, active = true, contract: ModeratedContractKey = 'social'): boolean {
  const moderated = moderatedContract(contract).elected()?.moderatedDocumentTypes[docType] !== undefined
  const [closed, setClosed] = useState<string | null>(null)
  const key = `${contract}:${docType}`
  const { isReady: sdkReady } = useSdk()

  useEffect(() => {
    if (!moderated || !active || !sdkReady) return
    return watchModeratedTypeOpen(
      () => moderationServiceFor(contract).moderatedTypeOpen(docType),
      (open) => setClosed(open ? null : key),
      { targets: typeof window === 'undefined' ? [] : [window, document] }
    )
  }, [contract, docType, key, moderated, active, sdkReady])

  return closed !== key
}
