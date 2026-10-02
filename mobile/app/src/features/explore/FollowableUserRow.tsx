import type { UserSummaryDTO } from '@engine/api';

import type { EngineRemote } from '~/data/queries';
import { requireAuth } from '~/data/require-auth';
import { useSession, useSessionStore } from '~/data/session';
import { sendWrite } from '~/data/writes';
import { errorMessage, appendLog } from '~/engine/logs';
import { followWrite } from '~/features/post/post-writes';
import { openUser } from '~/features/post/post-navigation';
import { showActionSheet } from '~/ui/action-sheet';
import { handleOf } from '~/ui/handle';
import { lightImpact } from '~/ui/haptics';
import { UserRow } from '~/ui/UserRow';

/** `graph.status` reads at most this many ids at once. */
const STATUS_BATCH = 100;
/** How long a read waits for the saved session to restore before reading as signed out. */
const SESSION_WAIT_MS = 5000;

/**
 * The signed-in identity, once the engine has restored the session: a read
 * made earlier (a cold-start deep link) would otherwise cache rows with no
 * follow state, and the same account restoring doesn't refetch them.
 */
function settledViewer(): Promise<string | null> {
  const viewer = () => useSessionStore.getState().session?.identityId ?? null;
  if (useSessionStore.getState().status !== 'unknown') return Promise.resolve(viewer());
  return new Promise((resolve) => {
    let stop = () => {};
    const done = () => {
      clearTimeout(timer);
      stop();
      resolve(viewer());
    };
    const timer = setTimeout(done, SESSION_WAIT_MS);
    stop = useSessionStore.subscribe((state) => {
      if (state.status !== 'unknown') done();
    });
  });
}

/**
 * The signed-in viewer's follow of each user, for rows whose read skips it
 * (search and the leaderboards, as on web). Signed out, nothing: those rows
 * show no follow state. A failed read fails the whole query, so it retries
 * and offers Retry rather than caching rows with no follow controls.
 */
export async function readFollowStatus(api: EngineRemote, ids: readonly string[]): Promise<Record<string, boolean>> {
  const viewer = await settledViewer();
  const others = Array.from(new Set(ids)).filter((id) => id !== viewer);
  if (!viewer || others.length === 0) return {};
  try {
    return await api.graph.status(others.slice(0, STATUS_BATCH));
  } catch (error) {
    appendLog('warn', 'host', `Follow status failed: ${errorMessage(error)}`);
    throw error;
  }
}

/** The user with `viewerFollows` from a `readFollowStatus` answer, where it has one. */
export function withFollowStatus(user: UserSummaryDTO, status: Record<string, boolean>): UserSummaryDTO {
  const follows = status[user.id];
  return typeof follows === 'boolean' ? { ...user, viewerFollows: follows } : user;
}

export interface FollowableUserRowProps {
  user: UserSummaryDTO;
  /** Show the follow button (UX_SPEC §2.10). Search previews don't. */
  followable?: boolean;
  rank?: number;
  detail?: string;
  /** Runs before the profile opens (recent searches). */
  onOpen?: (user: UserSummaryDTO) => void;
  testID?: string;
}

/**
 * A user row wired to the profile and the follow write. Signed out, "Follow"
 * opens the sign-in sheet (PRD G-8); signed in, the button shows only once
 * the viewer's follow is known. Unfollowing asks first (PRD PD-6).
 */
export function FollowableUserRow({ user, followable = true, rank, detail, onOpen, testID }: FollowableUserRowProps) {
  const { status, identityId } = useSession();
  const isSelf = user.id === identityId;
  const known = typeof user.viewerFollows === 'boolean';
  const following = user.viewerFollows === true;
  const showFollow = followable && !isSelf && (known || status === 'signed-out');
  const authorId = user.id;
  const handle = handleOf(user);

  const follow = () => {
    lightImpact();
    sendWrite(followWrite, { authorId, follow: true }, 'Following!');
  };
  const unfollow = () =>
    showActionSheet({
      title: `Unfollow ${handle}?`,
      actions: [
        {
          label: 'Unfollow',
          destructive: true,
          onPress: () => sendWrite(followWrite, { authorId, follow: false }, 'Unfollowed'),
        },
      ],
    });

  return (
    <UserRow
      user={user}
      isSelf={isSelf}
      following={following}
      rank={rank}
      detail={detail}
      onFollowPress={showFollow ? () => requireAuth(following ? unfollow : follow) : undefined}
      onPress={() => {
        onOpen?.(user);
        openUser(authorId);
      }}
      testID={testID}
    />
  );
}
