/**
 * Regenerates assets/licenses.json (./generate.js) at every prebuild, before
 * the native build bundles the JS that shows it (Settings → About →
 * Open-source licenses, PRD SET-06). The file is committed, so `expo export`
 * without a prebuild ships the same list; src/__tests__/licenses.test.ts keeps
 * the committed copy current.
 */
const { withDangerousMod } = require('expo/config-plugins');

const { writeLicenses } = require('./generate');

let written = false;
/** Once per prebuild, whichever platform's mods run first. */
function ensureWritten() {
  if (written) return;
  if (writeLicenses()) console.log('› Updated assets/licenses.json');
  written = true;
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withLicenses = (config) => {
  for (const platform of /** @type {const} */ (['ios', 'android'])) {
    config = withDangerousMod(config, [
      platform,
      async (cfg) => {
        ensureWritten();
        return cfg;
      },
    ]);
  }
  return config;
};

module.exports = withLicenses;
