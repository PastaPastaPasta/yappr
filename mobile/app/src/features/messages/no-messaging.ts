import { keepHandlesWhole } from '~/ui/handle';

/**
 * Someone who can't receive messages yet (no messaging key: the engine's
 * `PEER_NO_MESSAGING`, D-900), in web's words (`components/messages/dm-ui.tsx`).
 */
export function noMessagingYet(username?: string | null): string {
  return username ? keepHandlesWhole(`@${username} hasn't set up messaging yet.`) : "This person hasn't set up messaging yet.";
}
