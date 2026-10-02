import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, View } from 'react-native';
import { CheckCircleIcon } from 'react-native-heroicons/outline';

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

type Phase = 'recovering' | 'recovered' | 'manual' | 'no-key';

const RECOVERED_CLOSE_MS = 1000;

/**
 * "Unlock messages" (UX_SPEC §4.38, PRD DM-02): first the automatic recovery
 * (the encryption key derived from the sign-in key), then, if that can't
 * work, a secure field for the encryption key, checked against the identity.
 */
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
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  useEffect(() => {
    let current = true;
    engine.api.dm
      .unlock({})
      .then((result) => {
        if (!current) return;
        if (result.unlocked) {
          setPhase('recovered');
          refreshDm();
          closeTimer.current = setTimeout(onClose, RECOVERED_CLOSE_MS);
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
          toast.success('Encryption key saved');
          refreshDm();
          onClose();
        } else if (result.reason === 'no-key-on-identity') {
          setPhase('no-key');
        } else {
          setError('Invalid key');
        }
      })
      .catch((e: unknown) => {
        setError(errorCode(e) === 'KEY_INVALID' ? 'Invalid key' : (readErrorMessage(e) ?? 'Invalid key'));
      })
      .finally(() => setSaving(false));
  };

  const title =
    phase === 'recovering' ? 'Recovering Key…' : phase === 'recovered' ? 'Key Recovered!' : 'Unlock your messages';

  return (
    <View className="gap-2">
      <Text variant="headline" tone="emphasis" accessibilityRole="header">
        {title}
      </Text>
      {phase === 'recovering' ? (
        <View className="flex-row items-center gap-3 py-4">
          <Spinner size="sm" />
          <Text variant="body" tone="secondary" className="flex-1">
            Attempting to automatically recover your encryption key…
          </Text>
        </View>
      ) : null}
      {phase === 'recovered' ? (
        <View className="flex-row items-center gap-3 py-4" testID="dm-unlock-recovered">
          <CheckCircleIcon size={24} color={c.repost} />
          <Text variant="body" className="flex-1">
            Your encryption key was automatically recovered.
          </Text>
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
            Messages are encrypted with your encryption key. Enter it on this device to read and send them.
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
              placeholder="WIF (cXyz...) or hex (64 chars)"
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
            label="Save key"
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
