/**
 * Lets the app ask whether a Dash wallet is installed (PRD AUTH-05):
 * `Linking.canOpenURL('dash-key:…')` answers only for schemes the app
 * declares, in LSApplicationQueriesSchemes on iOS and in <queries> on
 * Android 11+. Without them both platforms always say "no wallet".
 */
const { withAndroidManifest, withInfoPlist } = require('expo/config-plugins');

/** Wallet sign-in (`dash-key:`) and key registration (`dash-st:`). */
const WALLET_SCHEMES = ['dash-key', 'dash-st'];

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withWalletSchemes = (config) => {
  config = withInfoPlist(config, (mod) => {
    const declared = mod.modResults.LSApplicationQueriesSchemes ?? [];
    mod.modResults.LSApplicationQueriesSchemes = [...new Set([...declared, ...WALLET_SCHEMES])];
    return mod;
  });
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const intents = WALLET_SCHEMES.map((scheme) => ({
      action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
      data: [{ $: { 'android:scheme': scheme } }],
    }));
    const [first = {}, ...rest] = manifest.queries ?? [];
    manifest.queries = [{ ...first, intent: [...(first.intent ?? []), ...intents] }, ...rest];
    return mod;
  });
};

module.exports = withWalletSchemes;
