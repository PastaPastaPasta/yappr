import type { ConversationDTO } from '@engine/api';
import { router } from 'expo-router';

import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { confirmAlert } from '~/ui/Dialog';
import { errorFeedback, lightImpact } from '~/ui/haptics';
import { toast } from '~/ui/toast';

import { readErrorMessage, refreshDm } from './dm-data';
import { conversationTitle } from './dm-model';

/** Opens a conversation on the Messages tab's stack. */
export function openConversationScreen(key: string): void {
  router.push({ pathname: '/messages/[conversationId]', params: { conversationId: key } });
}

function failed(what: string, error: unknown): void {
  appendLog('warn', 'host', `${what} failed: ${errorMessage(error)}`);
  errorFeedback();
  toast.error(readErrorMessage(error) ?? "That didn't work. Please try again.");
}

/**
 * PRD DM-09 "Delete conversation" (v5), confirmed: hidden until a newer
 * message arrives. Resolves true once hidden.
 */
export async function deleteConversation(conversation: Pick<ConversationDTO, 'key' | 'kind' | 'name' | 'peer'>): Promise<boolean> {
  const confirmed = await confirmAlert({
    // Named, so the user sees which conversation goes.
    title: `Delete conversation with ${conversationTitle(conversation)}?`,
    message: 'It comes back if a new message arrives.',
    confirmText: 'Delete',
    destructive: true,
  });
  if (!confirmed) return false;
  try {
    await engine.api.dm.hide(conversation.key);
    toast.success('Conversation deleted. It comes back if a new message arrives.');
    refreshDm();
    return true;
  } catch (error) {
    failed('Deleting a conversation', error);
    return false;
  }
}

/**
 * Block or unblock someone in Messages (v5 DM-10, the encrypted self-state):
 * their messages and group invitations are ignored. Saved at once.
 */
export async function setBlockedInMessages(peerId: string, blocked: boolean): Promise<void> {
  try {
    await engine.api.dm.setBlocked(peerId, blocked);
    lightImpact();
    toast.success(blocked ? 'User blocked' : 'User unblocked');
    refreshDm();
  } catch (error) {
    failed(blocked ? 'Blocking' : 'Unblocking', error);
  }
}
