import type { PrivateFeedOverviewDTO, PrivateFollowerDTO, PrivateRequestDTO } from '@engine/api';
import { useState, type ReactNode } from 'react';
import { Pressable, RefreshControl, View } from 'react-native';
import { ArrowPathIcon, CheckCircleIcon, ExclamationTriangleIcon, LockClosedIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { readErrorMessage } from '~/data/read-error';
import { useEngineQuery } from '~/data/queries';
import { sendWrite, useLandingIntent } from '~/data/writes';
import { openUser } from '~/features/post/post-navigation';
import { SettingsGroup, SettingsHeader, SettingsPage, SettingsScroll } from '~/features/settings/SettingsList';
import { cn } from '~/lib-allowlist';
import { queryClient } from '~/state/query-client';
import { Avatar } from '~/ui/Avatar';
import { Button } from '~/ui/Button';
import { confirmAlert } from '~/ui/Dialog';
import { ErrorState } from '~/ui/EmptyState';
import { handleOf } from '~/ui/handle';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { tw, useColors, useLargeText } from '~/ui/tokens';

import { copy } from './copy';
import {
  approveWrite,
  continueMoveWrite,
  enableWrite,
  memberKey,
  OWNER_KEY,
  revokeWrite,
  usePrivateFeedOverview,
} from './private-feed-data';
import { MessagingKeyHelp } from './PrivatePostBody';
import { RenewSheet, type RenewReason } from './RenewSheet';


function Bullets({ items }: { items: readonly string[] }) {
  return (
    <View className="gap-2">
      {items.map((item) => (
        <View key={item} className="flex-row gap-2">
          <Text variant="subhead" tone="link" importantForAccessibility="no">
            •
          </Text>
          <Text variant="subhead" tone="secondary" className="flex-1">
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** A padded panel inside a settings group. */
function Panel({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View className="gap-3 px-4 py-4" testID={testID}>
      {children}
    </View>
  );
}

/** One of the stats tiles: a number, what it is and its limit. */
function Stat({ value, label, of }: { value: number; label: string; of?: number }) {
  return (
    <View className={cn('flex-1 items-center rounded-xl px-2 py-3', tw.bgMuted)} accessible accessibilityLabel={`${label}: ${value}${of !== undefined ? ` ${copy.settings.stats.of(of)}` : ''}`}>
      <Text variant="headline" tone="emphasis" tabular>
        {value.toLocaleString()}
      </Text>
      {of !== undefined ? (
        <Text variant="caption" tone="secondary">
          {copy.settings.stats.of(of)}
        </Text>
      ) : null}
      <Text variant="caption" tone="secondary">
        {label}
      </Text>
    </View>
  );
}

/** A person with the owner's actions beside them: approve a request, or remove a follower. */
function PersonRow({ person, detail, actions, testID }: { person: PrivateRequestDTO['user']; detail?: string; actions: ReactNode; testID: string }) {
  const largeText = useLargeText();
  const handle = handleOf(person);
  return (
    <View className={cn('px-4 py-3', largeText ? 'gap-2' : 'flex-row items-center gap-3')} testID={testID}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[person.displayName, handle, detail].filter(Boolean).join(', ')}
        onPress={() => openUser(person.id)}
        className="min-h-11 flex-1 flex-row items-center gap-3"
      >
        <Avatar avatar={person.avatar} identityId={person.id} size="md" />
        <View className="flex-1">
          <Text variant="bodyStrong" numberOfLines={largeText ? undefined : 1}>
            {person.displayName}
          </Text>
          <Text variant="subhead" tone="secondary" numberOfLines={1}>
            {detail ? `${handle} · ${detail}` : handle}
          </Text>
        </View>
      </Pressable>
      <View className="flex-row items-center gap-2">{actions}</View>
    </View>
  );
}

function RequestRow({ request, onHide }: { request: PrivateRequestDTO; onHide: (id: string) => void }) {
  const { user } = request;
  const busy = useLandingIntent(memberKey(user.id)) !== undefined;
  return (
    <PersonRow
      person={user}
      detail={request.renewal ? copy.settings.renewalRequest : undefined}
      testID={`private-request-${user.id}`}
      actions={
        <>
          <Button
            label={copy.settings.ignore}
            variant="ghost"
            size="sm"
            disabled={busy}
            accessibilityLabel={`${copy.settings.ignore}: ${user.displayName}`}
            onPress={() => onHide(user.id)}
            testID={`private-ignore-${user.id}`}
          />
          <Button
            label={copy.settings.approve}
            size="sm"
            loading={busy}
            accessibilityLabel={`${copy.settings.approve} ${user.displayName}`}
            onPress={() => sendWrite(approveWrite, { memberId: user.id }, copy.settings.approved(handleOf(user)))}
            testID={`private-approve-${user.id}`}
          />
        </>
      }
    />
  );
}

function FollowerRow({ follower }: { follower: PrivateFollowerDTO }) {
  const { user } = follower;
  const busy = useLandingIntent(memberKey(user.id)) !== undefined;
  const remove = async () => {
    const name = handleOf(user);
    const confirmed = await confirmAlert({
      title: copy.settings.removeTitle(name),
      message: copy.settings.removeBody,
      confirmText: copy.settings.remove,
      destructive: true,
    });
    if (confirmed) sendWrite(revokeWrite, { memberId: user.id }, copy.settings.removed(name));
  };
  return (
    <PersonRow
      person={user}
      testID={`private-follower-${user.id}`}
      actions={
        <Button
          label={copy.settings.remove}
          variant="outline"
          size="sm"
          loading={busy}
          accessibilityLabel={`${copy.settings.remove} ${user.displayName}`}
          onPress={() => {
            remove().catch(() => undefined);
          }}
          testID={`private-remove-${user.id}`}
        />
      }
    />
  );
}

function HowItWorks() {
  return (
    <SettingsGroup title={copy.settings.howItWorksTitle} testID="private-how-it-works">
      <Panel>
        <Bullets items={copy.settings.howItWorks} />
      </Panel>
    </SettingsGroup>
  );
}

/** The feed is off: what it is, and turning it on with the wallet's messaging key. */
function TurnOn({ overview }: { overview: Extract<PrivateFeedOverviewDTO, { enabled: false }> }) {
  const busy = useLandingIntent(OWNER_KEY) !== undefined;
  const ready = overview.messagingKey === 'ready';
  return (
    <>
      <SettingsGroup>
        <Panel testID="private-feed-off">
          <Text variant="body">{copy.settings.intro}</Text>
          <Bullets items={copy.settings.benefits(overview.capacity)} />
          {ready ? (
            <Text variant="subhead" tone="secondary">
              {copy.settings.walletKey}
            </Text>
          ) : (
            <MessagingKeyHelp messagingKey={overview.messagingKey} />
          )}
          <Button
            label={busy ? copy.settings.enabling : copy.settings.enable}
            size="block"
            icon={LockClosedIcon}
            loading={busy}
            disabled={!ready}
            onPress={() => sendWrite(enableWrite, {}, copy.settings.enabled)}
            testID="private-enable"
          />
        </Panel>
      </SettingsGroup>
      <HowItWorks />
    </>
  );
}

function Notice({ tone, title, body, action, testID }: { tone: 'warning' | 'info'; title: string; body: string; action?: ReactNode; testID?: string }) {
  const c = useColors();
  return (
    <View
      className={cn('mx-4 mt-6 gap-2 rounded-xl p-4', tone === 'warning' ? tw.offlineBg : 'bg-yappr-50 dark:bg-yappr-950/30')}
      testID={testID}
    >
      <View className="flex-row items-center gap-2">
        {tone === 'warning' ? <ExclamationTriangleIcon size={18} color={c.warning} /> : <ArrowPathIcon size={18} color={c.accent} />}
        <Text variant="subheadStrong" tone="emphasis" className="flex-1">
          {title}
        </Text>
      </View>
      <Text variant="subhead" tone="secondary">
        {body}
      </Text>
      {action}
    </View>
  );
}

/** A settings group listing what a read found: its error, a spinner while it loads, its empty line, or its rows. */
function ListGroup<T>({
  title,
  testID,
  read,
  items,
  empty,
  renderItem,
}: {
  title: string;
  testID: string;
  read: { isError: boolean; error: Error | null; refetch: () => Promise<unknown> };
  /** undefined while the read loads. */
  items: readonly T[] | undefined;
  empty: string;
  renderItem: (item: T) => ReactNode;
}) {
  let content: ReactNode;
  if (read.isError) {
    content = <ErrorState message={readErrorMessage(read.error)} onRetry={() => read.refetch()} />;
  } else if (items === undefined) {
    content = (
      <Panel>
        <Spinner />
      </Panel>
    );
  } else if (items.length === 0) {
    content = (
      <Panel>
        <Text variant="subhead" tone="secondary">
          {empty}
        </Text>
      </Panel>
    );
  } else {
    content = items.map(renderItem);
  }
  return (
    <SettingsGroup title={title} testID={testID}>
      {content}
    </SettingsGroup>
  );
}

/** The feed is on: its state, requests, followers and renewing. */
function Manage({ overview }: { overview: Extract<PrivateFeedOverviewDTO, { enabled: true }> }) {
  const c = useColors();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [renewOpen, setRenewOpen] = useState(false);
  const ownerBusy = useLandingIntent(OWNER_KEY) !== undefined;
  const requests = useEngineQuery(queryKeys.privateFeed.requests, (api) => api.privateFeed.requests());
  const followers = useEngineQuery(queryKeys.privateFeed.followers, (api) => api.privateFeed.followers());
  const shownRequests = requests.data?.filter((request) => !hidden.has(request.user.id));
  const { move } = overview;
  let renewReason: RenewReason = 'choice';
  if (overview.keyRotated) renewReason = 'key-changed';
  else if (overview.nearlyFull) renewReason = 'full';

  // One notice at most: a follower move to finish comes first, then a reason to renew.
  let notice: ReactNode = null;
  if (move) {
    notice = (
      <Notice
        tone={move.error ? 'warning' : 'info'}
        title={copy.settings.moveTitle(move.done, move.total)}
        body={move.error ?? copy.settings.moveBody}
        testID="private-move"
        action={
          move.error || move.done >= move.total ? (
            <Button
              label={copy.settings.continueMove}
              variant="outline"
              size="sm"
              loading={ownerBusy}
              layoutStyle={{ alignSelf: 'flex-start' }}
              onPress={() => sendWrite(continueMoveWrite, {})}
              testID="private-continue-move"
            />
          ) : null
        }
      />
    );
  } else if (renewReason !== 'choice') {
    const keyChanged = renewReason === 'key-changed';
    notice = (
      <Notice
        tone="warning"
        title={keyChanged ? copy.settings.keyChangedTitle : copy.settings.nearlyFullTitle}
        body={keyChanged ? copy.settings.keyChangedBody : copy.settings.nearlyFullBody}
        testID="private-renew-prompt"
        action={
          <Button
            label={copy.settings.renew}
            size="sm"
            disabled={ownerBusy}
            layoutStyle={{ alignSelf: 'flex-start' }}
            onPress={() => setRenewOpen(true)}
          />
        }
      />
    );
  }

  return (
    <>
      <SettingsGroup>
        <Panel testID="private-feed-on">
          <View className="flex-row items-center gap-2">
            <CheckCircleIcon size={20} color={c.repost} />
            <Text variant="bodyStrong" tone="emphasis" className="flex-1">
              {copy.settings.enabledTitle}
            </Text>
          </View>
          <Text variant="subhead" tone="secondary">
            {copy.settings.enabledBody} {copy.settings.since(overview.since.toLocaleDateString())}
          </Text>
          {overview.messagingKey === 'ready' ? null : <MessagingKeyHelp messagingKey={overview.messagingKey} />}
          <View className="flex-row gap-2" testID="private-stats">
            <Stat value={overview.followers} of={overview.capacity} label={copy.settings.stats.followers} />
            <Stat value={overview.removals} of={overview.maxRemovals} label={copy.settings.stats.removals} />
            <Stat value={overview.capacity - overview.followers} label={copy.settings.stats.available} />
          </View>
        </Panel>
      </SettingsGroup>

      {notice}

      <ListGroup
        title={copy.settings.requestsTitle}
        testID="private-requests"
        read={requests}
        items={shownRequests}
        empty={copy.settings.requestsEmpty}
        renderItem={(request) => (
          <RequestRow
            key={request.user.id}
            request={request}
            onHide={(id) => setHidden((current) => new Set([...current, id]))}
          />
        )}
      />

      <ListGroup
        title={copy.settings.followersTitle}
        testID="private-followers"
        read={followers}
        items={followers.data}
        empty={copy.settings.followersEmpty}
        renderItem={(follower) => <FollowerRow key={follower.user.id} follower={follower} />}
      />

      <SettingsGroup title={copy.settings.renewTitle}>
        <Panel>
          <Text variant="subhead" tone="secondary">
            {copy.settings.renewBody}
          </Text>
          <Button
            label={ownerBusy ? copy.settings.renewing : copy.settings.renew}
            variant="outline"
            size="block"
            loading={ownerBusy}
            disabled={move !== null}
            onPress={() => setRenewOpen(true)}
            testID="private-renew"
          />
        </Panel>
      </SettingsGroup>

      <HowItWorks />
      <RenewSheet open={renewOpen} onClose={() => setRenewOpen(false)} reason={renewReason} />
    </>
  );
}

/**
 * Settings → Private feed (web `settings?section=privateFeed`): turn the
 * private feed on with the messaging key from the wallet, approve or set
 * aside requests, remove private followers, renew the feed, and what it all
 * means ("How it works", with the moderators and images caveats).
 */
export function PrivateFeedScreen() {
  const overview = usePrivateFeedOverview();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshing(true);
    queryClient
      .refetchQueries({ queryKey: queryKeys.privateFeed.owner })
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  };
  const header = <SettingsHeader title={copy.settings.title} />;

  if (overview.data === undefined) {
    return (
      <SettingsPage testID="private-feed-screen">
        {header}
        {overview.isError ? (
          <ErrorState
            title={copy.settings.loadFailed}
            message={readErrorMessage(overview.error)}
            onRetry={() => overview.refetch()}
            retrying={overview.isRetrying}
            testID="private-feed-error"
          />
        ) : (
          <View className="flex-1 items-center justify-center">
            <Spinner />
          </View>
        )}
      </SettingsPage>
    );
  }

  return (
    <SettingsScroll
      testID="private-feed-screen"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
    >
      {header}
      {overview.data.enabled ? <Manage overview={overview.data} /> : <TurnOn overview={overview.data} />}
    </SettingsScroll>
  );
}
