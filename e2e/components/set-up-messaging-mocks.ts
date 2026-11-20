// Test-only messaging key service: the anchor's key is held until the test confirms it, and nothing reaches Platform.
import type { AnchorKeyState, MessagingKeyDraft } from '../../lib/services/messaging-key-service'

export type { MessagingKeyDraft }

const setup = { sent: 0, adopted: 0 }
let confirm: () => void = () => undefined
const confirmation = new Promise<void>((resolve) => { confirm = resolve })

declare global {
  interface Window {
    messagingSetup?: typeof setup
    confirmMessagingKey?: () => void
  }
}
window.messagingSetup = setup
window.confirmMessagingKey = () => confirm()

export class MessagingAlreadySetUpError extends Error {}
export class MessagingSetupCancelledError extends Error {}

export function draftMessagingKey(identityId: string): MessagingKeyDraft {
  return { identityId, anchorId: 'anchor', privateKey: new Uint8Array(32), publicKey: new Uint8Array(33) }
}

export const loginKeyIsMaster = async () => true

/** No key until an update is sent; after that, this draft once the test confirms it. */
export async function anchorKeyState(): Promise<AnchorKeyState> {
  if (setup.sent === 0) return 'none'
  await confirmation
  return 'this-key'
}

export async function addMessagingKeyWithLoginKey(_draft: MessagingKeyDraft, cancelled?: () => boolean) {
  if (cancelled?.()) throw new MessagingSetupCancelledError()
  setup.sent += 1
}

export const addMessagingKeyWithMasterKey = async (draft: MessagingKeyDraft, _masterKey: string, cancelled?: () => boolean) =>
  addMessagingKeyWithLoginKey(draft, cancelled)

export const messagingKeyHandOffUri = async () => 'dash-st:fixture'

export function adoptMessagingKey(): string {
  setup.adopted += 1
  localStorage.setItem('fixture-adopted-messaging-key', 'yes')
  return 'adopted-wif'
}
