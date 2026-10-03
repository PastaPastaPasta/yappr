/**
 * The open-source licenses list (PRD SET-06: "a native list generated at build
 * time"): every third-party package the app ships, with its license and the
 * license texts the package carries, written to assets/licenses.json for
 * Settings → About → Open-source licenses.
 *
 * What ships is the production dependency tree of two lockfiles:
 *   - mobile/app/package-lock.json: the React Native app;
 *   - the root package-lock.json: the web's lib/ and its packages, which the
 *     engine bundles and the app carries inside its WebView.
 * A lockfile entry counts unless npm marks it dev-only or optional, or it is
 * a platform binary (`os` / `cpu`: build tools such as esbuild, never in the
 * app). Entries outside `node_modules/` are this repository's own code.
 *
 * Deterministic: the same lockfiles and installs give the same file, sorted
 * by name and version, the texts deduplicated in order of first use. The
 * config plugin (./index.js) regenerates it at every prebuild;
 * src/__tests__/licenses.test.ts fails while the committed file is stale.
 *
 *   node plugins/licenses/generate.js           write assets/licenses.json
 *   node plugins/licenses/generate.js --check   exit 1 if it is out of date
 */
const fs = require('fs');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '../..');
const ROOT_DIR = path.resolve(APP_DIR, '../..');
const OUTPUT = path.join(APP_DIR, 'assets/licenses.json');

/** Top-level files that hold a package's license or notices: LICENSE, LICENCE.md, LICENSE-MIT, COPYING, NOTICE... */
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.\-_].*)?$/i;

/**
 * Packages whose published metadata names no license. Each one is checked by
 * hand against its source; a new package without one fails the generator
 * until it is added here.
 */
const LICENSE_OVERRIDES = {
  // Built from github.com/dashpay/platform, MIT (LICENSE.md: Copyright (c) 2017-2021 Dash Core Group, Inc.).
  '@dashevo/evo-sdk': 'MIT',
  '@dashevo/wasm-sdk': 'MIT',
};

const NODE_MODULES = 'node_modules/';

/** `license`, or the legacy `licenses` array, of a lockfile entry or package.json. */
function licenseOf(manifest) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (manifest.license && typeof manifest.license.type === 'string') return manifest.license.type;
  if (Array.isArray(manifest.licenses) && manifest.licenses.length > 0) {
    return manifest.licenses.map((item) => (typeof item === 'string' ? item : item.type)).join(' OR ');
  }
  return null;
}

const normalizeText = (text) => text.replace(/\r\n?/g, '\n').trim();

/** The production packages of one lockfile (see the header). */
function productionPackages(projectDir) {
  const lock = JSON.parse(fs.readFileSync(path.join(projectDir, 'package-lock.json'), 'utf8'));
  const packages = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.includes(NODE_MODULES)) continue;
    if (entry.dev || entry.devOptional || entry.optional || entry.link || entry.os || entry.cpu) continue;
    const name = entry.name ?? key.slice(key.lastIndexOf(NODE_MODULES) + NODE_MODULES.length);
    packages.push({ dir: path.join(projectDir, key), name, version: entry.version, license: licenseOf(entry) });
  }
  return packages;
}

/** The package's license texts, read from its install. */
function licenseTexts(dir, id) {
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    throw new Error(`${id} is in the lockfile but not installed at ${dir}. Run npm ci first.`);
  }
  return fs
    .readdirSync(dir)
    .filter((file) => LICENSE_FILE.test(file) && fs.statSync(path.join(dir, file)).isFile())
    .sort()
    .map((file) => normalizeText(fs.readFileSync(path.join(dir, file), 'utf8')))
    .filter(Boolean);
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * @param {{ appDir?: string; rootDir?: string }} [dirs]
 * @returns {{ packages: { name: string; version: string; license: string; texts: number[] }[]; texts: string[] }}
 */
function generateLicenses({ appDir = APP_DIR, rootDir = ROOT_DIR } = {}) {
  const byId = new Map();
  for (const pkg of [...productionPackages(appDir), ...productionPackages(rootDir)]) {
    const id = `${pkg.name}@${pkg.version}`;
    const texts = licenseTexts(pkg.dir, id);
    const seen = byId.get(id);
    if (seen) {
      for (const text of texts) if (!seen.texts.includes(text)) seen.texts.push(text);
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg.dir, 'package.json'), 'utf8'));
    const license = pkg.license ?? licenseOf(manifest) ?? LICENSE_OVERRIDES[pkg.name];
    if (!license) throw new Error(`${id} names no license. Check its source and add it to LICENSE_OVERRIDES.`);
    byId.set(id, { name: pkg.name, version: pkg.version, license, texts });
  }

  const sorted = [...byId.values()].sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version));
  const texts = [];
  const index = new Map();
  const packages = sorted.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license,
    texts: pkg.texts.map((text) => {
      if (!index.has(text)) {
        index.set(text, texts.length);
        texts.push(text);
      }
      return index.get(text);
    }),
  }));
  return { packages, texts };
}

const serialize = (licenses) => `${JSON.stringify(licenses, null, 2)}\n`;

/** Writes assets/licenses.json when it changed; returns whether it did. */
function writeLicenses(output = OUTPUT) {
  const next = serialize(generateLicenses());
  if (fs.existsSync(output) && fs.readFileSync(output, 'utf8') === next) return false;
  fs.writeFileSync(output, next);
  return true;
}

module.exports = { generateLicenses, serialize, writeLicenses, OUTPUT };

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const fresh = fs.existsSync(OUTPUT) && fs.readFileSync(OUTPUT, 'utf8') === serialize(generateLicenses());
    if (!fresh) {
      console.error('assets/licenses.json is out of date. Run: npm run licenses');
      process.exit(1);
    }
  } else {
    console.log(writeLicenses() ? 'Wrote assets/licenses.json' : 'assets/licenses.json is up to date');
  }
}
