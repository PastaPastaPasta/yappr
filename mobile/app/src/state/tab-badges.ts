import { useMessagesBadge } from '~/features/messages/dm-data';
import { useNotificationsBadge } from '~/features/notifications/notifications-data';

export interface TabBadges {
  /** Unread notifications of the enabled types (NOTIF-03). */
  notifications?: number;
  /** Conversations with unread messages (DM-13). */
  messages?: number;
}

/**
 * Badge counts for the tab bar. The tab layout calls this, so the
 * notifications and messages PRs fill in their count here without editing
 * the shared layout (EXECUTION §5.4).
 */
export function useTabBadges(): TabBadges {
  // Also runs the foreground notifications poll (every 30 s while signed in).
  const notifications = useNotificationsBadge();
  // Also keeps the inbox and open conversations live (`dm.changed` / `dm.message`).
  const messages = useMessagesBadge();
  return { notifications, messages };
}
