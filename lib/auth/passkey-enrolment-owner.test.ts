import { describe, expect, it, vi } from 'vitest'
import { enrolmentOwner } from './passkey-enrolment-owner'
import type { PendingPasskey } from './passkey-vault'

const made = (): PendingPasskey => ({ identityId: 'id', credentialId: new Uint8Array([1]), createPrf: new Uint8Array(32).fill(5) })

describe('the add-passkey dialog\'s hold on an unsaved passkey', () => {
  it('abandons a passkey made just before the dialog went, before any confirm step was shown', () => {
    const abandon = vi.fn()
    const owner = enrolmentOwner(abandon)
    const pending = made()
    // Creation resolves (the confirm step is only queued), then a sign-out removes the dialog.
    owner.created(pending)
    owner.close()
    expect(abandon).toHaveBeenCalledWith(pending)
  })

  it('abandons a passkey made after the dialog went', () => {
    const abandon = vi.fn()
    const owner = enrolmentOwner(abandon)
    owner.close()
    const pending = made()
    owner.created(pending)
    expect(abandon).toHaveBeenCalledWith(pending)
  })

  it('leaves a running confirmation alone, and takes back one that comes back cancelled', () => {
    const abandon = vi.fn()
    const owner = enrolmentOwner(abandon)
    const pending = made()
    owner.created(pending)
    owner.confirming()
    // The dialog goes while the confirmation runs: its write may yet land, so nothing is abandoned now.
    owner.close()
    expect(abandon).not.toHaveBeenCalled()
    // It then comes back cancelled: nobody can tap Confirm again.
    owner.cancelled(pending)
    expect(abandon).toHaveBeenCalledWith(pending)
  })

  it('keeps a cancelled confirmation for another tap while the dialog is there', () => {
    const abandon = vi.fn()
    const owner = enrolmentOwner(abandon)
    const pending = made()
    owner.created(pending)
    owner.confirming()
    owner.cancelled(pending)
    expect(abandon).not.toHaveBeenCalled()
    owner.close()
    expect(abandon).toHaveBeenCalledTimes(1)
  })
})
