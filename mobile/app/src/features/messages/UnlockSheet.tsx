import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useEffect, useState } from 'react';
import { Keyboard, View } from 'react-native';

import { config } from '~/config';
import { errorCode } from '~/data/writes';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { openExternal } from '~/features/post/post-navigation';
import { cn } from '~/lib-allowlist';
import { Button } from '~/ui/Button';
import { useBlockScreenCapture } from '~/ui/screen-capture';
import { Sheet } from '~/ui/Sheet';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';
import { tw, useColors } from '~/ui/tokens';

import { readErrorMessage, refreshDm } from './dm-data';

type Phase = 'recovering' | 'manual' | 'no-key';

/**
 * "Unlock messages" (UX_SPEC §4.38, PRD DM-02): first the automatic recovery
 * (the encryption key derived from the sign-in key), which on success closes
 * with "Messages unlocked"; if that can't work, one secure field for the
 * encryption key, checked against the identity. The key's formats are named
 * only in the error for text that is not one (#22).
 */
/** Unlocked: the inbox, read again, with "Messages unlocked". */
function unlocked(close: () => void): void {
  toast.success('Messages unlocked');
  refreshDm();
  close();
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
  return (
    <Sheet open={open} onClose={onClose} dismissible={!saving} testID="dm-unlock-sheet">
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

  useEffect(() => {
    let current = true;
    engine.api.dm
      .unlock({})
      .then((result) => {
        if (!current) return;
        if (result.unlocked) {
          unlocked(onClose);
        } else {
          setPhase(result.reason === 'no-key-on-identity' ? 'no-key' : 'manual');
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
        } else if (result.reason === 'no-key-on-identity') {
          setPhase('no-key');
        } else {
          setError(keyError(value));
        }
      })
      .catch((e: unknown) => {
        setError(errorCode(e) === 'KEY_INVALID' ? keyError(value) : (readErrorMessage(e) ?? keyError(value)));
      })
      .finally(() => setSaving(false));
  };

  const title = phase === 'recovering' ? 'Unlocking your messages…' : 'Unlock your messages';

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
      {phase === 'no-key' ? (
        <View className="gap-4 pb-2">
          <Text variant="body" tone="secondary">
            This account has no encryption key yet. Add one on yap.pr, then come back to read and send messages here.
          </Text>
          <Button
            label="Open yap.pr"
            variant="outline"
            size="block"
            onPress={() => openExternal(`https://yap.pr${config.webBasePath}/messages`)}
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
              value={key}
              onChangeText={(text) => {
                setKey(text);
                setError(null);
              }}
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
