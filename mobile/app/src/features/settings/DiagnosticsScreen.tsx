import type { EngineDiagnostics } from '@engine/api';
import { RpcErrorCode, type LogLevel } from '@engine/protocol/envelope';
import * as Clipboard from 'expo-clipboard';
import { Stack, useIsFocused } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Alert, AppState, Platform, Pressable, Text as RNText, Share, TextInput, View } from 'react-native';
import { ChevronDownIcon, ClipboardDocumentIcon } from 'react-native-heroicons/outline';

import { config } from '~/config';
import { useEngineEvent } from '~/data/events';
import { getEngineErrors, subscribeEngineErrors } from '~/engine/errors';
import { useEngineStatus } from '~/engine/hooks';
import { engine, engineNetworkKey, engineStorage, engineSupervisor, resetEngineData, simulateOnNextBoot } from '~/engine/index';
import { appendLog, errorMessage, getLogs, subscribeLogs } from '~/engine/logs';
import type { EngineStatus } from '~/engine/supervisor';
import { ActionButton, Row, Section, type Tone } from '~/engine/ui';
import { clearAccountCache, persistedCacheBytes } from '~/state/query-client';
import { Screen } from '~/ui/Screen';
import { useNativeText } from '~/ui/native-text';
import { Text } from '~/ui/Text';
import { toast } from '~/ui/toast';
import { useColors } from '~/ui/tokens';

import { copy } from './copy';
import {
  capabilityRows,
  CONTRACTS,
  dapiEndpointCount,
  diagCopy,
  diagnosticsText,
  formatAgo,
  formatBytes,
  shortId,
  type DiagnosticsSnapshot,
} from './diagnostics';

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
const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

function useLogs() {
  return useSyncExternalStore(subscribeLogs, getLogs);
}

function useEngineErrors() {
  return useSyncExternalStore(subscribeEngineErrors, getEngineErrors);
}

/** The engine is taking calls: a diagnostics read now answers rather than queueing. */
const accepting = (state: EngineStatus['state']) => state === 'ready' || state === 'degraded';

const readStats = () => ({ storage: engineStorage.stats(), cacheBytes: persistedCacheBytes(), now: Date.now() });

/**
 * What is not observable (storage counts, the cache size, the engine's WASM
 * and DAPI figures, the clock for "last ok"): re-read every 2 s while the
 * screen is visible (focused, the app in the foreground; UX_SPEC §4.32). It
 * stays mounted in the Profile stack while another tab shows, so focus counts.
 */
function useLiveStats(state: EngineStatus['state']) {
  const [stats, setStats] = useState(readStats);
  const [diagnostics, setDiagnostics] = useState<EngineDiagnostics | null>(null);
  const focused = useIsFocused();
  const live = accepting(state);
  // An engine built before `engine.diagnostics` (a dev URL, an older dev client) answers UNKNOWN_METHOD:
  // stop asking, rather than fill recent errors with one failure every 2 s.
  const unsupported = useRef(false);
  useEffect(() => {
    if (!focused) return undefined;
    let mounted = true;
    const tick = () => {
      if (AppState.currentState === 'background') return;
      setStats(readStats());
      if (!live || unsupported.current) return;
      engine.api.engine
        .diagnostics()
        .then((next) => {
          if (mounted) setDiagnostics(next);
        })
        // A failed call is listed under recent errors by the supervisor; the last figures stay.
        .catch((error: unknown) => {
          if ((error as { code?: unknown } | null)?.code === RpcErrorCode.UnknownMethod) unsupported.current = true;
        });
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [live, focused]);
  return { ...stats, diagnostics };
}

/** A section header that opens a list in place (the spec's `›` rows). */
function Disclosure({ title, value, testID, children }: { title: string; value?: string; testID: string; children: ReactNode }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((was) => !was)}
        testID={testID}
        className="min-h-11 flex-row items-center gap-3 px-4 py-2 active:opacity-70"
      >
        <Text className="flex-1">{title}</Text>
        {value ? <RNText className="font-mono text-sm text-gray-900 dark:text-gray-100">{value}</RNText> : null}
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
          <ChevronDownIcon size={16} color={c.textSecondary} />
        </View>
      </Pressable>
      {open ? <View className="pb-2">{children}</View> : null}
    </View>
  );
}

/** A contract id, shortened, with its copy action (PRD SET-08). */
function ContractRow({ label, id, testID }: { label: string; id: string | undefined; testID: string }) {
  const c = useColors();
  return (
    <View className="flex-row items-center gap-3 px-4 py-1">
      <Text className="flex-1">{label}</Text>
      <RNText selectable className="font-mono text-sm text-gray-900 dark:text-gray-100">
        {shortId(id)}
      </RNText>
      {id ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={diagCopy.copyContract(label)}
          hitSlop={8}
          onPress={() => {
            Clipboard.setStringAsync(id)
              .then(() => toast(diagCopy.contractCopied(label)))
              .catch((error: unknown) => appendLog('warn', 'host', `Copying ${label} failed: ${errorMessage(error)}`));
          }}
          testID={testID}
          className="p-1 active:opacity-60"
        >
          <ClipboardDocumentIcon size={18} color={c.textSecondary} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Newest first; a row opens to the full message (UX_SPEC §4.32). */
function ErrorRow({ at, operation, message }: { at: number; operation: string; message: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={() => setOpen((was) => !was)}
      className="gap-0.5 px-4 py-1.5 active:opacity-70"
    >
      <RNText className="font-mono text-xs text-gray-600 dark:text-gray-400">
        {new Date(at).toISOString().slice(11, 19)} {operation}
      </RNText>
      <RNText selectable numberOfLines={open ? undefined : 2} className="font-mono text-xs text-red-600">
        {message}
      </RNText>
    </Pressable>
  );
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
  // Uncontrolled (`useNativeText`); the field cleared after each call is put in.
  const keyInput = useNativeText({ value: key, onChangeText: setKey });
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
          key={keyInput.key}
          {...keyInput.inputProps}
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

/**
 * Settings → About → Troubleshooting (UX_SPEC §4.32, PRD SET-08), for
 * support: versions, timings, the network wiring and the redacted log, with
 * Copy diagnostics first. Available signed out and in release builds.
 */
export function DiagnosticsScreen() {
  const status = useEngineStatus();
  const logs = useLogs();
  const errors = useEngineErrors();
  const { storage: stats, cacheBytes, diagnostics, now } = useLiveStats(status.state);
  const [result, setResult] = useState<string | null>(null);
  const { hello, info, caps, timings } = status;
  const state = STATE_LABEL[status.state];
  const bundleMismatch = hello && config.engine && hello.bundleHash !== config.engine.bundleHash;
  const snapshot = (): DiagnosticsSnapshot => ({
    status,
    diagnostics,
    cacheBytes,
    errors,
    logs,
    networkKey: engineNetworkKey,
    now: Date.now(),
  });
  const share = () => {
    Share.share({ message: diagnosticsText(snapshot()) }).catch((error: unknown) =>
      appendLog('warn', 'host', `Sharing diagnostics failed: ${errorMessage(error)}`),
    );
  };
  const copyText = () => {
    Clipboard.setStringAsync(diagnosticsText(snapshot()))
      .then(() => toast.success(diagCopy.copied))
      .catch((error: unknown) => appendLog('warn', 'host', `Copying diagnostics failed: ${errorMessage(error)}`));
  };
  const dapi = diagnostics?.dapi;
  const capabilities = capabilityRows(info?.capabilities);

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
      <Stack.Screen
        options={{
          title: copy.sections.diagnostics,
          headerRight: () => (
            <Pressable accessibilityRole="button" onPress={share} hitSlop={8} testID="diagnostics-share-header">
              <Text tone="link">{diagCopy.share}</Text>
            </Pressable>
          ),
        }}
      />

      <View className="px-4 pt-4">
        <ActionButton label={diagCopy.copy} testID="diagnostics-copy" onPress={copyText} />
      </View>

      <Section title="Status">
        <Row label="Engine" value={`● ${state.label}`} tone={state.tone} />
        {status.reason ? <Row label="Reason" value={status.reason} tone="warn" /> : null}
        <Row label={diagCopy.boot} value={ms(timings?.bootMs ?? info?.bootMs)} />
        <Row label={diagCopy.wasm} value={ms(diagnostics?.wasmMs ?? undefined)} />
        <Row label="Epoch / restarts" value={`${status.epoch} / ${status.restarts}`} />
        <Row label="Queued calls" value={String(status.queued)} />
        <Row label="Prepare (storage, page)" value={ms(timings?.prepareMs)} />
        <Row label="Mount → hello" value={ms(timings?.helloMs)} />
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
        {CONTRACTS.map(({ key, label }) => (
          <ContractRow key={key} label={label} id={info?.contracts[key]} testID={`diagnostics-copy-${key}`} />
        ))}
        <Disclosure
          title={diagCopy.dapi}
          value={dapi ? diagCopy.dapiSummary(dapiEndpointCount(dapi), formatAgo(dapi.lastOkAt, now)) : '—'}
          testID="diagnostics-dapi"
        >
          {(dapi?.endpoints ?? []).map((endpoint) => (
            <Row
              key={endpoint.origin}
              label={endpoint.origin.replace(/^https?:\/\//, '')}
              value={`last ok ${formatAgo(endpoint.lastOkAt, now)} · ${endpoint.failures}/${endpoint.requests} failed`}
              tone={endpoint.lastErrorAt !== null && (endpoint.lastOkAt ?? 0) < endpoint.lastErrorAt ? 'warn' : undefined}
            />
          ))}
        </Disclosure>
        <Disclosure title={diagCopy.capabilities} value={capabilities.length ? String(capabilities.length) : '—'} testID="diagnostics-capabilities">
          {capabilities.map(({ label, value }) => (
            <Row key={label} label={label} value={value} />
          ))}
        </Disclosure>
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
        <Row label={diagCopy.cache} value={formatBytes(cacheBytes)} />
      </Section>

      {/* A collapsed row (UX_SPEC §4.32), so up to 50 errors never push the actions below off screen. */}
      <Section title={diagCopy.errors}>
        {errors.length === 0 ? (
          <Row label={diagCopy.noErrors} value="" />
        ) : (
          <Disclosure title={diagCopy.recentErrors(errors.length)} testID="diagnostics-errors-toggle">
            <View testID="diagnostics-errors">
              {[...errors].reverse().map((error) => (
                <ErrorRow key={error.id} {...error} />
              ))}
            </View>
          </Disclosure>
        )}
      </Section>

      <View className="gap-3 px-4 pt-6">
        <ActionButton kind="outline" label={diagCopy.shareDiagnostics} testID="diagnostics-share" onPress={share} />
        <ActionButton
          kind="danger"
          label={diagCopy.reconnect}
          testID="diagnostics-restart"
          onPress={() =>
            confirm(diagCopy.reconnectTitle, diagCopy.reconnectBody, diagCopy.reconnect, () =>
              engineSupervisor.restart('Reconnect from troubleshooting'),
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
