/**
 * Ships the engine bundle (mobile/engine/dist/<variant>) inside the app
 * (ENGINE.md §2.3; src/engine/page.ts says how each platform loads it).
 *
 * At prebuild it builds the engine for the app's variant (skip with
 * YAPPR_ENGINE_SKIP_BUILD=1 when dist/ is already built) and copies engine.js
 * and its sidecars (engine.wasm.js, engine.avatars.js):
 *   iOS      into <app>/engine/, a folder reference in Copy Bundle Resources,
 *            with index.html: engine.html plus the host's CSP (src/engine/csp.json)
 *   Android  into app/src/main/assets/engine/
 *
 * app.config.ts also calls `engineExtra()` so the JS bundle knows the engine
 * it was built against (`config.engine`): its hash busts the persisted query
 * cache, and the network key names the storage namespaces.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { IOSConfig, withDangerousMod, withXcodeProject } = require('expo/config-plugins');

const ENGINE_DIR = path.resolve(__dirname, '../../../engine');
const FOLDER = 'engine';

const FILES = ['engine.js', 'engine.wasm.js', 'engine.avatars.js', 'manifest.json'];
const CSP = require('../../src/engine/csp.json').policy;

/** @param {string} engineVariant */
const distDir = (engineVariant) => path.join(ENGINE_DIR, 'dist', engineVariant);

/**
 * The engine variant for an app variant. There is no mainnet engine yet;
 * production builds are refused by app.config.ts until there is.
 * @param {string} appVariant
 */
const engineVariantFor = (appVariant) => (appVariant === 'production' ? 'mainnet' : appVariant);

/**
 * What the app needs to know about the engine it ships, from the built
 * manifest; null when the engine has not been built (Jest, a fresh clone).
 * @param {string} appVariant
 */
function engineExtra(appVariant) {
  const file = path.join(distDir(engineVariantFor(appVariant)), 'manifest.json');
  if (!fs.existsSync(file)) return null;
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const network = manifest.env.NEXT_PUBLIC_NETWORK ?? 'testnet';
  return {
    bundleHash: manifest.sha256,
    evoSdkVersion: manifest.evoSdkVersion,
    builtAt: manifest.builtAt,
    network,
    // The storage namespace (ENGINE.md §9.1): a renamed or wiped devnet starts empty.
    networkKey: network === 'devnet' ? `devnet-${manifest.env.NEXT_PUBLIC_DEVNET_NAME ?? 'unnamed'}` : network,
    topology: manifest.topology,
    // Dev only: serve dist/<variant> (npm run engine:serve) and the app reads the engine from there.
    // Omitted rather than null: a null in `extra` reaches the app as `{}`.
    ...(process.env.YAPPR_ENGINE_DEV_URL ? { devUrl: process.env.YAPPR_ENGINE_DEV_URL } : {}),
  };
}

let built = false;
/** @param {string} engineVariant */
function ensureBuilt(engineVariant) {
  if (built) return;
  if (process.env.YAPPR_ENGINE_SKIP_BUILD === '1') {
    if (!fs.existsSync(path.join(distDir(engineVariant), 'manifest.json'))) {
      throw new Error(`YAPPR_ENGINE_SKIP_BUILD=1 but ${distDir(engineVariant)} is not built.`);
    }
  } else {
    execFileSync(process.execPath, [path.join(ENGINE_DIR, 'build.mjs'), '--variant', engineVariant], {
      stdio: 'inherit',
    });
  }
  built = true;
}

/**
 * @param {string} engineVariant
 * @param {string} target
 */
function copyEngine(engineVariant, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const name of FILES) fs.copyFileSync(path.join(distDir(engineVariant), name), path.join(target, name));
}

/**
 * iOS loads the page by file URL, so the CSP has to be in it, first in <head>
 * (Android's loader page carries its own).
 * @param {string} engineVariant
 * @param {string} target
 */
function writeIosPage(engineVariant, target) {
  const html = fs.readFileSync(path.join(distDir(engineVariant), 'engine.html'), 'utf8');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
  if (!html.includes('<head>')) throw new Error('engine.html has no <head>');
  fs.writeFileSync(path.join(target, 'index.html'), html.replace('<head>', () => `<head>${meta}`));
}

/** @param {{ modRequest: { projectName?: string; projectRoot: string } }} cfg */
const iosProjectName = (cfg) =>
  cfg.modRequest.projectName ?? IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);

/** @type {import('expo/config-plugins').ConfigPlugin<{ variant: string }>} */
const withEngineAssets = (config, { variant }) => {
  const engineVariant = engineVariantFor(variant);

  config = withDangerousMod(config, [
    'ios',
    async (cfg) => {
      ensureBuilt(engineVariant);
      const target = path.join(cfg.modRequest.platformProjectRoot, iosProjectName(cfg), FOLDER);
      copyEngine(engineVariant, target);
      writeIosPage(engineVariant, target);
      return cfg;
    },
  ]);

  config = withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const projectName = iosProjectName(cfg);
    const filepath = `${projectName}/${FOLDER}`;
    if (!project.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addResourceFileToGroup({ filepath, groupName: projectName, project, isBuildFile: true });
      // A folder reference (not a group) keeps engine/ a directory inside the .app.
      for (const ref of Object.values(project.pbxFileReferenceSection())) {
        if (typeof ref !== 'object' || String(ref.path).replace(/^"|"$/g, '') !== filepath) continue;
        ref.lastKnownFileType = 'folder';
        delete ref.fileEncoding;
        delete ref.explicitFileType;
      }
    }
    return cfg;
  });

  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      ensureBuilt(engineVariant);
      copyEngine(engineVariant, path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/assets', FOLDER));
      return cfg;
    },
  ]);

  return config;
};

module.exports = withEngineAssets;
module.exports.engineExtra = engineExtra;
