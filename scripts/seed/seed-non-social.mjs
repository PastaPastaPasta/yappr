/**
 * One entry point for the five non-social content seeders, so the /devnet deployment's shop, blog, messages, polls
 * and tip strips have lived-in data.   NETWORK=devnet node scripts/seed/seed-non-social.mjs --which storefront
 * NETWORK=devnet node scripts/seed/seed-non-social.mjs --which blog --dry-run   NETWORK=devnet node
 * scripts/seed/seed-non-social.mjs --which tips --self-test `--dry-run` and `--self-test` are fully OFFLINE: they
 * build the plan, run the real crypto where a feature has any, and print what would be written. Everything else
 * connects, writes and then verifies through the query shapes the app itself uses. Every run is deterministic in
 * `--seed` and resumable: document ids are a pure function of a logical key, so a re-run probes before it writes. See
 * docs/NON_SOCIAL_CONTRACTS.md. Actors are seed-ledger personas. The ones these five need beyond the social seed live
 * in scripts/seed/personas.non-social.json:   NETWORK=devnet node scripts/seed/provision-seed-identities.mjs \
 * --personas scripts/seed/personas.non-social.json --yapp 150
 */
import { ensureInitialized } from '@dashevo/evo-sdk';
import { createBattery } from '../battery-lib.mjs';
import { reportSelfTest } from '../battery-lib.mjs';
import { createSdkHandle, describeErr, network, socialContractId } from './seed-lib.mjs';
import { parseFlags, plumbingAssertions, resolveContractId, stateFile } from './feature-seed-lib.mjs';
import storefront from './non-social/storefront.mjs';
import blog from './non-social/blog.mjs';
import dm from './non-social/dm.mjs';
import pollr from './non-social/pollr.mjs';
import tips from './non-social/tips.mjs';

const FEATURES = new Map([storefront, blog, dm, pollr, tips].map((feature) => [feature.name, feature]));

const COMMON_FLAGS = {
  '--contract': ['contract', 'string'],
  '--seed': ['seed', 'string'],
  '--concurrency': ['concurrency', 'number'],
  '--state': ['state', 'string'],
  '--only': ['only', 'list'],
  '--dry-run': ['dryRun', 'bool'],
  '--verify-only': ['verifyOnly', 'bool'],
  '--self-test': ['selfTest', 'bool'],
};

function usage() {
  console.error(`Usage: NETWORK=devnet node scripts/seed/seed-non-social.mjs --which <${[...FEATURES.keys()].join('|')}>`);
  console.error('         [--contract <id>] [--seed <s>] [--concurrency N] [--state <file>] [--only a,b]');
  console.error('         [--dry-run] [--verify-only] [--self-test]');
  console.error('       --dry-run and --self-test are offline; every other mode writes to the devnet.');
}

/** An argument error: reported as one line plus the usage block, never as a stack. */
const usageError = (message) => Object.assign(new Error(message), { usage: true });

function parse(argv) {
  const at = argv.indexOf('--which');
  if (at === -1) throw usageError('--which is required');
  const which = argv[at + 1];
  const feature = FEATURES.get(which);
  if (!feature) throw usageError(`Unknown --which "${which ?? ''}" (known: ${[...FEATURES.keys()].join(', ')})`);
  const rest = [...argv.slice(0, at), ...argv.slice(at + 2)];
  let args;
  try {
    args = parseFlags(rest, { ...COMMON_FLAGS, ...(feature.flags ?? {}) }, {
      contract: null, seed: null, concurrency: 4, state: null, only: null,
      dryRun: false, verifyOnly: false, selfTest: false, ...(feature.defaults ?? {}),
    });
  } catch (error) {
    throw usageError(error.message);
  }
  args.state ??= stateFile(feature.state);
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) throw usageError('--concurrency must be a positive integer');
  return { feature, args };
}

async function main() {
  const { feature, args } = parse(process.argv.slice(2));
  // The shared plumbing is checked on every --self-test, not once somewhere.
  if (args.selfTest) return reportSelfTest('the seeder plumbing', await plumbingAssertions()) + feature.selfTest(args);
  if (network() === 'mainnet') throw new Error(`${feature.name}: this seeder writes fake content. Refusing to run against mainnet.`);

  args.contract = resolveContractId(args.contract, feature.contractEnv ?? []);
  feature.check?.(args);

  // A dry run reads nothing and writes nothing, so it must work with no contract
  // configured at all — that is how the plan gets reviewed before deploy day.
  if (args.dryRun) {
    console.log(`DRY RUN — ${feature.name}${args.contract ? ` on ${args.contract}` : ''} (network=${network()}, nothing is broadcast)\n`);
    return (await feature.dryRun(feature.plan(args), args)) ?? 0;
  }
  if (!args.contract && feature.contractEnv?.length) {
    throw usageError(`Pass --contract <id> or set ${feature.contractEnv.join(' / ')}`);
  }

  await ensureInitialized();
  const socialId = socialContractId();
  const contractIds = [socialId, ...(args.contract ? [args.contract] : []), ...(feature.extraContracts ?? [])];
  const handle = createSdkHandle({ contractIds: [...new Set(contractIds)] });
  const { protocolVersion } = await handle.connect();
  console.log(`connected (PV${protocolVersion ?? '?'}); ${feature.name} ${args.contract ?? socialId}; social ${socialId}`);
  const battery = createBattery({ handle, contractId: args.contract ?? socialId, socialId });
  return (await feature.run({ args, handle, battery, socialId, contractId: args.contract })) ?? 0;
}

try {
  process.exit((await main()) === 0 ? 0 : 1);
} catch (error) {
  console.error('ERROR:', error?.usage ? error.message : describeErr(error));
  if (error?.usage) usage();
  process.exit(1);
}
