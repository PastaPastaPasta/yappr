import lock from '../../package-lock.json';
import pkg from '../../package.json';

/**
 * ADR-001 E1: the app never depends on the Dash SDK, directly or through
 * another package. The SDK lives only in the engine bundle.
 */
describe('dependencies', () => {
  it('declares no @dashevo package', () => {
    const declared = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(declared.filter((name) => name.startsWith('@dashevo/'))).toEqual([]);
  });

  it('installs no @dashevo package transitively', () => {
    const installed = Object.keys(lock.packages);
    expect(installed.filter((p) => /(^|\/)node_modules\/@dashevo\//.test(p))).toEqual([]);
  });
});
