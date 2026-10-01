import type { LogLevel } from '@engine/protocol/envelope';
import * as Clipboard from 'expo-clipboard';
import { Stack } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Platform, Text as RNText, TextInput, View } from 'react-native';

import { config } from '~/config';
import { useEngineEvent, useEngineStatus } from '~/engine/hooks';
import { engine, engineNetworkKey, engineStorage, engineSupervisor, resetEngineData, simulateOnNextBoot } from '~/engine/index';
import { getLogs, subscribeLogs } from '~/engine/logs';
import type { EngineStatus } from '~/engine/supervisor';
import { ActionButton, Row, Section, type Tone } from '~/engine/ui';
import { clearAccountCache } from '~/state/query-client';
import { Screen } from '~/ui/Screen';

const STATE_LABEL: Record<EngineStatus['state'], { label: string; tone?: Tone }> = {
  idle: { label: 'Stopped' },
  starting: { label: 'Booting', tone: 'warn' },
  handshaking: { label: 'Booting', tone: 'warn' },
  booting: { label: 'Booting', tone: 'warn' },
  ready: { label: 'Ready', tone: 'ok' },
  degraded: { label: 'Degraded', tone: 'warn' },
  crashed: { label: 'Restarting', tone: 'warn' },
  restarting: { label: 'Restarting', tone: 'warn' },
  unsupported: { label: 'Unavailable', tone: 'bad' },
  failed: { label: 'Unavailable', tone: 'bad' },
};

const ms = (value: number | undefined) => (value === undefined ? '—' : `${value.toLocaleString()} ms`);
const yesNo = (value: boolean | undefined) => {
  if (value === undefined) return '—';
  return value ? 'Yes' : 'No';
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: 'text-gray-600 dark:text-gray-400',
  info: 'text-gray-600 dark:text-gray-400',
  warn: 'text-amber-600',
  error: 'text-red-600',
};
const short = (value: string | undefined) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—');
const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

/** Shared text: status and redacted logs only, never keys or message content (UX_SPEC §4.32). */
function diagnosticsText(status: EngineStatus): string {
  const { hello, info, caps, timings } = status;
  return [
    `Yappr ${config.appVersion} (${config.variant}, ${Platform.OS} ${Platform.Version})`,
    `engine: ${status.state}${status.reason ? ` (${status.reason})` : ''}, epoch ${status.epoch}, restarts ${status.restarts}`,
    `network: ${info?.network ?? config.network} (${engineNetworkKey}), topology ${info?.topology ?? '?'}`,
    `evo-sdk ${info?.evoSdkVersion ?? '?'}, bundle ${hello?.bundleHash ?? '?'}`,
    `timings: ${JSON.stringify(timings)}`,
    `webview: ${caps?.userAgent ?? '?'}`,
    '',
    ...getLogs()
      .slice(-200)
      .map((line) => `${new Date(line.at).toISOString()} ${line.source} ${line.level} ${line.message}`),
  ].join('\n');
}

function useLogs() {
  return useSyncExternalStore(subscribeLogs, getLogs);
}

/** Storage counts are not observable; re-read them every 2 s while the screen is up. */
function useStorageStats() {
  const [stats, setStats] = useState(() => engineStorage.stats());
  useEffect(() => {
    const timer = setInterval(() => setStats(engineStorage.stats()), 2000);
    return () => clearInterval(timer);
  }, []);
  return stats;
}

function confirm(title: string, message: string, action: string, run: () => void) {
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: action, style: 'destructive', onPress: run },
  ]);
}

/**
 * Dev only, devnet only: sign in with a pasted private key (WIF or hex) so
 * screens can be tested signed in before the real sign-in flow lands. No key
 * is bundled; the field is cleared as soon as the call returns.
 */
function DevSignIn() {
  const [key, setKey] = useState('');
  const [session, setSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    engine.api.session
      .current()
      .then((current) => setSession(current ? `${current.username ?? current.identityId}` : null))
      .catch((e: unknown) => setError(errorText(e)));
  };
  useEffect(refresh, []);
  useEngineEvent('session.changed', refresh);

  const run = (call: () => Promise<unknown>) => {
    setError(null);
    call()
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => {
        setKey('');
        refresh();
      });
  };

  return (
    <Section title="Dev sign-in (devnet)">
      <View className="gap-3 p-4">
        <Row label="Signed in as" value={session ?? 'nobody'} />
        <TextInput
          value={key}
          onChangeText={setKey}
          placeholder="Private key (WIF or hex)"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          testID="dev-sign-in-key"
          className="rounded-lg border border-gray-300 px-3 py-2 font-mono text-gray-900 dark:border-gray-700 dark:text-white"
        />
        <ActionButton
          label="Sign in"
          testID="dev-sign-in"
          onPress={() => run(() => engine.api.session.signInWithKey({ key: key.trim() }))}
        />
        {session ? (
          <ActionButton kind="outline" label="Sign out" onPress={() => run(() => engine.api.session.signOut())} />
        ) : null}
        {error ? <Row label="Error" value={error} tone="bad" /> : null}
      </View>
    </Section>
  );
}

export default function DiagnosticsScreen() {
  const status = useEngineStatus();
  const logs = useLogs();
  const stats = useStorageStats();
  const [result, setResult] = useState<string | null>(null);
  const { hello, info, caps, timings } = status;
  const state = STATE_LABEL[status.state];
  const bundleMismatch = hello && config.engine && hello.bundleHash !== config.engine.bundleHash;

  /** Dev builds: call the engine from the UI and show what came back. */
  const debugCall = async (label: string, run: () => Promise<string>) => {
    setResult(`${label}…`);
    const started = Date.now();
    try {
      const text = await run();
      setResult(`${label} → ${Date.now() - started} ms\n${text}`);
    } catch (error) {
      setResult(`${label} failed after ${Date.now() - started} ms\n${errorText(error)}`);
    }
  };

  return (
    <Screen scroll>
      <Stack.Screen options={{ title: 'Engine diagnostics' }} />

      <Section title="Status">
        <Row label="Engine" value={`● ${state.label}`} tone={state.tone} />
        {status.reason ? <Row label="Reason" value={status.reason} tone="warn" /> : null}
        <Row label="Epoch / restarts" value={`${status.epoch} / ${status.restarts}`} />
        <Row label="Queued calls" value={String(status.queued)} />
        <Row label="Prepare (storage, page)" value={ms(timings?.prepareMs)} />
        <Row label="Mount → hello" value={ms(timings?.helloMs)} />
        <Row label="Boot (SDK, contracts)" value={ms(timings?.bootMs)} />
        <Row label="Mount → ready" value={ms(timings?.readyMs)} />
        <Row
          label="First call"
          value={timings?.firstCall ? `${timings.firstCall.path} ${ms(timings.firstCall.ms)}` : '—'}
        />
      </Section>

      <Section title="Network">
        <Row label="Network" value={`${info?.network ?? config.network} · ${engineNetworkKey}`} />
        <Row label="Variant" value={`${config.variant} (engine ${info?.variant ?? '—'})`} />
        <Row label="evo-sdk" value={info?.evoSdkVersion ?? config.engine?.evoSdkVersion ?? '—'} />
        <Row label="Engine bundle" value={(hello?.bundleHash ?? config.engine?.bundleHash ?? '—').slice(0, 12)} />
        {bundleMismatch ? <Row label="" value="differs from the build's engine (dev URL?)" tone="warn" /> : null}
        <Row label="Topology" value={info?.topology ?? config.engine?.topology ?? '—'} />
        <Row label="Social contract" value={short(info?.contracts.social)} />
        <Row label="Profile contract" value={short(info?.contracts.profile)} />
        <Row label="DM contract" value={short(info?.contracts.dm)} />
      </Section>

      <Section title="WebView">
        <Row label="WebAssembly" value={yesNo(caps?.webAssembly ?? info?.webAssembly)} tone={caps?.webAssembly === false ? 'bad' : undefined} />
        <Row label="Secure context" value={yesNo(caps?.secureContext)} />
        <Row label="crypto.subtle" value={yesNo(caps?.subtleCrypto)} />
        <Row label="Worker / DecompressionStream" value={`${yesNo(caps?.worker)} / ${yesNo(caps?.decompressionStream)}`} />
        {Platform.OS === 'android' ? <Row label="WebView (Chrome)" value={String(caps?.chromeMajor ?? '—')} /> : null}
      </Section>

      <Section title="Storage">
        <Row label="Plain keys (encrypted MMKV)" value={String(stats.localKeys)} />
        <Row label="Secure keys / identities" value={`${stats.secureKeys} / ${stats.identities}`} />
        <Row label="Snapshot at boot" value={`${(stats.snapshotChars / 1024).toFixed(1)} KB`} />
      </Section>

      <View className="gap-3 px-4 pt-6">
        <ActionButton
          kind="outline"
          label="Copy diagnostics"
          onPress={() => {
            Clipboard.setStringAsync(diagnosticsText(status)).catch(() => undefined);
          }}
        />
        <ActionButton
          kind="danger"
          label="Restart engine"
          testID="diagnostics-restart"
          onPress={() =>
            confirm('Restart the engine?', 'Lists reload; nothing you posted is lost.', 'Restart', () =>
              engineSupervisor.restart('Restart from diagnostics'),
            )
          }
        />
        <ActionButton
          kind="danger"
          label="Clear cache"
          onPress={() =>
            confirm('Clear saved posts and lists?', 'Your accounts, keys and drafts stay.', 'Clear', () => {
              clearAccountCache().catch(() => undefined);
            })
          }
        />
        {config.network === 'devnet' || __DEV__ ? (
          <ActionButton
            kind="danger"
            label={`Reset ${engineNetworkKey} data`}
            onPress={() =>
              confirm(
                `Reset ${engineNetworkKey} data?`,
                'Deletes the engine storage and signed-in keys for this network on this device.',
                'Reset',
                () => {
                  resetEngineData().catch((error: unknown) => setResult(errorText(error)));
                },
              )
            }
          />
        ) : null}
      </View>

      {__DEV__ && config.variant === 'devnet' ? <DevSignIn /> : null}

      {__DEV__ ? (
        <Section title="Debug calls (dev)">
          <View className="gap-3 p-4">
            <ActionButton
              kind="outline"
              label="engine.info()"
              testID="debug-engine-info"
              onPress={() => debugCall('engine.info()', async () => JSON.stringify(await engine.api.engine.info(), null, 2))}
            />
            <ActionButton
              kind="outline"
              label="feed.home(forYou)"
              testID="debug-feed-home"
              onPress={() =>
                debugCall('feed.home({ tab: forYou })', async () => {
                  const page = await engine.api.feed.home({ tab: 'forYou' });
                  return [
                    `${page.items.length} posts, more: ${page.hasMore ? "yes" : "no"}`,
                    ...page.items
                      .slice(0, 5)
                      .map((post) => `• @${post.author.username ?? post.author.displayName}: ${post.content.slice(0, 60)}`),
                  ].join('\n');
                })
              }
            />
            <ActionButton kind="plain" label="Simulate Lockdown Mode" onPress={() => simulateOnNextBoot('no-webassembly')} />
            <ActionButton kind="plain" label="Simulate outdated WebView" onPress={() => simulateOnNextBoot('old-webview')} />
            <ActionButton kind="plain" label="Probe WebView timers" onPress={() => engineSupervisor.probeTimers()} />
            {result ? (
              <RNText selectable testID="debug-result" className="font-mono text-xs text-gray-900 dark:text-gray-100">
                {result}
              </RNText>
            ) : null}
          </View>
        </Section>
      ) : null}

      <Section title={`Recent logs (${logs.length})`}>
        <View className="gap-1 p-4">
          {logs
            .slice(-100)
            .reverse()
            .map((line) => (
              <RNText
                key={line.id}
                selectable
                className={`font-mono text-xs ${LEVEL_COLOR[line.level]}`}
              >
                {new Date(line.at).toISOString().slice(11, 23)} {line.source === 'host' ? 'host ' : ''}
                {line.message}
              </RNText>
            ))}
        </View>
      </Section>
      <View className="h-12" />
    </Screen>
  );
}
