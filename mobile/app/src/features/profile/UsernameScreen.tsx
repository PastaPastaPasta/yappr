import type { DpnsAvailabilityDTO } from '@engine/api';
import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { AtSymbolIcon } from 'react-native-heroicons/outline';

import { queryKeys } from '~/data/keys';
import { useEngineQuery } from '~/data/queries';
import { useSession, useSessionStore } from '~/data/session';
import { useLandingIntent, useWrite, type WriteSpec } from '~/data/writes';
import { engine } from '~/engine';
import { appendLog, errorMessage } from '~/engine/logs';
import { formatDash } from '~/features/settings/format';
import { queryClient } from '~/state/query-client';
import { Button } from '~/ui/Button';
import { EmptyState, ErrorState } from '~/ui/EmptyState';
import { KeyboardAvoider } from '~/ui/KeyboardAvoider';
import { Screen } from '~/ui/Screen';
import { Spinner } from '~/ui/Spinner';
import { Text } from '~/ui/Text';
import { TextField } from '~/ui/TextField';
import { toast } from '~/ui/toast';

/** UX copy for "Choose a username" (web's `/dpns/register` wizard and `WalletUsernameGuide`). */
const copy = {
  title: 'Choose a username',
  titleAnother: 'Add a username',
  intro: "It's how people find and mention you.",
  label: 'Username',
  placeholder: 'yourname',
  check: 'Check availability',
  checking: 'Checking…',
  available: (name: string) => `@${name} is available`,
  taken: (name: string) => `@${name} is already taken`,
  checkFailed: "Couldn't check that name. Try again.",
  contested: (fund: string) =>
    `Names under 20 characters made only of letters, hyphens, 0 and 1 go to a masternode vote. Registering joins it and pays at least ${fund} from your balance into its fund.`,
  register: 'Register username',
  registerContested: 'Register and join the vote',
  registering: 'Registering…',
  registered: (name: string) => `@${name} is yours`,
  joinedVote: (name: string) => `You've joined the vote for @${name}. It's yours if the vote picks you.`,
  failed: "Couldn't register that username. Try again.",
  wallet: 'Pick your username in your Dash wallet. Once it’s registered, come back here.',
  walletAnother: 'Register another username in your Dash wallet. Your existing usernames keep working.',
  walletCheck: "I've registered one",
  walletRefresh: 'Refresh usernames',
  walletNone: 'No username yet. It can take a minute to show up.',
  walletRefreshed: 'Usernames refreshed. A new one can take a minute to show up.',
  walletFound: 'Your username is set up',
  signIn: 'Sign in to choose a username',
  signInAction: 'Sign in',
  loadFailed: "Couldn't load your account. Try again.",
};

interface RegisterVars {
  viewerId: string;
  label: string;
  /** It goes to a masternode vote: registering joins it rather than taking the name. */
  contested: boolean;
}

/** Refusals the engine words itself (taken, invalid, a contest the balance can't pay). */
const ownSentence = (code: string | undefined) => code === 'BAD_REQUEST' || code === 'NOT_SUPPORTED';

const registerWrite: WriteSpec<RegisterVars> = {
  key: ({ viewerId }) => `dpns:${viewerId}`,
  submit: (api, { label }) => api.dpns.register(label),
  failureMessage: copy.failed,
  failureText: (ticket) => (ownSentence(ticket.error?.code) ? (ticket.error?.userMessage ?? null) : null),
  // A contested name only joins its vote (web's complete step): it is not theirs yet.
  onConfirmed: (_ticket, { viewerId, label, contested }) => {
    toast.success(contested ? copy.joinedVote(label) : copy.registered(label));
    queryClient.invalidateQueries({ queryKey: queryKeys.profile.detail(viewerId) }).catch(() => undefined);
  },
};

/** The name checked, the check in flight, or the check's failure; reset by any edit. */
type Check = { label: string; result: DpnsAvailabilityDTO } | 'checking' | 'failed' | null;

function NativeRegistration({ viewerId }: { viewerId: string }) {
  const [label, setLabel] = useState('');
  const [check, setCheck] = useState<Check>(null);
  const write = useWrite(registerWrite);
  const registering = useLandingIntent(`dpns:${viewerId}`) !== undefined;
  const typed = label.trim().toLowerCase().replace(/^@/, '').replace(/\.dash$/, '');
  const result = check !== null && typeof check === 'object' && check.label === typed ? check.result : null;

  const runCheck = () => {
    if (!typed) return;
    setCheck('checking');
    engine.api.dpns
      .check(typed)
      .then((answer) => setCheck({ label: typed, result: answer }))
      .catch((error: unknown) => {
        appendLog('info', 'host', `Username check failed: ${errorMessage(error)}`);
        setCheck('failed');
      });
  };
  const register = () => {
    if (!result?.available || registering) return;
    write.run({ viewerId, label: result.label, contested: result.contestFundCredits !== null }).catch(() => undefined);
  };
  // Confirmed: back to where the user came from (the toast says what happened). Refused (taken
  // meanwhile, a contest the balance can't pay): the old verdict no longer holds, so check again.
  const confirmed = write.status === 'confirmed';
  useEffect(() => {
    if (confirmed && router.canGoBack()) router.back();
  }, [confirmed]);
  const failedTicket = write.status === 'failed' ? (write.ticket?.id ?? null) : null;
  const [clearedFor, setClearedFor] = useState<string | null>(null);
  if (failedTicket !== null && failedTicket !== clearedFor) {
    setClearedFor(failedTicket);
    setCheck(null);
  }

  let registerLabel = copy.register;
  if (registering) registerLabel = copy.registering;
  else if (result !== null && result.contestFundCredits !== null) registerLabel = copy.registerContested;

  let verdict = null;
  if (check === 'failed') {
    verdict = (
      <Text variant="subhead" tone="error" testID="username-check-failed">
        {copy.checkFailed}
      </Text>
    );
  } else if (result) {
    const fund = result.contestFundCredits;
    verdict = (
      <View className="gap-2" accessibilityLiveRegion="polite" testID="username-verdict">
        <Text variant="bodyStrong" tone={result.available ? 'primary' : 'error'}>
          {result.invalid ?? (result.available ? copy.available(result.label) : copy.taken(result.label))}
        </Text>
        {result.available && fund !== null ? (
          <Text variant="subhead" tone="secondary" testID="username-contested">
            {copy.contested(formatDash(fund))}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View className="gap-4">
      <TextField
        label={copy.label}
        value={label}
        onChangeText={(text) => {
          setLabel(text);
          if (check === 'failed') setCheck(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        maxLength={63}
        editable={!registering}
        placeholder={copy.placeholder}
        returnKeyType="search"
        onSubmitEditing={runCheck}
        testID="username-input"
      />
      {result?.available ? null : (
        <Button
          label={check === 'checking' ? copy.checking : copy.check}
          size="block"
          variant="outline"
          loading={check === 'checking'}
          disabled={!typed || check === 'checking'}
          onPress={runCheck}
          testID="username-check"
        />
      )}
      {verdict}
      {result?.available ? (
        <Button
          label={registerLabel}
          size="block"
          loading={registering}
          disabled={registering}
          onPress={register}
          testID="username-register"
        />
      ) : null}
    </View>
  );
}

/**
 * A wallet sign-in can't sign a name: web's `WalletUsernameGuide`, with a way
 * to read the names again. A first name that shows up closes the screen.
 */
function WalletRegistration({ hasName }: { hasName: boolean }) {
  const [checking, setChecking] = useState(false);
  const [hadName] = useState(hasName);
  useEffect(() => {
    if (hadName || !hasName) return;
    toast.success(copy.walletFound);
    if (router.canGoBack()) router.back();
  }, [hadName, hasName]);
  const refresh = () => {
    setChecking(true);
    engine.api.dpns
      .refreshUsernames()
      .then(() => {
        // The session reports a new name on its own; the first one closes the screen (above).
        if (hadName) toast(copy.walletRefreshed);
        else if (!useSessionStore.getState().session?.username) toast(copy.walletNone);
      })
      .catch((error: unknown) => {
        appendLog('warn', 'host', `Username refresh failed: ${errorMessage(error)}`);
        toast.error(copy.checkFailed);
      })
      .finally(() => setChecking(false));
  };
  return (
    <View className="gap-4" testID="username-wallet">
      <Text variant="body">{hasName ? copy.walletAnother : copy.wallet}</Text>
      <Button
        label={hasName ? copy.walletRefresh : copy.walletCheck}
        size="block"
        loading={checking}
        disabled={checking}
        onPress={refresh}
        testID="username-wallet-refresh"
      />
    </View>
  );
}

/**
 * Settings → Account → Choose a username, and Home's "Get a username" card
 * (PRD AUTH-15): DPNS registration in the app, signed with the account's own
 * key; a wallet sign-in registers in the wallet, then reads its names again.
 */
export function UsernameScreen() {
  const { status, session } = useSession();
  const viewerId = status === 'signed-in' ? (session?.identityId ?? null) : null;
  const hasName = Boolean(session?.username);
  const registration = useEngineQuery(queryKeys.dpnsRegistration, (api) => api.dpns.registration(), {
    enabled: viewerId !== null,
  });
  const title = hasName ? copy.titleAnother : copy.title;
  const header = <Stack.Screen options={{ title }} />;

  if (!viewerId) {
    return (
      <Screen>
        {header}
        {status === 'unknown' ? (
          <View className="items-center p-8">
            <Spinner />
          </View>
        ) : (
          <EmptyState
            title={copy.signIn}
            icon={AtSymbolIcon}
            action={{ label: copy.signInAction, onPress: () => router.push('/sign-in') }}
            testID="username-signed-out"
          />
        )}
      </Screen>
    );
  }

  let body;
  if (registration.isPending) {
    body = (
      <View className="items-center p-8" testID="username-loading">
        <Spinner />
      </View>
    );
  } else if (registration.isError) {
    body = (
      <ErrorState
        message={copy.loadFailed}
        onRetry={() => {
          registration.refetch().catch(() => undefined);
        }}
        retrying={registration.isRetrying}
        testID="username-error"
      />
    );
  } else if (registration.data === 'wallet') {
    body = <WalletRegistration hasName={hasName} />;
  } else {
    body = <NativeRegistration viewerId={viewerId} />;
  }

  return (
    <Screen>
      {header}
      <KeyboardAvoider>
        <ScrollView keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic">
          <View className="gap-4 p-4" testID="username-screen">
            <Text variant="subhead" tone="secondary">
              {copy.intro}
            </Text>
            {body}
          </View>
        </ScrollView>
      </KeyboardAvoider>
    </Screen>
  );
}
