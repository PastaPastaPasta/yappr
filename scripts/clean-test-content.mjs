/**
 * Takes down what test identities wrote on the published contracts, so
 * batteries and e2e runs leave nothing in the app (docs/TESTING.md "Test
 * content on the public devnet"). Each identity signs its own deletes and
 * tombstones and pays for them; the maker and the contract's owner are
 * refused. Prints no key material.
 *
 * `--surface social` (the default) tombstones the posts and replies of the
 * battery bots and the e2e CI pool (scripts/test-content-cleanup.mjs).
 * `--surface blog,storefront,pollr` cleans what the seed-ledger personas of the
 * feature batteries wrote on those contracts since `--since`
 * (scripts/surface-cleanup.mjs: owner deletes, the blog post tombstone, the
 * item delete, closing the stores; a blog goes only by `--moderator`'s
 * removal; what cannot go is listed as a leftover).
 *
 *   NETWORK=devnet node scripts/clean-test-content.mjs --plan --bots 0,1,2,3 --ci-pool
 *     read-only: what would be tombstoned, and who wrote the newest live posts
 *     on the `timeline` index (test identities flagged)
 *   NETWORK=devnet node scripts/clean-test-content.mjs --live --ci-pool --since 2026-10-13T00:00:00Z
 *   NETWORK=devnet node scripts/clean-test-content.mjs --plan --surface blog,storefront,pollr \
 *     --personas 200,201,202,210,211,212,230,231,232 --since 2026-10-13T15:42:00Z
 *   NETWORK=devnet node scripts/clean-test-content.mjs --live --surface blog --personas 210,211,212 \
 *     --since 2026-10-13T15:42:00Z --moderator maker
 *
 * Feature surfaces (blog, storefront, pollr):
 *   --personas <p[:id],…>  the owners, seed-ledger persona indexes (.seed-identities.local.json,
 *                    their CRITICAL keys). A plan needs no keys: `p:<id>` names the identity
 *                    when the ledger is not at hand.
 *   --since <ms|iso> required: only what was created from then on is touched
 *   --moderator <maker|personal|p>  removes the blogs the personas created since `--since`
 *                    (a blog's owner cannot delete it); without it they are leftovers
 * Contracts: NEXT_PUBLIC_YAPPR_BLOG_CONTRACT_ID, NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID and
 * NEXT_PUBLIC_POLLR_CONTRACT_ID, read like the social settings below.
 *
 * Social identities (one or both):
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
 *   --until <ms|iso> only documents created at or before it
 *   --after <type>:<id> start the owner scan of `post` or `reply` after that document (one
 *                    identity only). With --until, resumes a scan the page cap cut short, through
 *                    documents sharing its last time (the run prints both values to pass)
 *   --contract <id>  the social contract (default NEXT_PUBLIC_YAPPR_CONTRACT_ID)
 *   --contract-file <path>  the cut it was registered from (default the env's
 *                    contracts/yappr-social-contract-<NEXT_PUBLIC_CONTRACT_TOPOLOGY>.json)
 *   --survey <n>     how many of the newest timeline posts --plan surveys (default 60)
 * The contract id, topology and maker (DEVNET_MAKER_IDENTITY_ID) come from the
 * env, then E2E_ENV_FILE, else .env.devnet under NETWORK=devnet and
 * .env.testing otherwise. Exit code 1 when a live run could not remove
 * something or could not read an identity's documents in full (re-run it: it
 * only ever touches what is still there). Leftovers do not fail a run.
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureInitialized } from '@dashevo/evo-sdk';
import { CENTS_PER_MILLION_CREDITS, createBattery, personaActor } from './battery-lib.mjs';
import { CRITICAL_AUTH_KEY_ID, KEY_ROLES, REPO_ROOT, deriveIdentityKeys, loadIdentityIds, loadMnemonic, readEnvFile } from './derive-identities.mjs';
import { describeErr } from './owner-keys.mjs';
import { connectSdk, network } from './sdk-env.mjs';
import { asBase58, createSdkHandle, ledgerEntry, loadLedger } from './seed/seed-lib.mjs';
import { SURFACES, SURFACE_CONTRACT_ENV, cleanBlog, cleanPollr, cleanStorefront, printReport } from './surface-cleanup.mjs';
import { cleanTestContent, parseSince, refuseIdentities, surveyTimeline } from './test-content-cleanup.mjs';

const USAGE = 'Usage: node scripts/clean-test-content.mjs --plan|--live [--surface social,blog,storefront,pollr] [--bots <i[:id],…>] [--ci-pool [n]]\n'
  + '       [--personas <p[:id],…>] [--moderator <maker|personal|p>] [--since <ms|iso>] [--until <ms|iso>] [--after <post|reply>:<id>] [--contract <id>] [--contract-file <path>] [--survey <n>]';
const SURFACE_CLEANERS = { blog: cleanBlog, storefront: cleanStorefront, pollr: cleanPollr };
/** The `--surface` entries other than the social timeline: the feature contracts. */
const featureSurfaces = (surfaces) => surfaces.filter((surface) => surface !== 'social');
const AUTH_HIGH_KEY_ID = KEY_ROLES.find((role) => role.purpose === 'AUTHENTICATION' && role.securityLevel === 'HIGH').keyIndex;

/** The command line, parsed without reading the environment. Throws on anything it does not know. */
export function parseArgs(argv) {
  const args = { mode: null, surfaces: ['social'], bots: [], ciPool: null, personas: [], moderator: null, since: null, until: null, after: {}, contract: null, contractFile: null, survey: 60 };
  const value = (i, flag) => {
    if (argv[i] === undefined || argv[i].startsWith('--')) throw new Error(`${flag} takes a value`);
    return argv[i];
  };
  /** A list of `index` or `index:identityId` entries. */
  const indexed = (flag, raw, what) => raw.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [index, id] = entry.split(':');
    if (!/^\d+$/.test(index)) throw new Error(`${flag} ${entry}: ${what}, or index:identityId`);
    return { index: Number(index), id: id || null };
  });
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--plan':
      case '--live':
        if (args.mode !== null) throw new Error('pass one of --plan or --live');
        args.mode = flag.slice(2);
        break;
      case '--bots': args.bots = indexed(flag, value(++i, flag), 'a seed index'); break;
      case '--personas': args.personas = indexed(flag, value(++i, flag), 'a seed-ledger persona index'); break;
      case '--moderator': args.moderator = value(++i, flag); break;
      case '--surface':
        args.surfaces = [...new Set(value(++i, flag).split(',').map((entry) => entry.trim()).filter(Boolean))];
        for (const surface of args.surfaces) if (!SURFACES.includes(surface)) throw new Error(`--surface ${surface}: one of ${SURFACES.join(', ')}`);
        break;
      case '--ci-pool':
        args.ciPool = 'all';
        if (/^\d+$/.test(argv[i + 1] ?? '')) args.ciPool = Number(argv[++i]);
        break;
      case '--since': args.since = parseSince(value(++i, flag)); break;
      case '--until': args.until = parseSince(value(++i, flag)); break;
      case '--after': {
        const [type, id, ...rest] = value(++i, flag).split(':');
        if (!['post', 'reply'].includes(type) || !id || rest.length > 0) throw new Error('--after takes post:<documentId> or reply:<documentId>');
        args.after[type] = id;
        break;
      }
      case '--contract': args.contract = value(++i, flag); break;
      case '--contract-file': args.contractFile = value(++i, flag); break;
      case '--survey': args.survey = Number(value(++i, flag)); break;
      default: throw new Error(`unknown argument ${flag}`);
    }
  }
  if (args.mode === null) throw new Error('pass --plan (read-only) or --live');
  if (args.since !== null && args.until !== null && args.until < args.since) throw new Error('--until must not be earlier than --since');
  const social = args.surfaces.includes('social');
  const features = featureSurfaces(args.surfaces);
  if (social && args.bots.length === 0 && args.ciPool === null) throw new Error('name the identities: --bots <i,…> and/or --ci-pool [n]');
  if (!social && (args.bots.length > 0 || args.ciPool !== null)) throw new Error('--bots and --ci-pool name social identities: add social to --surface');
  // The feature surfaces read their contracts from the env file; a stray id must not look as if it was used.
  if (!social && (args.contract !== null || args.contractFile !== null)) throw new Error('--contract and --contract-file name the social contract: add social to --surface');
  if (features.length > 0) {
    if (args.personas.length === 0) throw new Error(`--surface ${features.join(',')}: name the owners with --personas <p,…>`);
    if (args.since === null) throw new Error(`--surface ${features.join(',')}: --since is required (the personas also own seeded content)`);
  } else if (args.personas.length > 0 || args.moderator !== null) {
    throw new Error('--personas and --moderator apply to --surface blog, storefront or pollr');
  }
  if (args.moderator !== null && !features.includes('blog')) throw new Error('--moderator removes blogs: add blog to --surface');
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

/**
 * The feature surfaces' owners: seed-ledger personas, signing with their
 * CRITICAL keys on a live run; a plan only needs their ids (`p:<id>`, else
 * the ledger's).
 */
async function personasOf(args, handle) {
  if (args.mode === 'live') {
    return Promise.all(args.personas.map(async ({ index, id }) => {
      const actor = await personaActor(handle, index);
      if (id && id !== actor.ownerId) throw new Error(`--personas ${index}:${id}: the ledger's persona ${index} is ${actor.ownerId}`);
      return actor;
    }));
  }
  const ledger = args.personas.every(({ id }) => id) ? null : loadLedger();
  return args.personas.map(({ index, id }) => {
    const ownerId = id ?? ledgerEntry(ledger, index)?.identityId;
    if (!ownerId) throw new Error(`--personas ${index}: not in the seed ledger (name it as ${index}:<id>)`);
    return { ownerId, label: `persona${index}` };
  });
}

/** Cleans the feature surfaces in `args.surfaces`; true when nothing failed. */
async function cleanFeatures(args, maker) {
  const features = featureSurfaces(args.surfaces);
  const contracts = Object.fromEntries(features.map((surface) => [surface, setting(SURFACE_CONTRACT_ENV[surface])]));
  for (const [surface, id] of Object.entries(contracts)) if (!id) throw new Error(`--surface ${surface}: set ${SURFACE_CONTRACT_ENV[surface]}`);
  await ensureInitialized();
  const handle = createSdkHandle({ contractIds: Object.values(contracts) });
  await handle.connect();
  const owners = await personasOf(args, handle);
  // Never the maker, nor the owner of a contract being cleaned (its moderator removals and own content are not test content).
  const contractOwners = [];
  for (const [surface, id] of Object.entries(contracts)) {
    const contract = await handle.sdk.contracts.fetch(id);
    if (!contract) throw new Error(`--surface ${surface}: no contract ${id} on this network`);
    contractOwners.push(asBase58(contract.ownerId));
  }
  refuseIdentities(owners.map(({ ownerId, label }) => ({ id: ownerId, label })), [maker, ...contractOwners]);
  console.log(JSON.stringify({ network: network(), mode: args.mode, since: new Date(args.since).toISOString(), contracts, owners: owners.map(({ ownerId, label }) => ({ label, id: ownerId })) }));
  let ok = true;
  for (const surface of features) {
    const contractId = contracts[surface];
    const battery = createBattery({ handle, contractId, socialId: null });
    let moderator = null;
    if (surface === 'blog' && args.moderator) {
      moderator = args.mode === 'live' ? await battery.moderatorActor(args.moderator) : { label: args.moderator };
    }
    const report = await SURFACE_CLEANERS[surface]({ battery, contractId, owners, since: args.since, moderator, live: args.mode === 'live' });
    ok = printReport(report) && ok;
  }
  return ok;
}

/** Tombstones the social posts and replies of the bots and the CI pool; true when nothing failed or was left unread. */
async function cleanSocial(args, maker) {
  const contractId = args.contract ?? setting('NEXT_PUBLIC_YAPPR_CONTRACT_ID');
  if (!contractId) throw new Error('no social contract: pass --contract or set NEXT_PUBLIC_YAPPR_CONTRACT_ID');
  const file = args.contractFile ?? `contracts/yappr-social-contract-${setting('NEXT_PUBLIC_CONTRACT_TOPOLOGY') ?? 'v2'}.json`;
  const contract = JSON.parse(readFileSync(isAbsolute(file) ? file : join(REPO_ROOT, file), 'utf8'));
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
  if (Object.keys(args.after).length > 0 && identities.length !== 1) throw new Error('--after resumes one identity\'s scan: name exactly one identity');
  const summary = await cleanTestContent({ sdk, contractId, contract, identities, since: args.since, until: args.until, after: args.after, live: args.mode === 'live', refuse: [maker], reconnect });
  const cents = Number(summary.spentCredits) * CENTS_PER_MILLION_CREDITS / 1e6;
  console.log(JSON.stringify({ ...summary, spentCentsAt60UsdPerDash: Number(cents.toFixed(3)) }, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 1));
  return summary.failed === 0 && summary.incomplete === 0;
}

async function main(argv) {
  const args = parseArgs(argv);
  const maker = setting('DEVNET_MAKER_IDENTITY_ID');
  const socialOk = args.surfaces.includes('social') ? await cleanSocial(args, maker) : true;
  const featuresOk = featureSurfaces(args.surfaces).length > 0 ? await cleanFeatures(args, maker) : true;
  return socialOk && featuresOk ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error(describeErr(e).split(' | ')[0].replace(/^message=/, ''));
    console.error(USAGE);
    process.exit(1);
  });
}
