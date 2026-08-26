/**
 * One-time, manual registration of the pollr v2 contract (count-tree tallies).
 *
 * Publishes `contracts/pollr-contract-v2.json` as a brand-new contract. Run with
 * `--bot <index>` for a scratch/rehearsal registration owned by an e2e bot
 * identity, or `--maker` for the real registration owned by the contract-maker
 * identity. Prints the new contract id for both repos' constants.
 *
 * Run:  node scripts/register-pollr-contract.mjs (--bot 0 | --maker)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataContract, EvoSDK } from '@dashevo/evo-sdk';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_FILE = join(REPO_ROOT, 'contracts', 'pollr-contract-v2.json');
const SDK_TIMEOUT_MS = 30000;

function parseArgs(argv) {
  const args = { maker: false, botIndex: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--maker': args.maker = true; break;
      case '--bot': args.botIndex = Number(argv[++i]); break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (args.maker === (args.botIndex !== null)) {
    throw new Error('Pass exactly one of --maker or --bot <index>');
  }
  return args;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error('Usage: node scripts/register-pollr-contract.mjs (--bot <index> | --maker)');
  process.exit(1);
}

try {
  const schemas = JSON.parse(readFileSync(CONTRACT_FILE, 'utf8')).documentSchemas;
  const owner = resolveOwner(args);

  const sdk = EvoSDK.testnetTrusted({ settings: { timeoutMs: SDK_TIMEOUT_MS } });
  await sdk.connect();
  console.log(`connected to testnet; owner=${owner.label}`);

  const { identityKey, signer } = await signerFor(sdk, owner);
  const identityNonce = ((await sdk.identities.nonce(owner.ownerId)) ?? 0n) + 1n;

  const dataContract = new DataContract({ ownerId: owner.ownerId, identityNonce, schemas });
  console.log(`publishing pollr v2 contract (${Object.keys(schemas).length} document types) …`);
  const published = await sdk.contracts.publish({ dataContract, identityKey, signer });
  const contractId = published.id.toBase58();
  console.log(`pollr v2 contract published: ${contractId}`);
  console.log('');
  console.log(`yappr lib/constants.ts  → POLLR_CONTRACT_ID = '${contractId}'`);
  console.log(`pollr lib/constants.ts  → POLLR_CONTRACT_ID = '${contractId}'`);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
process.exit(0);
