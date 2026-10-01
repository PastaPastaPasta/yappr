import { config, resolveAppConfig } from './config';

describe('resolveAppConfig', () => {
  it('derives the variant and network from the application id', () => {
    expect(resolveAppConfig('pr.yap.app.beta', { variant: 'testnet' }, '1.2.3')).toEqual({
      variant: 'testnet',
      network: 'testnet',
      scheme: 'yappr-beta',
      applicationId: 'pr.yap.app.beta',
      appVersion: '1.2.3',
      engine: null,
    });
  });

  it('refuses a bundle built for another variant', () => {
    expect(() => resolveAppConfig('pr.yap.app.beta', { variant: 'devnet' }, '1.0.0')).toThrow(
      /Rebuild with APP_VARIANT=testnet/,
    );
  });

  it('refuses an unknown application id', () => {
    expect(() => resolveAppConfig('com.example', { variant: 'devnet' }, '1.0.0')).toThrow(
      /Unknown application id/,
    );
    expect(() => resolveAppConfig(null, { variant: 'devnet' }, '1.0.0')).toThrow();
  });

  it('agrees with app.config.ts for the default (devnet) build', () => {
    expect(config.variant).toBe('devnet');
    expect(config.network).toBe('devnet');
  });
});
