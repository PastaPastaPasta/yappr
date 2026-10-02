import { router } from 'expo-router';
import { Platform, Share } from 'react-native';

import { sendWrite } from '~/data/writes';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { copyText } from '~/features/post/post-navigation';
import { followWrite } from '~/features/post/post-writes';
import { showActionSheet } from '~/ui/action-sheet';
import { lightImpact } from '~/ui/haptics';

import { profileWebUrl } from './profile-format';

/** Profile actions shared by the header, the menus and the user rows. */

/** The share sheet with the profile's yap.pr link (PRD PROF-12). */
export function shareProfile(identityId: string, name: string): void {
  const url = profileWebUrl(identityId);
  const text = `${name} on Yappr`;
  const content = Platform.OS === 'ios' ? { url, message: text } : { message: `${text}\n${url}`, title: text };
  Share.share(content).catch((error: unknown) => appendLog('warn', 'host', `Share failed: ${errorMessage(error)}`));
}

export function copyProfileLink(identityId: string): void {
  copyText(profileWebUrl(identityId), 'Profile link copied!');
}

/**
 * Follow at once (PRD PROF-03); unfollow asks first ("Unfollow @x?", PD-6).
 * Both are optimistic through `followWrite`, so every surface showing the
 * user flips together.
 */
export function toggleFollow(identityId: string, handle: string, following: boolean): void {
  if (!following) {
    lightImpact();
    sendWrite(followWrite, { authorId: identityId, follow: true }, 'Following!');
    return;
  }
  showActionSheet({
    title: `Unfollow ${handle}?`,
    actions: [
      {
        label: 'Unfollow',
        destructive: true,
        onPress: () => sendWrite(followWrite, { authorId: identityId, follow: false }, 'Unfollowed'),
      },
    ],
  });
}

/**
 * "Message" (PRD PROF-09): the existing 1:1 with this user, or a new one.
 * `dm.startDirect` finds or opens it without writing anything; when it
 * can't (messages locked, still restoring), the new-message screen takes
 * the user from there.
 */
export async function messageUser(identityId: string): Promise<void> {
  try {
    const conversationId = await engine.api.dm.startDirect(identityId);
    router.push({ pathname: '/messages/[conversationId]', params: { conversationId } });
  } catch (error) {
    appendLog('info', 'host', `Opening a conversation from a profile: ${errorMessage(error)}`);
    router.push({ pathname: '/messages/new', params: { with: identityId } });
  }
}
