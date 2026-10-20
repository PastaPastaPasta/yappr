import type { DmUnlockResult } from '@engine/api';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useCallback, useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Keyboard, View } from 'react-native';

import { useSessionStore } from '~/data/session';
import { errorCode } from '~/data/writes';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { addAccount } from '~/features/auth/accounts';
import { confirmSignOut } from '~/features/auth/AccountSwitcher';
import { copy as authCopy } from '~/features/auth/copy';
import { cn } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { useBlockScreenCapture } from '~/ui/screen-capture';
import { Sheet } from '~/ui/Sheet';
import { useNativeText } from '~/ui/native-text';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';
import { tw, useColors } from '~/ui/tokens';

import { readErrorMessage, refreshDm } from './dm-data';
import { MessagingSetup } from './MessagingSetup';

type Phase = 'recovering' | 'manual' | 'no-key' | 'setup' | 'wallet';

/** Where an unlock that did not unlock goes next. */
function phaseFor(reason: Extract<DmUnlockResult, { unlocked: false }>['reason']): Phase {
  switch (reason) {
    case 'needs-setup':
      return 'setup';
    case 'no-key-on-identity':
      return 'no-key';
    case 'allow-in-wallet':
      return 'wallet';
    default:
      return 'manual';
  }
}

/**
 * "Unlock messages" (UX_SPEC §4.38, PRD DM-02): first the automatic recovery
 * (the encryption key derived from the sign-in key), which on success closes
 * with "Messages unlocked"; if that can't work, one secure field for the
 * encryption key, checked against the identity. The key's formats are named
 * only in the error for text that is not one (#22). An account with no
 * messaging key yet (App Connect builds) sets one up with its wallet instead.
 */
/** Unlocked: the inbox, read again, with "Messages unlocked". */
function unlocked(close: () => void): void {
  toast.success('Messages unlocked');
  refreshDm();
  close();
}

/**
 * No messaging key this sign-in can unlock or set up (D38): messages come
 * from a wallet sign-in, which brings the account's messaging key. The
 * account is already signed in here, so it signs out first (asked), then
 * signs back in with its wallet.
 */
const NO_KEY_BODY = 'Messages are set up with your Dash wallet. To use them on this phone, sign out, then sign back in with your wallet.';
const NO_KEY_ACTION = 'Sign out and use my wallet';

function signOutForWallet(): void {
  const session = useSessionStore.getState().session;
  if (!session) return;
  confirmSignOut(session)
    .then(() => {
      const now = useSessionStore.getState().session;
      // Kept signed in (cancelled): nothing to do.
      if (now?.identityId === session.identityId) return undefined;
      // Signed out: the wallet sign-in, beside the account that took over if there is one.
      if (now) return addAccount();
      router.push('/sign-in');
      return undefined;
    })
    .catch((e: unknown) => appendLog('warn', 'host', `Sign-out for wallet messaging failed: ${errorMessage(e)}`));
}

/** WIF (51 or 52 base58 characters) or 64 hex: the formats an encryption key comes in (engine `dm.unlock`). */
const KEY_SHAPE = /^([1-9A-HJ-NP-Za-km-z]{51,52}|[0-9a-fA-F]{64})$/;

/**
 * Why a key was not taken: text that is not a key at all gets the formats;
 * a key that is one but not the one messages use says so, whichever way it
 * is not (another account's, another of this account's keys, another
 * network's).
 */
export function keyError(value: string): string {
  return KEY_SHAPE.test(value.trim())
    ? "That isn't the encryption key for this account's messages."
    : "That doesn't look like an encryption key. It's a WIF or 64-character hex key from yap.pr.";
}

export function UnlockSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [saving, setSaving] = useState(false);
  // Scrolls while open: the setup step's QR code can outgrow the screen. Closed, it holds nothing.
  return (
    <Sheet open={open} onClose={onClose} dismissible={!saving} scrollable={open} testID="dm-unlock-sheet">
      {/* Mounted per opening, so every opening starts with the automatic recovery. */}
      {open ? <UnlockBody onClose={onClose} saving={saving} setSaving={setSaving} /> : null}
    </Sheet>
  );
}

function UnlockBody({
  onClose,
  saving,
  setSaving,
}: {
  onClose: () => void;
  saving: boolean;
  setSaving: (saving: boolean) => void;
}) {
  const c = useColors();
  const [phase, setPhase] = useState<Phase>('recovering');
  const [key, setKey] = useState('');
  useBlockScreenCapture('secret');
  const [error, setError] = useState<string | null>(null);
  // Uncontrolled (`useNativeText`), so a long pasted or typed key keeps every character.
  const { key: inputKey, attach, inputProps } = useNativeText({
    value: key,
    onChangeText: (text) => {
      setKey(text);
      setError(null);
    },
  });

  useEffect(() => {
    let current = true;
    engine.api.dm
      .unlock({})
      .then((result) => {
        if (!current) return;
        if (result.unlocked) {
          unlocked(onClose);
        } else {
          setPhase(phaseFor(result.reason));
        }
      })
      .catch((e: unknown) => {
        appendLog('info', 'host', `Automatic key recovery failed: ${errorMessage(e)}`);
        if (current) setPhase('manual');
      });
    return () => {
      current = false;
    };
  }, [onClose]);

  const save = () => {
    const value = key.trim();
    if (!value || saving) return;
    setSaving(true);
    setError(null);
    engine.api.dm
      .unlock({ key: value })
      .then((result) => {
        if (result.unlocked) {
          setKey('');
          Keyboard.dismiss();
          unlocked(onClose);
        } else if (result.reason === 'not-derivable') {
          setError(keyError(value));
        } else {
          setPhase(phaseFor(result.reason));
        }
      })
      .catch((e: unknown) => {
        setError(errorCode(e) === 'KEY_INVALID' ? keyError(value) : (readErrorMessage(e) ?? keyError(value)));
      })
      .finally(() => setSaving(false));
  };

  // Stable, so MessagingSetup's checks keep their schedule across renders.
  const setUp = useCallback(() => unlocked(onClose), [onClose]);
  const locked = useCallback((reason: Parameters<typeof phaseFor>[0]) => setPhase(phaseFor(reason)), []);

  let title = 'Unlock your messages';
  if (phase === 'recovering') title = 'Unlocking your messages…';
  else if (phase === 'setup') title = 'Set up messaging';
  else if (phase === 'wallet') title = authCopy.renew.allowMessagingTitle;

  return (
    <View className="gap-2">
      <Text variant="headline" tone="emphasis" accessibilityRole="header">
        {title}
      </Text>
      {phase === 'recovering' ? (
        <View className="items-center py-4" testID="dm-unlock-recovering">
          <Spinner size="sm" />
        </View>
      ) : null}
      {phase === 'setup' ? <MessagingSetup onUnlocked={setUp} onLocked={locked} /> : null}
      {phase === 'wallet' ? (
        <View className="gap-4 pb-2" testID="dm-unlock-wallet">
          <Text variant="body" tone="secondary">
            {authCopy.renew.allowMessagingBody}
          </Text>
          <Button
            label={authCopy.wallet.renew}
            size="block"
            onPress={() => {
              onClose();
              router.push('/sign-in/renew');
            }}
            testID="dm-unlock-renew"
          />
        </View>
      ) : null}
      {phase === 'no-key' ? (
        <View className="gap-4 pb-2" testID="dm-unlock-no-key">
          <Text variant="body" tone="secondary">
            {NO_KEY_BODY}
          </Text>
          <Button
            label={NO_KEY_ACTION}
            variant="outline"
            size="block"
            onPress={() => {
              onClose();
              signOutForWallet();
            }}
            testID="dm-unlock-wallet-sign-in"
          />
        </View>
      ) : null}
      {phase === 'manual' ? (
        <View className="gap-3 pb-2">
          <Text variant="body" tone="secondary">
            Your messages are encrypted. Paste your encryption key to read and send them on this device.
          </Text>
          <View
            className={cn(
              'rounded-lg border px-3',
              tw.bg,
              error ? 'border-red-600 dark:border-red-400' : tw.borderStrong,
            )}
          >
            <BottomSheetTextInput
              key={inputKey}
              ref={attach}
              {...inputProps}
              placeholder="Paste your encryption key"
              placeholderTextColor={c.textPlaceholder}
              accessibilityLabel="Encryption key"
              accessibilityHint={error ?? undefined}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              importantForAutofill="no"
              onSubmitEditing={save}
              returnKeyType="done"
              style={{ fontSize: 16, minHeight: 44, color: c.textPrimary }}
              testID="dm-unlock-key"
            />
          </View>
          {error ? (
            <Text variant="caption" tone="error" accessibilityLiveRegion="polite" testID="dm-unlock-error">
              {error}
            </Text>
          ) : null}
          <Button
            label="Unlock"
            size="block"
            loading={saving}
            disabled={!key.trim()}
            onPress={save}
            testID="dm-unlock-save"
          />
        </View>
      ) : null}
    </View>
  );
}
