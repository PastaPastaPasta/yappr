import { config, resolveAppConfig } from './config';

describe('resolveAppConfig', () => {
  it('derives the variant and network from the application id', () => {
    expect(resolveAppConfig('pr.yap.app.beta', { variant: 'testnet' }, '1.2.3')).toEqual({
      variant: 'testnet',
      network: 'testnet',
      scheme: 'yappr-beta',
      webBasePath: '',
      applicationId: 'pr.yap.app.beta',
      appVersion: '1.2.3',
      engine: null,
      commit: null,
    });
  });

  it('carries the commit baked in at build time (SET-06)', () => {
    const sha = '3d328f5c0123456789abcdef0123456789abcdef';
    expect(resolveAppConfig('pr.yap.app.beta', { variant: 'testnet', commit: sha }, '1.2.3').commit).toBe(sha);
    expect(resolveAppConfig('pr.yap.app.beta', { variant: 'testnet', commit: 42 }, '1.2.3').commit).toBeNull();
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
