/**
 * The open-source licenses list (PRD SET-06: "a native list generated at build
 * time"): every third-party package the app ships, with its license and the
 * license texts the package carries, written to assets/licenses.json for
 * Settings → About → Open-source licenses.
 *
 * What ships comes from two places:
 *   - mobile/app/package-lock.json, the React Native app: its production
 *     tree. An entry counts unless npm marks it dev-only or optional, or it is
 *     a platform binary (`os` / `cpu`: build tools such as esbuild, never in
 *     the app). Entries outside `node_modules/` are this repository's own code.
 *   - the root package-lock.json, the web's: only the packages the engine
 *     bundles into the scripts the app carries in its WebView, which
 *     mobile/engine/build.mjs reads from esbuild's metafiles into
 *     mobile/engine/bundled-packages.json. Not the whole web tree (Next.js,
 *     Tailwind...), which the app never ships, so a web-only dependency bump
 *     leaves this list alone.
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
/** Written by the engine build (see the header). */
const ENGINE_PACKAGES = 'mobile/engine/bundled-packages.json';

/** Top-level files that hold a package's license or notices: LICENSE, LICENCE.md, LICENSE-MIT, COPYING, NOTICE... */
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.\-_].*)?$/i;

/**
 * Packages whose published metadata names no license. Each one is checked by
 * hand against its source; a new package without one fails the generator
 * until it is added here. `text` (a file in ./texts) is the license with its
 * copyright notice, for a package that ships none of its own.
 */
const LICENSE_OVERRIDES = {
  // Built from github.com/dashpay/platform, MIT (LICENSE.md: Copyright (c) 2017-2021 Dash Core Group, Inc.).
  '@dashevo/evo-sdk': { license: 'MIT', text: 'dashpay-platform.LICENSE.md' },
  '@dashevo/wasm-sdk': { license: 'MIT', text: 'dashpay-platform.LICENSE.md' },
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

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** A lockfile entry, as a package to list. */
function lockPackage(projectDir, key, entry) {
  const name = entry.name ?? key.slice(key.lastIndexOf(NODE_MODULES) + NODE_MODULES.length);
  return { dir: path.join(projectDir, key), name, version: entry.version, license: licenseOf(entry) };
}

/** The app's production packages (see the header). */
function appPackages(appDir) {
  const lock = readJson(path.join(appDir, 'package-lock.json'));
  return Object.entries(lock.packages)
    .filter(([key]) => key.includes(NODE_MODULES))
    .filter(([, entry]) => !(entry.dev || entry.devOptional || entry.optional || entry.link || entry.os || entry.cpu))
    .map(([key, entry]) => lockPackage(appDir, key, entry));
}

/** The packages the engine bundles, resolved in the root lockfile (see the header). */
function enginePackages(rootDir) {
  const lock = readJson(path.join(rootDir, 'package-lock.json'));
  return readJson(path.join(rootDir, ENGINE_PACKAGES)).packages.map((key) => {
    const entry = lock.packages[key];
    if (!entry) {
      throw new Error(`${key} (${ENGINE_PACKAGES}) is not in the root package-lock.json. Rebuild the engine with --update-packages.`);
    }
    return lockPackage(rootDir, key, entry);
  });
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
  for (const pkg of [...appPackages(appDir), ...enginePackages(rootDir)]) {
    const id = `${pkg.name}@${pkg.version}`;
    const override = LICENSE_OVERRIDES[pkg.name];
    const texts = licenseTexts(pkg.dir, id);
    if (texts.length === 0 && override?.text) {
      texts.push(normalizeText(fs.readFileSync(path.join(__dirname, 'texts', override.text), 'utf8')));
    }
    const seen = byId.get(id);
    if (seen) {
      for (const text of texts) if (!seen.texts.includes(text)) seen.texts.push(text);
      continue;
    }
    const license = pkg.license ?? licenseOf(readJson(path.join(pkg.dir, 'package.json'))) ?? override?.license;
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
