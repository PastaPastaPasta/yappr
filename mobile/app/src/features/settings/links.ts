import * as Application from 'expo-application';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { Linking } from 'react-native';

import { config } from '~/config';
import { appendLog, errorMessage } from '~/engine/logs';
import { toast } from '~/ui/toast';

import { copy } from './copy';

/** PRD §11.1 OQ-1: the support address (a placeholder the release check flags). */
export const SUPPORT_EMAIL = 'support@yap.pr';

/** This variant's yap.pr (devnet: under `/devnet`). */
const site = `https://yap.pr${config.webBasePath}`;

export const links = {
  /** The terms and privacy policy cover every network, so they come from the root site. */
  terms: 'https://yap.pr/terms',
  privacy: 'https://yap.pr/privacy',
  web: site,
  registerUsername: `${site}/dpns/register`,
  /** The source and its license; the native third-party list is generated later (PRD SET-06). */
  licenses: 'https://github.com/pastapastapasta/yappr',
};

/** "1.0.0 (123)": the version and the native build number. */
export const appVersion = Application.nativeBuildVersion
  ? `${config.appVersion} (${Application.nativeBuildVersion})`
  : config.appVersion;

/** "Yappr 1.0.0 (123) · devnet" (PRD SET-01). */
export const versionLine = `Yappr ${appVersion} · ${config.network}`;

/** Opens a page in the in-app browser (PRD SET-07). */
export function openInApp(url: string): void {
  WebBrowser.openBrowserAsync(url).catch((error: unknown) => {
    appendLog('warn', 'host', `Opening ${url} failed: ${errorMessage(error)}`);
  });
}

/** The mail composer to support; with no mail app, the address is copied instead (SAFE-05's fallback). */
export async function emailSupport(): Promise<void> {
  const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Yappr ${config.appVersion} (${config.variant})`)}`;
  try {
    await Linking.openURL(url);
  } catch {
    await Clipboard.setStringAsync(SUPPORT_EMAIL).catch(() => undefined);
    toast(copy.about.supportCopied);
  }
}
