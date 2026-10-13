/**
 * Tombstones the public posts and replies test identities wrote on the social
 * contract, so batteries and e2e runs leave nothing on the timeline (the
 * library is scripts/test-content-cleanup.mjs; docs/TESTING.md "Test content
 * on the public timeline"). Each identity signs its own tombstones and pays
 * for them; the maker and the contract's owner are refused. Prints no key
 * material.
 *
 *   NETWORK=devnet node scripts/clean-test-content.mjs --plan --bots 0,1,2,3 --ci-pool
 *     read-only: what would be tombstoned, and who wrote the newest live posts
 *     on the `timeline` index (test identities flagged)
 *   NETWORK=devnet node scripts/clean-test-content.mjs --live --ci-pool --since 2026-10-13T00:00:00Z
 *
 * Identities (one or both):
 *   --bots <i,j,…>   battery bots: seed index i of E2E_SEED_PHRASE (env or .env.local),
 *                    its CRITICAL key, as the batteries' `--bot` flags derive them.
 *                    `i:<id>` names the identity; otherwise it is entry i of
 *                    DEVNET_IDENTITY_IDS (and, off devnet, of E2E_IDENTITY_IDS). On
 *                    devnet the E2E_IDENTITY_IDS of .env.devnet is the CI pool,
 *                    another seed, so it is never used here.
 *   --ci-pool [n]    the e2e CI pool: the first n (default all) of E2E_IDENTITY_IDS
 *                    (.env.devnet under NETWORK=devnet, or E2E_ENV_FILE), signed with the
 *                    HIGH key of the seed the e2e fixtures get, E2E_DEVNET_SEED_PHRASE on
 *                    devnet (E2E_SEED_PHRASE elsewhere), from the env or .env.local
 * Every derived key is checked against the identity on chain before it signs.
 * Options:
 *   --since <ms|iso> only documents created at or after it (the CI step passes its job start)
 *   --until <ms|iso> only documents created at or before it: resumes a scan the page cap cut
 *                    short (the run prints the value to pass)
 *   --contract <id>  the social contract (default NEXT_PUBLIC_YAPPR_CONTRACT_ID)
 *   --contract-file <path>  the cut it was registered from (default the env's
 *                    contracts/yappr-social-contract-<NEXT_PUBLIC_CONTRACT_TOPOLOGY>.json)
 *   --survey <n>     how many of the newest timeline posts --plan surveys (default 60)
 * The contract id, topology and maker (DEVNET_MAKER_IDENTITY_ID) come from the
 * env, then E2E_ENV_FILE, else .env.devnet under NETWORK=devnet and
 * .env.testing otherwise. Exit code 1 when a live run could not tombstone
 * something or could not read an identity's documents in full (re-run it: it
 * only ever touches what is still live).
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CRITICAL_AUTH_KEY_ID, KEY_ROLES, REPO_ROOT, deriveIdentityKeys, loadIdentityIds, loadMnemonic, readEnvFile } from './derive-identities.mjs';
import { describeErr } from './owner-keys.mjs';
import { connectSdk, network } from './sdk-env.mjs';
import { cleanTestContent, parseSince, refuseIdentities, surveyTimeline } from './test-content-cleanup.mjs';

const USAGE = 'Usage: node scripts/clean-test-content.mjs --plan|--live [--bots <i[:id],…>] [--ci-pool [n]] [--since <ms|iso>] [--until <ms|iso>] [--contract <id>] [--contract-file <path>] [--survey <n>]';
/** What 1M credits cost at $60/DASH (1 DASH = 10^11 credits), in US cents. */
const CENTS_PER_MILLION_CREDITS = 0.06;
const AUTH_HIGH_KEY_ID = KEY_ROLES.find((role) => role.purpose === 'AUTHENTICATION' && role.securityLevel === 'HIGH').keyIndex;

/** The command line, parsed without reading the environment. Throws on anything it does not know. */
export function parseArgs(argv) {
  const args = { mode: null, bots: [], ciPool: null, since: null, until: null, contract: null, contractFile: null, survey: 60 };
  const value = (i, flag) => {
    if (argv[i] === undefined || argv[i].startsWith('--')) throw new Error(`${flag} takes a value`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--plan':
      case '--live':
        if (args.mode !== null) throw new Error('pass one of --plan or --live');
        args.mode = flag.slice(2);
        break;
      case '--bots':
        args.bots = value(++i, flag).split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
          const [index, id] = entry.split(':');
          if (!/^\d+$/.test(index)) throw new Error(`--bots ${entry}: a seed index, or index:identityId`);
          return { index: Number(index), id: id || null };
        });
        break;
      case '--ci-pool':
        args.ciPool = 'all';
        if (/^\d+$/.test(argv[i + 1] ?? '')) args.ciPool = Number(argv[++i]);
        break;
      case '--since': args.since = parseSince(value(++i, flag)); break;
      case '--until': args.until = parseSince(value(++i, flag)); break;
      case '--contract': args.contract = value(++i, flag); break;
      case '--contract-file': args.contractFile = value(++i, flag); break;
      case '--survey': args.survey = Number(value(++i, flag)); break;
      default: throw new Error(`unknown argument ${flag}`);
    }
  }
  if (args.mode === null) throw new Error('pass --plan (read-only) or --live');
  if (args.since !== null && args.until !== null && args.until < args.since) throw new Error('--until must not be earlier than --since');
  if (args.bots.length === 0 && args.ciPool === null) throw new Error('name the identities: --bots <i,…> and/or --ci-pool [n]');
  if (args.ciPool === 0) throw new Error('--ci-pool takes a slot count of at least 1');
  if (!Number.isInteger(args.survey) || args.survey < 1 || args.survey > 100) throw new Error('--survey takes 1–100');
  return args;
}

/** A setting from the env, then the deployment's env file (E2E_ENV_FILE, else .env.devnet on devnet, .env.testing otherwise). */
function setting(name) {
  if (process.env[name]?.trim()) return process.env[name].trim();
  const file = process.env.E2E_ENV_FILE?.trim() || (network() === 'devnet' ? '.env.devnet' : '.env.testing');
  return readEnvFile(join(REPO_ROOT, file))[name] || null;
}

const splitIds = (raw) => (raw ?? '').split(',').map((id) => id.trim()).filter(Boolean);

/** The identities to clean, with their signing keys when the run is live (a plan needs no seed). */
function identitiesOf(args) {
  const live = args.mode === 'live';
  const out = [];
  if (args.bots.length > 0) {
    const pool = splitIds(process.env.DEVNET_IDENTITY_IDS);
    const ids = pool.length > 0 || network() === 'devnet' ? pool : loadIdentityIds();
    const mnemonic = live ? loadMnemonic() : null;
    for (const { index, id } of args.bots) {
      const identityId = id ?? ids[index];
      if (!identityId) throw new Error(`--bots ${index}: no identity id (name it as ${index}:<id>, or set DEVNET_IDENTITY_IDS)`);
      // The batteries sign with the CRITICAL authentication key (verify-lib botSigner).
      out.push(keyed({ id: identityId, label: `bot${index}` }, index, mnemonic, CRITICAL_AUTH_KEY_ID));
    }
  }
  if (args.ciPool !== null) {
    const pool = loadIdentityIds();
    if (pool.length === 0) throw new Error('--ci-pool: E2E_IDENTITY_IDS is empty');
    const mnemonic = live ? loadMnemonic(network() === 'devnet' ? 'E2E_DEVNET_SEED_PHRASE' : 'E2E_SEED_PHRASE') : null;
    // The e2e fixtures sign with the HIGH one (e2e/fixtures/auth.ts), so that is the key the pool is known to hold.
    pool.slice(0, args.ciPool === 'all' ? pool.length : args.ciPool)
      .forEach((identityId, index) => out.push(keyed({ id: identityId, label: `ci${index}` }, index, mnemonic, AUTH_HIGH_KEY_ID)));
  }
  return out;
}

/** `who` with its authentication key `keyId` (seed index `index` of `mnemonic`), checked against the chain before signing. */
function keyed(who, index, mnemonic, keyId) {
  if (!mnemonic) return who;
  const key = deriveIdentityKeys(index, mnemonic).find((k) => k.keyIndex === keyId);
  return { ...who, keyId, wif: key.wif, publicKeyHex: key.publicKeyHex };
}

async function main(argv) {
  const args = parseArgs(argv);
  const contractId = args.contract ?? setting('NEXT_PUBLIC_YAPPR_CONTRACT_ID');
  if (!contractId) throw new Error('no social contract: pass --contract or set NEXT_PUBLIC_YAPPR_CONTRACT_ID');
  const file = args.contractFile ?? `contracts/yappr-social-contract-${setting('NEXT_PUBLIC_CONTRACT_TOPOLOGY') ?? 'v2'}.json`;
  const contract = JSON.parse(readFileSync(isAbsolute(file) ? file : join(REPO_ROOT, file), 'utf8'));
  const maker = setting('DEVNET_MAKER_IDENTITY_ID');
  const identities = identitiesOf(args);
  refuseIdentities(identities, [maker]);

  let sdk = await connectSdk();
  const reconnect = async () => {
    try {
      await sdk.disconnect?.();
    } catch {
      // The instance being replaced is dead already.
    }
    sdk = await connectSdk();
    return sdk;
  };
  console.log(JSON.stringify({ network: network(), contract: contractId, contractFile: file, mode: args.mode, since: args.since === null ? null : new Date(args.since).toISOString(), identities: identities.map(({ id, label }) => ({ label, id })) }));
  if (args.mode === 'plan') {
    const survey = await surveyTimeline({ sdk, contractId, identities, others: maker ? { [maker]: 'maker' } : {}, limit: args.survey, reconnect });
    console.log(JSON.stringify({ newestTimelinePosts: survey }));
  }
  const summary = await cleanTestContent({ sdk, contractId, contract, identities, since: args.since, until: args.until, live: args.mode === 'live', refuse: [maker], reconnect });
  const cents = Number(summary.spentCredits) * CENTS_PER_MILLION_CREDITS / 1e6;
  console.log(JSON.stringify({ ...summary, spentCentsAt60UsdPerDash: Number(cents.toFixed(3)) }, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 1));
  return summary.failed === 0 && summary.incomplete === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(describeErr(e).split(' | ')[0].replace(/^message=/, ''));
    console.error(USAGE);
    process.exit(1);
  });
}
