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
 *
 * TODO(notifications PR, messages PR): return the real unread counts.
 */
export function useTabBadges(): TabBadges {
  return {};
}
