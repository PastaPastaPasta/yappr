import type { EngineDiagnostics } from '@engine/api';
import { Linking, Share } from 'react-native';

import { config } from '~/config';
import { getEngineErrors } from '~/engine/errors';
import { engine, engineNetworkKey, engineSupervisor } from '~/engine/index';
import { appendLog, errorMessage, getLogs } from '~/engine/logs';
import { persistedCacheBytes } from '~/state/query-client';

import { diagnosticsText } from './diagnostics';
import { SUPPORT_EMAIL } from './links';

/** The log lines a support email carries: enough for the last few minutes, short enough for a mailto link. */
const EMAIL_LOG_LINES = 40;
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

/** The redacted diagnostics text as it stands now (PRD SET-08), with the last `EMAIL_LOG_LINES` log lines. */
export async function currentDiagnosticsText(): Promise<string> {
  return diagnosticsText({
    status: engineSupervisor.getStatus(),
    diagnostics: await liveFigures(),
    cacheBytes: persistedCacheBytes(),
    errors: getEngineErrors(),
    logs: getLogs().slice(-EMAIL_LOG_LINES),
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
 * mail app to take it, the native share sheet offers the same text.
 */
export async function sendDiagnostics(): Promise<void> {
  const text = await currentDiagnosticsText();
  try {
    await Linking.openURL(diagnosticsMailUrl(text));
  } catch (error) {
    appendLog('info', 'host', `No mail app for diagnostics: ${errorMessage(error)}`);
    await Share.share({ message: text }, { subject: `Yappr diagnostics for ${SUPPORT_EMAIL}` }).catch((shareError: unknown) =>
      appendLog('warn', 'host', `Sharing diagnostics failed: ${errorMessage(shareError)}`),
    );
  }
}
