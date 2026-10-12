'use client'

import { useEffect, useState } from 'react'
import { logger } from '@/lib/logger'
import { UserAvatar } from '@/components/ui/avatar-image'
import { Button } from '@/components/ui/button'

interface IdentityLabel {
  username: string | null
  displayName: string | null
}

async function loadIdentityLabel(identityId: string): Promise<IdentityLabel> {
  const [{ dpnsService }, { unifiedProfileService }] = await Promise.all([
    import('@/lib/services/dpns-service'),
    import('@/lib/services/unified-profile-service'),
  ])
  const [username, profile] = await Promise.all([
    dpnsService.resolveUsername(identityId).catch(() => null),
    unifiedProfileService.getProfile(identityId).catch(() => null),
  ])
  // A display name is chosen freely, so it may not pose as a username.
  const displayName = profile?.displayName?.trim().replace(/^@+/, '') || null
  return { username, displayName: displayName && displayName !== identityId ? displayName : null }
}

/** A lookup that never answers must not leave the button disabled for good. */
const LABEL_TIMEOUT_MS = 8_000

/** The end of an identity id, so two accounts with the same name still look different. */
function shortId(identityId: string): string {
  return `…${identityId.slice(-6)}`
}

/**
 * One account a wallet answered with: avatar, name, @username and the end of
 * its id, with "Continue as @name". Anyone can answer a sign-in code with
 * their own account, so this is the user's chance to notice it isn't theirs.
 */
export function IdentityConfirmCard({
  identityId,
  onContinue,
}: {
  identityId: string
  onContinue: (identityId: string) => void
}) {
  const [label, setLabel] = useState<IdentityLabel | null>(null)

  useEffect(() => {
    let cancelled = false
    const fallback = setTimeout(() => {
      if (!cancelled) setLabel((current) => current ?? { username: null, displayName: null })
    }, LABEL_TIMEOUT_MS)
    loadIdentityLabel(identityId)
      .then((loaded) => { if (!cancelled) setLabel(loaded) })
      .catch((error: unknown) => {
        logger.warn('Could not load the account to confirm:', error)
        if (!cancelled) setLabel({ username: null, displayName: null })
      })
    return () => {
      cancelled = true
      clearTimeout(fallback)
    }
  }, [identityId])

  const handle = label?.username ? `@${label.username.replace(/\.dash$/, '')}` : null
  // Only the username (from DPNS) or the id itself, never the free-form display name.
  const continueLabel = handle ?? shortId(identityId)

  return (
    <div className="rounded-2xl ring-1 ring-gray-200 dark:ring-neutral-700 p-4 flex flex-col gap-4" data-testid="identity-confirm-card" data-identity-id={identityId}>
      <div className="flex items-center gap-3 min-w-0">
        <UserAvatar userId={identityId} size="lg" />
        <div className="min-w-0">
          {label === null ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">Loading account…</p>
          ) : (
            <>
              <p className="font-semibold text-gray-900 dark:text-white truncate">{label.displayName ?? handle ?? 'No username'}</p>
              <p className="text-sm text-gray-600 dark:text-gray-400 truncate">
                {handle && <span>{handle} · </span>}
                <span className="font-mono">{shortId(identityId)}</span>
              </p>
            </>
          )}
        </div>
      </div>
      <Button className="w-full" size="lg" disabled={label === null} onClick={() => onContinue(identityId)}>
        Continue as {continueLabel}
      </Button>
    </div>
  )
}
