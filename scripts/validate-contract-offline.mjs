/**
 * Offline full-validation parse of a contract JSON against the installed
 * wasm DPP — no network, no keys, no broadcast.
 *
 * This is the cheap gate that a `contracts/*.json` file would actually be
 * ACCEPTED at registration: `DataContract.fromJSON(json, true, <latest>)` runs
 * the same structural parser and meta-schema validation the chain runs, so a
 * grammar mistake (a bad `propertyAgreement` pair, an `immutable` entry naming
 * a system field, a `rangeCountable`/`countable` contradiction) fails here
 * rather than after a funded state transition.
 *
 * The `id`/`ownerId` are placeholders: neither participates in schema
 * validation, and nothing is signed or published.
 *
 * Run:
 *   node scripts/validate-contract-offline.mjs contracts/yappr-social-contract-v7.json
 *   node scripts/validate-contract-offline.mjs <file> --immutable post,reply
 */
import { readFileSync } from 'node:fs';
import { DataContract, PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk';

/** Any valid 32-byte identifier; schema validation never looks at it. */
const PLACEHOLDER_ID = '11111111111111111111111111111111';

function parseArgs(argv) {
  const flagIndex = argv.indexOf('--immutable');
  const immutable = flagIndex === -1 ? [] : (argv[flagIndex + 1] ?? '').split(',').filter(Boolean);
  // Skip the flag AND its value, so `--immutable post,reply <file>` does not
  // resolve the positional to "post,reply".
  const file = argv.find((arg, index) => !arg.startsWith('--') && index !== flagIndex + 1);
  if (!file) throw new Error('usage: node scripts/validate-contract-offline.mjs <contract.json> [--immutable a,b]');
  return { file, immutable };
}

async function main() {
  // The wasm module backs every class below; nothing works before it loads.
  await ensureInitialized();
  const { file, immutable } = parseArgs(process.argv.slice(2));
  const source = JSON.parse(readFileSync(file, 'utf8'));
  const platformVersion = PlatformVersion.latest();

  // The same assembly `scripts/register-social-v3-draft.mjs` publishes with.
  const json = {
    $formatVersion: source.$formatVersion ?? '1',
    id: PLACEHOLDER_ID,
    ownerId: PLACEHOLDER_ID,
    version: source.version ?? 1,
    documentSchemas: source.documentSchemas,
    ...(source.config ? { config: source.config } : {}),
    ...(source.tokens ? { tokens: source.tokens } : {}),
  };

  const contract = DataContract.fromJSON(json, true, platformVersion);
  console.log(`OK  ${file} parses under FULL validation`);
  console.log(`    platform version: ${platformVersion.version} (${platformVersion.__type})`);
  console.log(`    document types:   ${Object.keys(source.documentSchemas).length}`);

  // `documentImmutableProperties` is a Map of every type that freezes
  // something; it is empty below protocol 14 even when the raw schema carries
  // the keywords, so a non-empty map is itself the protocol-14 proof.
  console.log(`    freezing types:   ${[...contract.documentImmutableProperties.keys()].join(', ') || '(none)'}`);
  for (const documentType of immutable) {
    console.log(`    ${documentType}: ${JSON.stringify(contract.documentTypeImmutableProperties(documentType))}`);
  }
}

try {
  await main();
} catch (error) {
  // WASM rejections arrive as objects whose useful text is on `message`; the
  // default uncaught-exception dump would print the minified bundle instead.
  console.error(`FAIL  ${error?.message ?? error}`);
  if (error?.code !== undefined) console.error(`      consensus code: ${error.code}`);
  process.exit(1);
}
