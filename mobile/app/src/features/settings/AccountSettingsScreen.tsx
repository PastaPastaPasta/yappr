import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useState } from 'react';
import { Platform, View } from 'react-native';
import {
  ArrowPathIcon,
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
import { EmptyState } from '~/ui/EmptyState';
import { IconButton } from '~/ui/IconButton';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';
import { colors, monoFont } from '~/ui/tokens';

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

/**
 * Settings → Account (UX_SPEC §4.26; PRD SET-02, AUTH-11). Switching and
 * adding accounts is on Accounts (`/settings/accounts`, AUTH-10), and the
 * switch progress covers the whole app (`AuthGates`).
 */
export function AccountSettingsScreen() {
  const { session, accounts, status } = useSession();
  const profile = useViewerProfile();
  const transition = useAccounts((s) => s.transition);

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
