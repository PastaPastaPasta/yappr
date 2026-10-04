import type { EngineDiagnostics } from '@engine/api';
import { Linking, Share } from 'react-native';

import { config } from '~/config';
import { getEngineErrors } from '~/engine/errors';
import { engine, engineNetworkKey, engineSupervisor } from '~/engine/index';
import { appendLog, errorMessage, getLogs } from '~/engine/logs';
import { persistedCacheBytes } from '~/state/query-client';

import { copy } from './copy';
import { diagnosticsText, type DiagnosticsSnapshot } from './diagnostics';
import { SUPPORT_EMAIL } from './links';

/** The log lines a support email carries: enough for the last few minutes, short enough for a mailto link. */
export const EMAIL_LOG_LINES = 40;
/** The newest engine errors a support email carries; Troubleshooting's "Copy diagnostics" has all of them. */
export const EMAIL_ERRORS = 10;
/** Each error's message is clipped too (a recorded one may run to 2,000 characters). */
const EMAIL_ERROR_CHARS = 300;
/**
 * The longest body a support email carries. Mail apps truncate or drop a long
 * mailto body without failing the link, so the share-sheet fallback would
 * never run: the oldest log lines go first, then the tail is cut.
 */
export const EMAIL_MAX_CHARS = 5000;
/** How long the engine's live figures (WASM, DAPI) may hold the email up; without them the text still goes. */
const LIVE_FIGURES_MS = 2000;

async function liveFigures(): Promise<EngineDiagnostics | null> {
  const { state } = engineSupervisor.getStatus();
  if (state !== 'ready' && state !== 'degraded') return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LIVE_FIGURES_MS);
  });
  try {
    return await Promise.race([engine.api.engine.diagnostics().catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The diagnostics text sized for a mail body: the newest `EMAIL_ERRORS`
 * errors (each clipped) and `EMAIL_LOG_LINES` log lines, within `EMAIL_MAX_CHARS`.
 */
export function emailDiagnosticsText(snapshot: DiagnosticsSnapshot): string {
  const errors = snapshot.errors
    .slice(-EMAIL_ERRORS)
    .map((error) => (error.message.length > EMAIL_ERROR_CHARS ? { ...error, message: `${error.message.slice(0, EMAIL_ERROR_CHARS)}…` } : error));
  let logs = snapshot.logs.slice(-EMAIL_LOG_LINES);
  let text = diagnosticsText({ ...snapshot, errors, logs });
  while (text.length > EMAIL_MAX_CHARS && logs.length > 0) {
    logs = logs.slice(1);
    text = diagnosticsText({ ...snapshot, errors, logs });
  }
  return text.length > EMAIL_MAX_CHARS ? `${text.slice(0, EMAIL_MAX_CHARS - 1)}…` : text;
}

/** The redacted diagnostics text as it stands now (PRD SET-08), sized for a mail body. */
async function currentDiagnosticsText(): Promise<string> {
  return emailDiagnosticsText({
    status: engineSupervisor.getStatus(),
    diagnostics: await liveFigures(),
    cacheBytes: persistedCacheBytes(),
    errors: getEngineErrors(),
    logs: getLogs(),
    networkKey: engineNetworkKey,
    now: Date.now(),
  });
}

/** The mail draft to support with the diagnostics as its body. */
export function diagnosticsMailUrl(text: string): string {
  const subject = encodeURIComponent(`Yappr ${config.appVersion} (${config.variant}) diagnostics`);
  return `mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${encodeURIComponent(text)}`;
}

/**
 * About → Support → "Send diagnostics" (PRD SET-06, SET-08): a mail to the
 * support address (PRD §11.1 OQ-1) with the redacted diagnostics. With no
 * mail app to take it, the native share sheet offers the same text, led by
 * the support address so a message or note still says where it goes.
 */
export async function sendDiagnostics(): Promise<void> {
  const text = await currentDiagnosticsText();
  try {
    await Linking.openURL(diagnosticsMailUrl(text));
  } catch (error) {
    appendLog('info', 'host', `No mail app for diagnostics: ${errorMessage(error)}`);
    const message = `${copy.about.sendDiagnosticsTo(SUPPORT_EMAIL)}\n\n${text}`;
    await Share.share({ message }, { subject: `Yappr diagnostics for ${SUPPORT_EMAIL}` }).catch((shareError: unknown) =>
      appendLog('warn', 'host', `Sharing diagnostics failed: ${errorMessage(shareError)}`),
    );
  }
}
