import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, RefreshControl, View } from 'react-native';
import {
  ArrowTopRightOnSquareIcon,
  DocumentDuplicateIcon,
  LockClosedIcon,
  UserCircleIcon,
  UserGroupIcon,
} from 'react-native-heroicons/outline';

import { useSession, useSessionStore } from '~/data/session';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { useAccounts } from '~/features/auth/accounts';
import { confirmSignOut } from '~/features/auth/AccountSwitcher';
import { truncateId } from '~/lib-allowlist';
import { EmptyState } from '~/ui/EmptyState';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';
import { colors, useColors } from '~/ui/tokens';

import { copy } from './copy';
import { formatCredits, formatDash, formatDate } from './format';
import { links, openInApp } from './links';
import { SettingsGroup, SettingsHeader, SettingsPage, SettingsRow, SettingsScroll } from './SettingsList';
import { useViewerProfile } from './use-viewer-profile';

const ios = Platform.OS === 'ios';

/** Signed out with nobody left: Home, signed out (AUTH-11). */
function goHome(): void {
  if (router.canDismiss()) router.dismissAll();
  router.navigate('/');
}

/** Asks first and signs the account out (the next account on this device takes over); Home when none is left. */
function signOut(account: { identityId: string; username: string | null }) {
  confirmSignOut(account)
    .then(() => {
      const { session, accounts } = useSessionStore.getState();
      if (!session && accounts.length === 0) goHome();
    })
    .catch(() => undefined);
}

/** The accounts on this device have their own screen: switch, add, sign out (AUTH-10). */
function AccountsRow({ count }: { count: number }) {
  return (
    <SettingsRow
      label={copy.account.accounts}
      value={copy.account.onDevice(count)}
      icon={UserGroupIcon}
      iconTint={colors.gray500}
      onPress={() => router.push('/settings/accounts')}
      testID="account-accounts"
    />
  );
}

/** The account (identity) id, last on the screen: shortened, and a tap copies it whole (SET-02). */
function AccountIdRow({ identityId }: { identityId: string }) {
  const copyId = () => {
    Clipboard.setStringAsync(identityId)
      .then(() => toast.success(copy.account.idCopied))
      .catch(() => undefined);
  };
  return (
    <SettingsRow
      label={copy.account.copyId}
      value={truncateId(identityId)}
      icon={DocumentDuplicateIcon}
      iconTint={colors.gray500}
      chevron={false}
      accessibilityLabel={copy.account.copyId}
      onPress={copyId}
      testID="account-copy-id"
    />
  );
}

/** Balance in DASH (4 decimals) with the raw credits in a muted caption (SET-02). */
function BalanceRow({ credits }: { credits: bigint }) {
  return (
    <View
      className="min-h-[52px] justify-center gap-0.5 px-4 py-3"
      accessible
      accessibilityLabel={`${copy.account.balance}: ${formatDash(credits)}`}
      testID="account-balance"
    >
      <Text variant="bodyStrong" tabular selectable>
        {formatDash(credits)}
      </Text>
      <Text variant="caption" tone="secondary" tabular>
        {copy.account.credits(formatCredits(credits))}
      </Text>
    </View>
  );
}

/** Reads the balance again; the new one arrives as `session.changed {reason: 'balance'}` when it moved. */
function refreshBalance({ quiet }: { quiet: boolean }): Promise<void> {
  return engine.api.session.refreshBalance().then(
    () => undefined,
    (error: unknown) => {
      appendLog('warn', 'host', `Refreshing the balance failed: ${errorMessage(error)}`);
      if (!quiet) toast.error(copy.account.refreshFailed);
    },
  );
}

/** The balance is read again when Account opens (quietly) and on pull to refresh (a failure says so). */
function useBalanceRefresh(identityId: string | null) {
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (identityId) refreshBalance({ quiet: true }).catch(() => undefined);
  }, [identityId]);
  const onRefresh = () => {
    setRefreshing(true);
    refreshBalance({ quiet: false })
      .finally(() => setRefreshing(false))
      .catch(() => undefined);
  };
  return { refreshing, onRefresh };
}

/**
 * Settings → Account (UX_SPEC §4.26; PRD SET-02, AUTH-11). Switching and
 * adding accounts is on Accounts (`/settings/accounts`, AUTH-10), and the
 * switch progress covers the whole app (`AuthGates`).
 */
export function AccountSettingsScreen() {
  const { session, accounts, status } = useSession();
  const profile = useViewerProfile();
  const transition = useAccounts((s) => s.transition);
  const c = useColors();
  const balance = useBalanceRefresh(session?.identityId ?? null);

  if (!session) {
    if (status !== 'unknown' && !transition && accounts.length > 0) {
      return (
        <SettingsScroll testID="account-signed-out-accounts">
          <SettingsHeader title={copy.sections.account} />
          <SettingsGroup footer={copy.account.parkedNote}>
            <AccountsRow count={accounts.length} />
          </SettingsGroup>
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
      </SettingsPage>
    );
  }

  const usernames = profile.data?.usernames ?? (session.username ? [session.username.replace(/\.dash$/i, '')] : []);
  const joinedAt = profile.data?.joinedAt;

  return (
    <SettingsScroll
      testID="account-settings"
      refreshControl={
        <RefreshControl
          refreshing={balance.refreshing}
          onRefresh={balance.onRefresh}
          tintColor={c.accent}
          colors={[c.accent]}
          progressBackgroundColor={c.bg}
        />
      }
    >
      <SettingsHeader title={copy.sections.account} />

      <SettingsGroup title={copy.account.usernames}>
        {usernames.length > 0 ? (
          usernames.map((name) => <SettingsRow key={name} label={`@${name}`} testID={`account-username-${name}`} />)
        ) : (
          <SettingsRow label={copy.account.noUsername} testID="account-no-username" />
        )}
        <SettingsRow
          label={usernames.length > 0 ? copy.account.registerAnother : copy.account.register}
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

      <SettingsGroup>
        <AccountsRow count={accounts.length} />
        <SettingsRow
          label={copy.account.appLock}
          icon={LockClosedIcon}
          iconTint={colors.gray500}
          onPress={() => router.push('/settings/app-lock')}
          testID="account-app-lock"
        />
      </SettingsGroup>

      <SettingsGroup>
        {joinedAt ? <SettingsRow label={copy.account.created} value={formatDate(joinedAt)} /> : null}
        <AccountIdRow identityId={session.identityId} />
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          label={copy.account.signOut}
          destructive
          chevron={false}
          onPress={() => signOut(session)}
          testID="account-sign-out"
        />
      </SettingsGroup>
    </SettingsScroll>
  );
}
