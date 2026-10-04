import type { CapabilitiesDTO, EngineDiagnostics, EngineInfo } from '@engine/api';
import { Platform } from 'react-native';

import { config } from '~/config';
import type { EngineErrorEntry } from '~/engine/errors';
import type { LogLine } from '~/engine/logs';
import type { EngineStatus } from '~/engine/supervisor';

/** Troubleshooting copy (UX_SPEC §4.32, §5.10). */
export const diagCopy = {
  share: 'Share',
  copy: 'Copy diagnostics',
  copied: 'Diagnostics copied',
  shareDiagnostics: 'Share diagnostics',
  reconnect: 'Reconnect',
  reconnectTitle: 'Reconnect to Dash Platform?',
  reconnectBody: 'Lists reload; nothing you posted is lost.',
  wasm: 'WASM compile',
  boot: 'Boot time',
  dapi: 'DAPI endpoints',
  dapiSummary: (count: number, lastOk: string) => `${count} · last ok ${lastOk}`,
  never: 'never',
  capabilities: 'Capabilities',
  cache: 'Cache',
  errors: 'Errors',
  recentErrors: (count: number) => `Recent errors (${count})`,
  noErrors: 'No errors',
  contractCopied: (label: string) => `${label} copied`,
  copyContract: (label: string) => `Copy ${label}`,
};

/** The contract ids shown with a copy action (PRD SET-08), in display order. */
export const CONTRACTS = [
  { key: 'social', label: 'Social contract' },
  { key: 'profile', label: 'Profile contract' },
  { key: 'dm', label: 'DM contract' },
  { key: 'pollr', label: 'Pollr contract' },
] as const satisfies readonly { key: keyof EngineInfo['contracts']; label: string }[];

export const shortId = (value: string | undefined) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '—');

/** "18.2 MB": the cache size row. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "4s ago", "3m ago", "2h ago", or "never". */
export function formatAgo(at: number | null | undefined, now: number): string {
  if (at === null || at === undefined) return diagCopy.never;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

/** The endpoints DAPI diagnostics counts: the configured pool (devnet), else the ones the SDK has used. */
export const dapiEndpointCount = (dapi: EngineDiagnostics['dapi']) => Math.max(dapi.configured, dapi.endpoints.length);

const flagValue = (value: unknown): string => {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value === null || value === undefined) return '—';
  return String(value);
};

/** The capability flags as label/value rows, nested ones flattened (`repostable.reply`). */
export function capabilityRows(capabilities: CapabilitiesDTO | undefined): { label: string; value: string }[] {
  if (!capabilities) return [];
  return Object.entries(capabilities).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null
      ? Object.entries(value as Record<string, unknown>).map(([inner, item]) => ({ label: `${key}.${inner}`, value: flagValue(item) }))
      : [{ label: key, value: flagValue(value) }],
  );
}

const time = (at: number) => new Date(at).toISOString();

export interface DiagnosticsSnapshot {
  status: EngineStatus;
  diagnostics: EngineDiagnostics | null;
  cacheBytes: number;
  errors: readonly EngineErrorEntry[];
  logs: readonly LogLine[];
  networkKey: string;
  now: number;
}

/**
 * The text "Copy diagnostics" and "Share diagnostics" hand over (PRD SET-08):
 * versions, state, timings, network wiring, capability flags, the recent
 * errors and the redacted log. Never keys, identity secrets or message
 * contents: errors and logs are redacted when recorded, and no call's
 * arguments are ever kept.
 */
export function diagnosticsText({ status, diagnostics, cacheBytes, errors, logs, networkKey, now }: DiagnosticsSnapshot): string {
  const { hello, info, caps, timings } = status;
  const dapi = diagnostics?.dapi;
  return [
    `Yappr ${config.appVersion} (${config.variant}, ${Platform.OS} ${Platform.Version}), commit ${config.commit ?? '?'}`,
    `engine: ${status.state}${status.reason ? ` (${status.reason})` : ''}, epoch ${status.epoch}, restarts ${status.restarts}`,
    `boot: ${timings?.bootMs ?? info?.bootMs ?? '?'} ms, wasm compile: ${diagnostics?.wasmMs ?? '?'} ms`,
    `timings: ${JSON.stringify(timings)}`,
    `network: ${info?.network ?? config.network} (${networkKey}), topology ${info?.topology ?? '?'}`,
    `evo-sdk ${info?.evoSdkVersion ?? '?'}, bundle ${hello?.bundleHash ?? '?'}`,
    `contracts: ${info ? Object.entries(info.contracts).map(([key, id]) => `${key} ${id}`).join(', ') : '?'}`,
    dapi
      ? `dapi: ${dapiEndpointCount(dapi)} endpoints (${dapi.configured} configured), last ok ${formatAgo(dapi.lastOkAt, now)}`
      : 'dapi: ?',
    ...(dapi?.endpoints ?? []).map(
      (endpoint) =>
        `  ${endpoint.origin} ${endpoint.requests} requests, ${endpoint.failures} failed, last ok ${formatAgo(endpoint.lastOkAt, now)}, last error ${formatAgo(endpoint.lastErrorAt, now)}`,
    ),
    `capabilities: ${capabilityRows(info?.capabilities).map(({ label, value }) => `${label}=${value}`).join(', ') || '?'}`,
    `webview: ${caps?.userAgent ?? '?'}, webassembly ${info?.webAssembly ?? caps?.webAssembly ?? '?'}`,
    `cache: ${formatBytes(cacheBytes)}`,
    '',
    `recent errors (${errors.length}):`,
    ...[...errors].reverse().map((error) => `${time(error.at)} ${error.operation} ${error.message}`),
    '',
    ...logs.slice(-200).map((line) => `${time(line.at)} ${line.source} ${line.level} ${line.message}`),
  ].join('\n');
}
