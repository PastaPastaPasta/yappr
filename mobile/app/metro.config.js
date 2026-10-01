// @ts-check
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '../..');
const repo = repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const config = getDefaultConfig(projectRoot);

// Watch the whole repo so allow-listed pure modules in ../../lib can be bundled
// through the `@/` alias (tsconfig paths: `@/*` -> repo root, as on web).
config.watchFolders = [repoRoot];

// Every package resolves from mobile/app/node_modules, never from the web's
// root node_modules, so a lib/ import cannot silently pull web dependencies.
config.resolver.nodeModulesPaths = [path.join(projectRoot, 'node_modules')];
config.resolver.blockList = [
  ...[config.resolver.blockList ?? []].flat(),
  // Any node_modules outside mobile/app (the web's, vendor/*'s, other worktrees').
  new RegExp(`^${repo}/(?!mobile/app/)(.*/)?node_modules/`),
  // Web build output, git metadata, nested worktrees and test artifacts.
  new RegExp(`^${repo}/(\\.git|\\.next|out|worktrees|\\.claude|test-results|playwright-report)/`),
  // Generated native projects (CNG); Metro never needs them.
  new RegExp(`^${repo}/mobile/app/(ios|android)/`),
];

module.exports = withNativeWind(config, { input: './src/global.css' });
