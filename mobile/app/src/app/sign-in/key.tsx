import { Stack, useIsFocused } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { CheckCircleIcon, ExclamationCircleIcon } from 'react-native-heroicons/outline';

import { useSessionStore } from '~/data/session';
import { engine } from '~/engine';
import { accountName, switchAccount, useReauthTarget } from '~/features/auth/accounts';
import { copy } from '~/features/auth/copy';
import { isTransient, keyErrorText } from '~/features/auth/errors';
import { useCloseSignIn } from '~/features/auth/navigation';
import { SignInBody } from '~/features/auth/SignInChrome';
import { Button } from '~/ui/Button';
import { useBlockScreenCapture } from '~/ui/screen-capture';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { useColors } from '~/ui/tokens';

/** UX_SPEC §4.6: validation runs this long after typing stops. */
const CHECK_DELAY_MS = 400;

type Check =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'found'; identityId: string; username: string | null }
  | { state: 'error'; message: string; transient: boolean };

const errorState = (error: unknown): Check => ({
  state: 'error',
  message: keyErrorText(error),
  transient: isTransient(error),
});

function StatusLine({ ok, text, testID }: { ok: boolean; text: string; testID?: string }) {
  const c = useColors();
  const Icon = ok ? CheckCircleIcon : ExclamationCircleIcon;
  return (
    <View className="flex-row items-start gap-2" testID={testID} accessibilityLiveRegion="polite">
      <Icon size={18} color={ok ? c.repost : c.error} />
      <Text variant="subhead" tone={ok ? 'repost' : 'error'} className="flex-1">
        {text}
      </Text>
    </View>
  );
}

/**
 * Sign in with a private key (PRD AUTH-08): a WIF or 64-hex key, looked up
 * with `session.checkKey` ("Identity found") before `session.signInWithKey`.
 * The key lives only in this screen's state and goes to the engine alone;
 * it is never logged, and it is gone when the screen closes.
 */
export default function KeySignInScreen() {
  const close = useCloseSignIn();
  const accounts = useSessionStore((s) => s.accounts);
  const activeId = useSessionStore((s) => s.session?.identityId ?? null);
  const reauth = useReauthTarget();
  const [key, setKey] = useState('');
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  useBlockScreenCapture('secret', useIsFocused());
  const [signingIn, setSigningIn] = useState(false);
  const checkId = useRef(0);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  /** Looks the key up 400 ms after typing stops; an older answer never overwrites a newer one. */
  const onChangeKey = (text: string) => {
    setKey(text);
    clearTimeout(timer.current);
    const id = ++checkId.current;
    const input = text.trim();
    if (!input) {
      setCheck({ state: 'idle' });
      return;
    }
    setCheck({ state: 'checking' });
    timer.current = setTimeout(() => {
      engine.api.session
        .checkKey({ key: input })
        .then((found) => {
          if (id === checkId.current) setCheck({ state: 'found', identityId: found.identityId, username: found.username });
        })
        .catch((error: unknown) => {
          if (id === checkId.current) setCheck(errorState(error));
        });
    }, CHECK_DELAY_MS);
  };

  const found = check.state === 'found' ? check : null;
  const foundId = found?.identityId ?? '';
  // An account being signed in again (AUTH-14) takes this key: switching would bring back the one that stopped working.
  const existing = accounts.find((a) => a.identityId === foundId && a.identityId !== activeId && a.identityId !== reauth);
  const alreadyActive = !!found && foundId === activeId;

  /** Signed in: clear the key, close the flow (the terms gate follows when needed). */
  const done = () => {
    setKey('');
    close();
  };

  const signIn = async () => {
    const input = key.trim();
    if (!found || !input) return;
    setSigningIn(true);
    try {
      if (existing) {
        // Already on this device (parked by "Add account"): switch instead of signing in again.
        if (await switchAccount(existing)) done();
        return;
      }
      await engine.api.session.signInWithKey({ key: input });
      done();
    } catch (error) {
      setCheck(errorState(error));
    } finally {
      setSigningIn(false);
    }
  };

  const foundName = found ? accountName(found) : '';

  return (
    <>
      <Stack.Screen options={{ title: copy.key.title, headerShadowVisible: false }} />
      <SignInBody testID="sign-in-key">
        <TextField
          secure
          value={key}
          onChangeText={onChangeKey}
          placeholder={copy.key.placeholder}
          accessibilityLabel={copy.key.label}
          autoFocus
          returnKeyType="go"
          onSubmitEditing={() => {
            signIn().catch(() => undefined);
          }}
          editable={!signingIn}
          testID="key-input"
        />
        <View className="min-h-12 gap-2">
          {check.state === 'checking' ? (
            <View className="flex-row items-center gap-2" testID="key-checking">
              <Spinner size="xs" />
              <Text variant="subhead" tone="secondary">
                {copy.key.checking}
              </Text>
            </View>
          ) : null}
          {found ? (
            <>
              <StatusLine ok text={`${copy.key.found}: ${foundName}`} testID="key-found" />
              <StatusLine ok={!alreadyActive} text={alreadyActive ? copy.key.alreadyActive : copy.key.matches} />
            </>
          ) : null}
          {check.state === 'error' ? <StatusLine ok={false} text={check.message} testID="key-error" /> : null}
          {check.state === 'error' && check.transient ? (
            <Button
              label={copy.signin.tryAgain}
              variant="link"
              size="sm"
              layoutStyle={{ alignSelf: 'flex-start' }}
              testID="key-retry"
              onPress={() => onChangeKey(key)}
            />
          ) : null}
        </View>
        <Text variant="subhead" tone="secondary">
          {copy.key.note}
        </Text>
        <Button
          label={existing ? copy.key.switchTo : copy.key.signIn}
          size="block"
          disabled={!found || alreadyActive}
          loading={signingIn}
          testID="key-sign-in"
          onPress={() => {
            signIn().catch(() => undefined);
          }}
        />
      </SignInBody>
    </>
  );
}
