import type { WalletConnectionDTO } from '@engine/api';
import { router } from 'expo-router';
import { View } from 'react-native';
import { ArrowPathIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useSession, useSessionStore } from '~/data/session';
import { confirmSignOut } from '~/features/auth/AccountSwitcher';
import { copy as authCopy } from '~/features/auth/copy';
import { Tag } from '~/ui/Badge';
import { Button } from '~/ui/Button';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { colors } from '~/ui/tokens';

import { formatDash, formatDate } from './format';
import { SettingsGroup, SettingsHeader, SettingsPage, SettingsRow, SettingsScroll } from './SettingsList';

const copy = authCopy.wallet;

/** "0.42 of 0.5 DASH left · Until January 9, 2027". */
function limitsLine(row: WalletConnectionDTO): string {
  const allowance = row.totalBudget === undefined
    ? copy.noLimit
    : row.remaining !== undefined
      ? copy.left(formatDash(row.remaining).replace(/ DASH$/, ''), formatDash(row.totalBudget))
      : copy.upTo(formatDash(row.totalBudget));
  return row.expiresAt === undefined ? allowance : `${allowance} · ${copy.until(formatDate(new Date(row.expiresAt)))}`;
}

function ConnectionRow({ row }: { row: WalletConnectionDTO }) {
  return (
    <View className="gap-1 px-4 py-3" testID={`wallet-connection-${row.keyId}`}>
      <View className="flex-row items-center justify-between gap-2">
        <Text variant="bodyStrong" className="flex-1">
          {copy.scope[row.scope]}
        </Text>
        {row.thisDevice ? <Tag label={copy.thisPhone} /> : null}
      </View>
      <Text variant="subhead" tone="secondary" tabular>
        {limitsLine(row)}
      </Text>
    </View>
  );
}

/**
 * Settings → Account → Wallet connection (App Connect builds, an account
 * signed in with a wallet; web's "Wallet connections"): what the account's
 * wallets let Yappr do, read from chain, with this phone's keys marked;
 * renewing, and disconnecting this phone (sign-out). Yappr cannot revoke its
 * own access: that happens in the wallet.
 */
export function WalletConnectionScreen() {
  const { session } = useSession();
  const identityId = session?.identityId ?? '';
  const connections = useEngineQuery(
    queryKeys.walletConnections(identityId),
    (api) => api.session.appConnectConnections(),
    { enabled: identityId !== '' },
  );

  if (!session) {
    return (
      <SettingsPage>
        <SettingsHeader title={copy.title} />
      </SettingsPage>
    );
  }

  let rows;
  if (connections.isError) {
    rows = (
      <View className="items-start gap-3 px-4 py-3">
        <Text variant="subhead" tone="secondary">
          {copy.loadFailed}
        </Text>
        <Button label={copy.tryAgain} variant="outline" size="sm" onPress={() => connections.refetch()} />
      </View>
    );
  } else if (!connections.data) {
    rows = (
      <View className="items-center py-4">
        <Spinner />
      </View>
    );
  } else if (connections.data.length === 0) {
    rows = <SettingsRow label={copy.none} />;
  } else {
    rows = connections.data.map((row) => <ConnectionRow key={row.keyId} row={row} />);
  }

  return (
    <SettingsScroll testID="wallet-connection">
      <SettingsHeader title={copy.title} />
      <SettingsGroup footer={copy.intro}>{rows}</SettingsGroup>
      <SettingsGroup>
        <SettingsRow
          label={copy.renew}
          icon={ArrowPathIcon}
          iconTint={colors.yappr500}
          onPress={() => router.push('/sign-in/renew')}
          testID="wallet-renew"
        />
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow
          label={copy.disconnect}
          destructive
          chevron={false}
          onPress={() => {
            confirmSignOut(session)
              .then(() => {
                if (!useSessionStore.getState().session) router.navigate('/');
              })
              .catch(() => undefined);
          }}
          testID="wallet-disconnect"
        />
      </SettingsGroup>
    </SettingsScroll>
  );
}
