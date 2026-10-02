import type { AccountDTO } from '@engine/api';
import { router } from 'expo-router';
import { Pressable, View } from 'react-native';
import { EllipsisHorizontalIcon, PlusIcon } from 'react-native-heroicons/outline';
import { create } from 'zustand';

import { useSession } from '~/data/session';
import { isSessionExpired } from '~/data/session-expiry';
import { cn } from '~/lib-allowlist';
import { showActionSheet } from '~/ui/action-sheet';
import { confirmAlert } from '~/ui/Dialog';
import { IconButton } from '~/ui/IconButton';
import { Sheet } from '~/ui/Sheet';
import { Text } from '~/ui/Text';
import { tw, useColors } from '~/ui/tokens';

import { AccountRow } from './AccountRow';
import { accountName, addAccount, reauthenticate, signOutAccount, switchAccount } from './accounts';
import { copy } from './copy';

/** Asks first (AUTH-11), then signs the account out and deletes its keys from this device. */
export async function confirmSignOut(account: { identityId: string; username: string | null }): Promise<void> {
  const ok = await confirmAlert({
    title: copy.signout.title(accountName(account)),
    message: copy.signout.body,
    confirmText: copy.signout.confirm,
    destructive: true,
  });
  if (ok) await signOutAccount(account.identityId);
}

function AddAccountRow({ onPress }: { onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copy.accounts.add}
      onPress={onPress}
      testID="accounts-add"
      className={cn('min-h-14 flex-row items-center gap-3 px-4 py-3', tw.pressed)}
    >
      <View className={cn('h-12 w-12 items-center justify-center rounded-full border border-dashed', tw.borderStrong)}>
        <PlusIcon size={22} color={c.accent} />
      </View>
      <Text variant="bodyStrong" tone="link">
        {copy.accounts.add}
      </Text>
    </Pressable>
  );
}

/**
 * The accounts on this device with "Add account" (AUTH-10). Tapping an
 * account switches to it, or for one marked "Sign in again" (AUTH-14) opens
 * its sign-in. With `manage`, each row has a menu to sign it out.
 */
export function AccountList({
  accounts,
  onDone,
  manage = false,
}: {
  accounts: AccountDTO[];
  /** Called before a switch or an add starts (the sheet closes). */
  onDone?: () => void;
  manage?: boolean;
}) {
  return (
    <View>
      {accounts.map((account) => (
        <AccountRow
          key={account.identityId}
          account={account}
          testID={`account-${account.identityId}`}
          onPress={() => {
            onDone?.();
            if (isSessionExpired(account.identityId)) reauthenticate(account.identityId).catch(() => undefined);
            else if (!account.active) switchAccount(account).catch(() => undefined);
          }}
          trailing={
            manage ? (
              <IconButton
                icon={EllipsisHorizontalIcon}
                accessibilityLabel={`More for ${accountName(account)}`}
                testID={`account-menu-${account.identityId}`}
                onPress={() =>
                  showActionSheet({
                    title: accountName(account),
                    actions: [
                      {
                        label: copy.accounts.signOut,
                        destructive: true,
                        onPress: () => {
                          confirmSignOut(account).catch(() => undefined);
                        },
                      },
                    ],
                  })
                }
              />
            ) : undefined
          }
        />
      ))}
      <View className={cn(accounts.length > 0 && 'border-t', tw.border)}>
        <AddAccountRow
          onPress={() => {
            onDone?.();
            addAccount().catch(() => undefined);
          }}
        />
      </View>
    </View>
  );
}

export const useAccountSwitcher = create<{ open: boolean }>()(() => ({ open: false }));

/**
 * Long-press on the Profile tab (AUTH-10): the account switcher sheet, or
 * the sign-in flow when nobody has signed in on this device.
 */
export function openAccountSwitcher(): void {
  useAccountSwitcher.setState({ open: true });
}

/** The switcher sheet; mounted once by `AuthGates`. */
export function AccountSwitcherSheet() {
  const open = useAccountSwitcher((s) => s.open);
  const { accounts } = useSession();
  const close = () => useAccountSwitcher.setState({ open: false });
  return (
    <Sheet open={open} onClose={close} title={copy.accounts.title} testID="account-switcher">
      <View className="-mx-5">
        <AccountList accounts={accounts} onDone={close} />
      </View>
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          close();
          router.push('/settings/accounts');
        }}
        className="min-h-11 items-center justify-center"
        testID="account-switcher-manage"
      >
        <Text variant="subhead" tone="link">
          Manage accounts
        </Text>
      </Pressable>
    </Sheet>
  );
}
