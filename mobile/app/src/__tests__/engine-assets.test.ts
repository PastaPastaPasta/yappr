import fs from 'fs';
import buildConfig from '../../../engine/build-config.cjs';
import { engineExtra } from '../../plugins/engine-assets';

jest.mock('fs', () => ({ existsSync: jest.fn(), readFileSync: jest.fn() }));
jest.mock('expo/config-plugins', () => ({}));
jest.mock('../../../engine/build-config.cjs', () => ({ variantConfig: jest.fn() }));

const expected = {
  env: { NEXT_PUBLIC_NETWORK: 'testnet', NEXT_PUBLIC_STORAGE_SCOPE: '', NEXT_PUBLIC_BASE_PATH: '' },
  storageEpoch: 'release-1',
  webBasePath: '/staging',
  networkKey: 'testnet-release-1-staging',
};
const manifest = { ...expected, variant: 'staging-testnet', sha256: 'bundle-hash', topology: 'v17' };

beforeEach(() => {
  jest.mocked(buildConfig.variantConfig).mockReturnValue(expected);
  jest.mocked(fs.existsSync).mockReturnValue(true);
  jest.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(manifest));
});

it('publishes the validated engine hash and native storage namespace', () => {
  expect(engineExtra('staging-testnet')).toMatchObject({ bundleHash: 'bundle-hash', networkKey: expected.networkKey });
});

it.each(['variant', 'env', 'storageEpoch', 'webBasePath', 'networkKey'])('rejects mismatched %s, even when reusing a built engine', (field) => {
  jest.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ ...manifest, [field]: 'stale' }));
  expect(() => engineExtra('staging-testnet')).toThrow('Stale staging-testnet engine');
});

it('validates release pins before accepting an existing manifest', () => {
  jest.mocked(buildConfig.variantConfig).mockImplementation(() => { throw new Error('Incomplete release configuration'); });
  expect(() => engineExtra('testnet')).toThrow('Incomplete release configuration');
});
