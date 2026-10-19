import { useEffect } from 'react'
import { PasskeyPrompts } from '@/components/auth/passkey-prompts'
import { usePasskeyPrompts } from '@/hooks/use-passkey-prompts'
import { useAuth } from '@/contexts/auth-context'

/** The after-sign-in passkey offer, open for the signed-in (mocked) identity. */
export function PasskeyEnrolFixture() {
  const identityId = useAuth().user?.identityId
  useEffect(() => { if (identityId) usePasskeyPrompts.getState().open('offer', identityId) }, [identityId])
  return <PasskeyPrompts />
}
