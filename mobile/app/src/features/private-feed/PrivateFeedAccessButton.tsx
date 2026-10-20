import type { PrivateAccessDTO } from '@engine/api';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { ArrowPathIcon, CheckIcon, ClockIcon, LockClosedIcon } from 'react-native-heroicons/outline';

import { useLandingIntent } from '~/data/writes';
import { Button } from '~/ui/Button';
import { Text } from '~/ui/Text';

import { copy } from './copy';
import { accessKey, confirmLeave, requestAccess, usePrivateAccess } from './private-feed-data';

/** The control for one access state; null for the viewer's own feed. */
function control(status: PrivateAccessDTO['status'], ownerId: string, name: string, busy: boolean): ReactNode {
  const request = () => requestAccess(ownerId);
  const leave = (member: boolean) => () => {
    confirmLeave(ownerId, member).catch(() => undefined);
  };
  switch (status) {
    case 'pending':
      return (
        <Button
          label={copy.access.pending}
          accessibilityLabel={`${copy.access.pending}. ${copy.access.cancel}`}
          variant="outline"
          size="sm"
          icon={ClockIcon}
          loading={busy}
          onPress={leave(false)}
          testID="profile-private-pending"
        />
      );
    case 'approved':
    case 'approved-no-keys':
    case 'renewing':
      return (
        <Button
          label={status === 'renewing' ? copy.access.renewing : copy.access.approved}
          accessibilityLabel={`${copy.access.approved} of ${name}. ${copy.access.leave}`}
          variant="outline"
          size="sm"
          icon={status === 'renewing' ? ArrowPathIcon : CheckIcon}
          loading={busy}
          onPress={leave(true)}
          testID="profile-private-approved"
        />
      );
    case 'revoked':
      return (
        <View className="flex-row items-center gap-2" testID="profile-private-revoked">
          <Text variant="subhead" tone="secondary">
            {copy.access.revoked}
          </Text>
          <Button label={copy.access.requestAgain} variant="outline" size="sm" loading={busy} onPress={request} testID="profile-private-request" />
        </View>
      );
    case 'none':
      return (
        <Button
          label={copy.access.request}
          accessibilityLabel={`${copy.access.request} to ${name}'s private posts`}
          variant="outline"
          size="sm"
          icon={LockClosedIcon}
          loading={busy}
          onPress={request}
          testID="profile-private-request"
        />
      );
    case 'self':
      return null;
  }
}

/**
 * A profile's private-feed control (web `PrivateFeedAccessButton`), under
 * the Follow button, for a signed-in viewer who follows someone with a
 * private feed: Request access, Pending (tap to cancel), Private follower
 * (tap to leave), or Removed with Ask again. Nothing when they have no
 * private feed or the viewer doesn't follow them, as on web (a private
 * post's own Request access follows first).
 */
export function PrivateFeedAccessButton({ ownerId, following, name }: { ownerId: string; following: boolean; name: string }) {
  const { data } = usePrivateAccess(ownerId, following);
  // A request or cancel still on its way shows as busy.
  const landing = useLandingIntent(accessKey(ownerId));
  if (!following || !data?.hasFeed || data.status === 'self') return null;
  return (
    <View className="mt-2 flex-row justify-end" testID="profile-private-access">
      {control(data.status, ownerId, name, landing !== undefined)}
    </View>
  );
}
