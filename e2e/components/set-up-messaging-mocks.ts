// Test-only messaging key service: the anchor's key is held until the test confirms it, and nothing reaches Platform.
import type { AnchorKeyState, MessagingKeyDraft } from '../../lib/services/messaging-key-service'

export type { MessagingKeyDraft }

const setup = { sent: 0, adopted: 0 }
/** `?wallet`: the login key isn't the MASTER key, so the wallet approves; its polls are counted. */
const walletOnly = new URLSearchParams(location.search).has('wallet')
let handedOff = false
let confirm: () => void = () => undefined
const confirmation = new Promise<void>((resolve) => { confirm = resolve })

declare global {
  interface Window {
    messagingSetup?: typeof setup
    confirmMessagingKey?: () => void
    walletPolls?: number
  }
}
window.messagingSetup = setup
window.confirmMessagingKey = () => confirm()
window.walletPolls = 0

export class MessagingAlreadySetUpError extends Error {}
export class MessagingSetupCancelledError extends Error {}

export function draftMessagingKey(identityId: string): MessagingKeyDraft {
  return { identityId, anchorId: 'anchor', privateKey: new Uint8Array(32), publicKey: new Uint8Array(33) }
}

export const loginKeyIsMaster = async () => !walletOnly

/** No key until an update is sent or the wallet is asked; after that, this draft once the test confirms it. */
export async function anchorKeyState(): Promise<AnchorKeyState> {
  if (setup.sent === 0 && !handedOff) return 'none'
  if (handedOff) window.walletPolls = (window.walletPolls ?? 0) + 1
  await confirmation
  return 'this-key'
}

export async function addMessagingKeyWithLoginKey(_draft: MessagingKeyDraft, cancelled?: () => boolean) {
  if (cancelled?.()) throw new MessagingSetupCancelledError()
  setup.sent += 1
}

export const addMessagingKeyWithMasterKey = async (draft: MessagingKeyDraft, _masterKey: string, cancelled?: () => boolean) =>
  addMessagingKeyWithLoginKey(draft, cancelled)

export async function messagingKeyHandOffUri() {
  handedOff = true
  return 'dash-st:fixture'
}

export function adoptMessagingKey(): string {
  setup.adopted += 1
  localStorage.setItem('fixture-adopted-messaging-key', 'yes')
  return 'adopted-wif'
}
