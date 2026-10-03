import fs from 'fs';
import path from 'path';

// Tooling: the generator the prebuild runs, reading this checkout's lockfiles and installs.
import { generateLicenses, OUTPUT, serialize } from '../../plugins/licenses/generate';

const APP_DIR = path.resolve(__dirname, '../..');

describe('open-source licenses (PRD SET-06)', () => {
  const generated = generateLicenses();

  it('the committed list is the one the lockfiles give (run `npm run licenses` after a dependency change)', () => {
    expect(OUTPUT).toBe(path.join(APP_DIR, 'assets/licenses.json'));
    expect(fs.readFileSync(OUTPUT, 'utf8')).toBe(serialize(generated));
  });

  it('is deterministic: sorted, unique, every package licensed, every text used', () => {
    expect(serialize(generateLicenses())).toBe(serialize(generated));
    const ids = generated.packages.map((pkg) => `${pkg.name}@${pkg.version}`);
    expect(new Set(ids).size).toBe(ids.length);
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const sorted = [...generated.packages].sort((a, b) => cmp(a.name, b.name) || cmp(a.version, b.version));
    expect(sorted).toEqual(generated.packages);
    expect(generated.packages.every((pkg) => pkg.license.length > 0)).toBe(true);
    const used = new Set(generated.packages.flatMap((pkg) => pkg.texts));
    expect(used.size).toBe(generated.texts.length);
  });

  it('covers what the app and its engine ship, and leaves out build tools', () => {
    const names = new Set(generated.packages.map((pkg) => pkg.name));
    // The app's own production dependencies...
    const app = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const name of Object.keys(app.dependencies)) expect(names).toContain(name);
    // ...the SDK the engine bundles (no license field in its package.json; see LICENSE_OVERRIDES)...
    const sdk = generated.packages.find((pkg) => pkg.name === '@dashevo/evo-sdk');
    expect(sdk?.license).toBe('MIT');
    // ...and nothing dev-only.
    expect(names).not.toContain('jest');
    expect(names).not.toContain('eslint');
  });
});
