import { useState } from 'react'
import { AddEncryptionKeyModal } from '../../components/auth/add-encryption-key-modal'
import { bindCurrentIdentity } from '@/lib/auth/active-identity'
import { storePrivateKey } from '@/lib/secure-storage'
import { DUMMY_IDENTITY } from './private-feed-mocks'

// WIF for public scalar 1, the signed-in login key. Never use with an actual identity or funds.
storePrivateKey(DUMMY_IDENTITY, 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA')
bindCurrentIdentity(() => DUMMY_IDENTITY)

/** The legacy add-encryption-key dialog, open for the signed-in (mocked) identity. */
export function EncryptionKeyModalFixture() {
  const [open, setOpen] = useState(true)
  return (
    <>
      <p data-testid="modal-state">{open ? 'open' : 'closed'}</p>
      <AddEncryptionKeyModal isOpen={open} onClose={() => setOpen(false)} />
    </>
  )
}
