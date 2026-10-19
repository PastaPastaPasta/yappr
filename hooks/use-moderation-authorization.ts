'use client'

import { useMemo } from 'react'
import { useAuth } from '@/contexts/auth-context'
import { hasAppConnectSession } from '@/lib/auth/signing-keys'
import { getPrivateKey } from '@/lib/secure-storage'
import { matchIdentityKey } from '@/lib/crypto/keys'
import { KeyPurpose, SecurityLevel } from '@/lib/crypto/identity-keys'
import { keyNetwork } from '@/lib/constants'

/** Mirrors the moderation signer's key requirement; team membership is checked separately. */
export function useModerationAuthorization(enabled = true): boolean {
  const { user } = useAuth()
  return useMemo(() => {
    if (!enabled || !user || typeof window === 'undefined' || hasAppConnectSession(user.identityId)) return false
    const key = getPrivateKey(user.identityId)
    return key !== null && matchIdentityKey(key, user.publicKeys.map(publicKey => ({ ...publicKey, data: publicKey.data })), {
      network: keyNetwork(),
      purpose: KeyPurpose.AUTHENTICATION,
      allowedSecurityLevels: [SecurityLevel.CRITICAL],
    }).ok
  }, [enabled, user])
}
