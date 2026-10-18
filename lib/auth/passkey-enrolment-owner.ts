/**
 * Who answers for a passkey made but not yet saved, while a dialog shows it.
 *
 * The add-passkey dialog makes a passkey, then waits for the user to confirm
 * it. Until a confirmation takes it over, the dialog owns it, and when the
 * dialog goes (closed, or the session ended) a passkey it still owns is
 * abandoned: its PRF output wiped, the provider told to drop it. Ownership is
 * recorded the moment each step resolves, never from what was last rendered,
 * so a dialog removed before React shows the next step still cleans up.
 *
 * While a confirmation runs it owns the passkey (it keeps one whose write may
 * still land, and abandons one it ends). A confirmation that comes back
 * cancelled hands the passkey back for another tap, or abandons it if the
 * dialog went meanwhile.
 */
import type { PendingPasskey } from './passkey-vault'

export interface EnrolmentOwner {
  /** Whether the dialog is still there. */
  readonly open: boolean
  /** The dialog is there (again, on a remount). */
  reopen(): void
  /** A passkey was made: the dialog owns it, or it is abandoned at once if the dialog went. */
  created(pending: PendingPasskey): void
  /** A confirmation takes it over until it unwinds. */
  confirming(): void
  /** The confirmation came back cancelled: the dialog owns it again, or it is abandoned if the dialog went. */
  cancelled(pending: PendingPasskey): void
  /** The dialog goes: a passkey it still owns is abandoned. */
  close(): void
}

export function enrolmentOwner(abandon: (pending: PendingPasskey) => void): EnrolmentOwner {
  let owned: PendingPasskey | null = null
  let open = true
  const take = (pending: PendingPasskey) => {
    if (open) owned = pending
    else abandon(pending)
  }
  return {
    get open() {
      return open
    },
    reopen() {
      open = true
    },
    created: take,
    confirming() {
      owned = null
    },
    cancelled: take,
    close() {
      open = false
      const left = owned
      owned = null
      if (left) abandon(left)
    },
  }
}
