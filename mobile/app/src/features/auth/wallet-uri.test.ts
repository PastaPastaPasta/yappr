import { pickWalletUri, WALLET_PROBE_URLS, type WalletCarrierUri } from './wallet-uri';

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
