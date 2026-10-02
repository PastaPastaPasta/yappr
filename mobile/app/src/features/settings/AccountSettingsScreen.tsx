import type { AccountDTO } from '@engine/api';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Platform, Pressable, View } from 'react-native';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  DocumentDuplicateIcon,
  LockClosedIcon,
  PlusIcon,
  UserCircleIcon,
} from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useSession } from '~/data/session';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { cn } from '~/lib-allowlist';
import { showActionSheet } from '~/ui/action-sheet';
import { Avatar } from '~/ui/Avatar';
import { confirmAlert } from '~/ui/Dialog';
import { EmptyState } from '~/ui/EmptyState';
import { IconButton } from '~/ui/IconButton';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';
import { colors, monoFont, tw, useColors } from '~/ui/tokens';

import { accountName, addAccount, signOutAccount, switchAccount, useAccountTransition } from './accounts';
import { copy } from './copy';
import { formatCredits, formatDash, formatDate } from './format';
import { links, openInApp } from './links';
import { SettingsGroup, SettingsHeader, SettingsPage, SettingsRow, SettingsScroll } from './SettingsList';
import { useViewerProfile } from './use-viewer-profile';

const ios = Platform.OS === 'ios';

function confirmSignOut(account: { identityId: string; username: string | null }) {
  const name = accountName(account);
  confirmAlert({
    title: copy.account.signOutTitle(name),
    message: copy.account.signOutMessage,
    confirmText: copy.account.signOut,
    destructive: true,
  })
    .then((confirmed) => (confirmed ? signOutAccount(account.identityId) : false))
    .catch(() => undefined);
}

/** The identity id, monospace on two lines, with a copy button (SET-02). */
function IdentityRow({ identityId }: { identityId: string }) {
  const copyId = () => {
    Clipboard.setStringAsync(identityId)
      .then(() => toast.success(copy.account.idCopied))
      .catch(() => undefined);
  };
  return (
    <View className="min-h-[52px] flex-row items-center gap-3 py-3 pl-4 pr-2">
      <Text
        variant="subhead"
        selectable
        numberOfLines={2}
        style={monoFont}
        className="flex-1"
        accessibilityLabel={`${copy.account.id}: ${identityId}`}
        testID="account-identity-id"
      >
        {identityId}
      </Text>
      <IconButton
        icon={DocumentDuplicateIcon}
        accessibilityLabel={copy.account.copyId}
        onPress={copyId}
        testID="account-copy-id"
      />
    </View>
  );
}

/** Balance in DASH (8 decimals) with the raw credits, and a refresh button (SET-02). */
function BalanceRow({ credits }: { credits: bigint }) {
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshing(true);
    // The new balance arrives as `session.changed {reason: 'balance'}` when it moved.
    engine.api.session
      .refreshBalance()
      .catch((error: unknown) => {
        appendLog('warn', 'host', `Refreshing the balance failed: ${errorMessage(error)}`);
        toast.error(copy.account.refreshFailed);
      })
      .finally(() => setRefreshing(false));
  };
  return (
    <View className="min-h-[52px] flex-row items-center gap-3 py-3 pl-4 pr-2" testID="account-balance">
      <View className="flex-1 gap-0.5" accessible accessibilityLabel={`${copy.account.balance}: ${formatDash(credits)}`}>
        <Text variant="bodyStrong" tabular selectable>
          {formatDash(credits)}
        </Text>
        <Text variant="caption" tone="secondary" tabular>
          {copy.account.credits(formatCredits(credits))}
        </Text>
      </View>
      {refreshing ? (
        <View className="h-9 w-9 items-center justify-center">
          <Spinner size="sm" testID="account-balance-refreshing" />
        </View>
      ) : (
        <IconButton icon={ArrowPathIcon} accessibilityLabel={copy.account.refresh} onPress={refresh} testID="account-refresh" />
      )}
    </View>
  );
}

/** One account on this device: avatar, name, handle; a check on the current one (AUTH-10). */
function AccountRow({ account }: { account: AccountDTO }) {
  const c = useColors();
  const { identityId } = account;
  const profile = useEngineQuery(queryKeys.profile.detail(identityId), (api) => api.profiles.get(identityId), {
    persist: true,
  });
  const handle = accountName(account);
  const name = profile.data?.displayName ?? handle;
  const open = () =>
    showActionSheet({
      title: handle,
      actions: [
        ...(account.active
          ? []
          : [
              {
                label: copy.account.switchTo(handle),
                onPress: () => {
                  switchAccount(account).catch(() => undefined);
                },
              },
            ]),
        { label: copy.account.signOutOf(handle), destructive: true, onPress: () => confirmSignOut(account) },
      ],
    });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={account.active ? `${name}, ${handle}, ${copy.account.current}` : `${name}, ${handle}`}
      accessibilityState={{ selected: account.active }}
      onPress={open}
      testID={`account-row-${identityId}`}
      className={cn('min-h-14 flex-row items-center gap-3 px-4 py-2', tw.pressed)}
    >
      <Avatar avatar={profile.data?.avatar} identityId={identityId} size="md" />
      <View className="flex-1 gap-0.5">
        <Text variant="bodyStrong" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="subhead" tone="secondary" numberOfLines={1}>
          {handle}
        </Text>
      </View>
      {account.active ? <CheckIcon size={20} color={c.accent} strokeWidth={2.5} /> : null}
    </Pressable>
  );
}

/**
 * The accounts on this device, the current one first, with Add account
 * (AUTH-10). Signed out (an add backed out of sign-in, say) it lists the
 * parked accounts, so a tap switches back to one.
 */
function AccountsGroup({ accounts, footer, children }: { accounts: AccountDTO[]; footer?: string; children?: ReactNode }) {
  // The engine lists every account with the active one marked; keep the active one first.
  const listed = [...accounts].sort((a, b) => Number(b.active) - Number(a.active));
  return (
    <SettingsGroup title={copy.account.accounts} footer={footer} testID="account-accounts">
      {listed.map((account) => (
        <AccountRow key={account.identityId} account={account} />
      ))}
      <SettingsRow
        label={copy.account.addAccount}
        icon={PlusIcon}
        iconTint={colors.yappr500}
        link
        chevron={false}
        onPress={() => {
          addAccount().catch(() => undefined);
        }}
        testID="account-add"
      />
      {children}
    </SettingsGroup>
  );
}

/** While a switch, add or sign-out runs, the screen shows only that. */
function TransitionCover({ label }: { label: string }) {
  return (
    <View
      className={cn('absolute inset-0 items-center justify-center gap-4 px-8', tw.bg)}
      accessibilityLiveRegion="polite"
      testID="account-transition"
    >
      <Spinner />
      <Text variant="body" tone="secondary" className="text-center">
        {label}
      </Text>
    </View>
  );
}

/** Settings → Account (UX_SPEC §4.26; PRD SET-02, AUTH-10, AUTH-11). */
export function AccountSettingsScreen() {
  const { session, accounts, status } = useSession();
  const profile = useViewerProfile();
  const transition = useAccountTransition((s) => s.transition);

  if (!session) {
    if (status !== 'unknown' && !transition && accounts.length > 0) {
      return (
        <SettingsScroll testID="account-signed-out-accounts">
          <SettingsHeader title={copy.sections.account} />
          <AccountsGroup accounts={accounts} footer={copy.account.parkedNote} />
        </SettingsScroll>
      );
    }
    return (
      <SettingsPage>
        <SettingsHeader title={copy.sections.account} />
        {status === 'unknown' || transition ? (
          <View className="flex-1 items-center justify-center">
            <Spinner />
          </View>
        ) : (
          <EmptyState
            icon={UserCircleIcon}
            title={copy.account.signInFirst}
            action={{ label: copy.signedOut.title, onPress: () => router.push('/sign-in') }}
            testID="account-signed-out"
          />
        )}
        {transition ? <TransitionCover label={transition.label} /> : null}
      </SettingsPage>
    );
  }

  const usernames = profile.data?.usernames ?? (session.username ? [session.username.replace(/\.dash$/i, '')] : []);
  const joinedAt = profile.data?.joinedAt;

  return (
    <View className="flex-1">
      <SettingsScroll testID="account-settings">
        <SettingsHeader title={copy.sections.account} />

        <SettingsGroup title={copy.account.id}>
          <IdentityRow identityId={session.identityId} />
          {joinedAt ? <SettingsRow label={copy.account.created} value={formatDate(joinedAt)} /> : null}
        </SettingsGroup>

        <SettingsGroup title={copy.account.usernames}>
          {usernames.length > 0 ? (
            usernames.map((name) => <SettingsRow key={name} label={`@${name}`} testID={`account-username-${name}`} />)
          ) : (
            <SettingsRow label={copy.account.noUsername} testID="account-no-username" />
          )}
          <SettingsRow
            label={copy.account.register}
            link
            chevron={false}
            accessibilityRole="link"
            onPress={() => openInApp(links.registerUsername)}
            trailing={<ArrowTopRightOnSquareIcon size={16} color={ios ? colors.gray400 : colors.gray500} />}
            testID="account-register"
          />
        </SettingsGroup>

        <SettingsGroup title={copy.account.balance}>
          <BalanceRow credits={session.credits} />
        </SettingsGroup>

        <AccountsGroup accounts={accounts}>
          <SettingsRow
            label={copy.account.appLock}
            icon={LockClosedIcon}
            iconTint={colors.gray500}
            onPress={() => router.push('/settings/app-lock')}
            testID="account-app-lock"
          />
        </AccountsGroup>

        <SettingsGroup>
          <SettingsRow
            label={copy.account.signOut}
            destructive
            chevron={false}
            onPress={() => confirmSignOut(session)}
            testID="account-sign-out"
          />
        </SettingsGroup>
      </SettingsScroll>
      {transition ? <TransitionCover label={transition.label} /> : null}
    </View>
  );
}
