import { pickWalletUri, WALLET_PROBE_URLS, walletHandlesSignIn, type WalletCarrierUri } from './wallet-uri';

const dashKey: WalletCarrierUri = { carrier: 'dash-key', uri: 'dash-key:abc?n=t&v=2' };
const dashpay: WalletCarrierUri = { carrier: 'dashpay', uri: 'dashpay://connect?v=2&n=t&r=abc' };

describe('pickWalletUri', () => {
  it('opens the only carrier a build offers, installed or not', () => {
    expect(pickWalletUri([dashpay], {})).toBe(dashpay.uri);
    expect(pickWalletUri([dashpay], { 'dash-key': true })).toBe(dashpay.uri);
    expect(pickWalletUri([dashKey], { dashpay: true })).toBe(dashKey.uri);
  });

  it('prefers the one scheme an installed wallet handles', () => {
    expect(pickWalletUri([dashKey, dashpay], { dashpay: true, 'dash-key': false })).toBe(dashpay.uri);
    expect(pickWalletUri([dashKey, dashpay], { dashpay: false, 'dash-key': true })).toBe(dashKey.uri);
  });

  it('falls back to dash-key: when neither, both or no answer says installed', () => {
    expect(pickWalletUri([dashKey, dashpay], {})).toBe(dashKey.uri);
    expect(pickWalletUri([dashKey, dashpay], { dashpay: false, 'dash-key': false })).toBe(dashKey.uri);
    expect(pickWalletUri([dashKey, dashpay], { dashpay: true, 'dash-key': true })).toBe(dashKey.uri);
  });

  it('has nothing to open without a request', () => {
    expect(pickWalletUri([], { dashpay: true })).toBeNull();
  });

  it('probes the schemes the app declares', () => {
    expect(WALLET_PROBE_URLS).toEqual({ dashpay: 'dashpay://connect', 'dash-key': 'dash-key:yappr' });
  });
});

describe('walletHandlesSignIn', () => {
  it('counts only dash-key: for the legacy key exchange', () => {
    expect(walletHandlesSignIn({ 'dash-key': true }, 'legacy', 'testnet')).toBe(true);
    expect(walletHandlesSignIn({ dashpay: true }, 'legacy', 'testnet')).toBe(false);
  });

  it('counts either carrier for App Connect off mainnet', () => {
    expect(walletHandlesSignIn({ dashpay: true }, 'app-connect', 'testnet')).toBe(true);
    expect(walletHandlesSignIn({ 'dash-key': true }, 'app-connect', 'devnet')).toBe(true);
    expect(walletHandlesSignIn({}, 'app-connect', 'testnet')).toBe(false);
  });

  it('counts only dashpay://connect for App Connect on mainnet', () => {
    expect(walletHandlesSignIn({ dashpay: true }, 'app-connect', 'mainnet')).toBe(true);
    expect(walletHandlesSignIn({ 'dash-key': true }, 'app-connect', 'mainnet')).toBe(false);
  });
});
