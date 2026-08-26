/**
 * Contract update: add the optional embed-reference fields to `post`.
 *
 * Adds `embedContractId` / `embedDocType` / `embedId` (all optional, non-indexed)
 * to the social contract's `post` document type and bumps the contract version —
 * the backwards-compatible "add optional properties" update the protocol allows.
 * A poll post sets the triple to (pollr contract, 'poll', pollId); future embeds
 * (blog posts, store items, third-party docs) ride the same fields.
 *
 * Rehearse on a scratch copy before touching a real contract:
 *   node scripts/register-test-contracts.mjs --only social      # scratch copy
 *   node scripts/update-social-contract.mjs --contract <scratchId> --bot 0
 * Real run (staging contract, maker-owned):
 *   node scripts/update-social-contract.mjs --contract 9oDC6xdg8WRixTD2j3FCBq3vtsrf6bRGjXSJbhtFoma9 --maker
 *
 * `--dry-run` fetches and patches but does not broadcast.
 */
import { EvoSDK, PlatformVersion } from '@dashevo/evo-sdk';
import { describeErr, resolveOwner, signerFor } from './owner-keys.mjs';

const SDK_TIMEOUT_MS = 30000;

const EMBED_PROPERTIES = {
  embedContractId: {
    type: 'array',
    byteArray: true,
    minItems: 32,
    maxItems: 32,
    contentMediaType: 'application/x.dash.dpp.identifier',
    description: 'Contract id of an embedded document (e.g. the pollr contract for poll posts)',
  },
  embedDocType: {
    type: 'string',
    minLength: 1,
    maxLength: 64,
    description: "Document type of the embedded document (e.g. 'poll')",
  },
  embedId: {
    type: 'array',
    byteArray: true,
    minItems: 32,
    maxItems: 32,
    contentMediaType: 'application/x.dash.dpp.identifier',
    description: 'Id of the embedded document',
  },
};

function parseArgs(argv) {
  const args = { maker: false, botIndex: null, contract: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--maker': args.maker = true; break;
      case '--bot': args.botIndex = Number(argv[++i]); break;
      case '--contract': args.contract = argv[++i]; break;
      case '--dry-run': args.dryRun = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.contract) throw new Error('--contract <id> is required');
  if (!args.dryRun && args.maker === (args.botIndex !== null)) {
    throw new Error('Pass exactly one of --maker or --bot <index>');
  }
  return args;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(e.message);
  console.error('Usage: node scripts/update-social-contract.mjs --contract <id> (--bot <index> | --maker) [--dry-run]');
  process.exit(1);
}

try {
  const sdk = EvoSDK.testnetTrusted({ settings: { timeoutMs: SDK_TIMEOUT_MS } });
  await sdk.connect();

  const contract = await sdk.contracts.fetch(args.contract);
  if (!contract) throw new Error(`Contract ${args.contract} not found on testnet`);
  const currentVersion = contract.version;
  console.log(`fetched ${args.contract} (version ${currentVersion}, owner ${contract.ownerId.toBase58()})`);

  const schemas = contract.schemas;
  const post = schemas.post;
  if (!post) throw new Error('Contract has no `post` document type');

  const already = Object.keys(EMBED_PROPERTIES).filter((name) => post.properties[name]);
  if (already.length === Object.keys(EMBED_PROPERTIES).length) {
    console.log('All embed properties already present — nothing to do.');
    process.exit(0);
  }
  if (already.length > 0) throw new Error(`Contract has a partial embed set (${already.join(', ')}) — refusing`);

  // New properties slot in after the highest existing position; property order/positions
  // of existing fields are untouched (contract updates must be purely additive).
  // `schemas` returns platform integers as BigInt on evo-sdk 4.2 — normalize.
  const positions = Object.values(post.properties).map((p) => Number(p.position));
  const highestPosition = Math.max(...positions);
  if (!Number.isFinite(highestPosition)) {
    throw new Error(
      `Could not read existing property positions on \`post\` (got ${JSON.stringify(positions)}) — ` +
        'refusing to guess, since a wrong position would corrupt the contract update'
    );
  }
  const nextPosition = highestPosition + 1;
  Object.entries(EMBED_PROPERTIES).forEach(([name, definition], i) => {
    post.properties[name] = { ...definition, position: nextPosition + i };
  });
  console.log(
    `adding to post at positions ${nextPosition}-${nextPosition + 2}: ${Object.keys(EMBED_PROPERTIES).join(', ')}`
  );

  if (args.dryRun) {
    console.log(`dry run — would submit version ${currentVersion + 1}; no broadcast.`);
    process.exit(0);
  }

  const owner = resolveOwner(args);
  if (owner.ownerId !== contract.ownerId.toBase58()) {
    throw new Error(`Signer ${owner.label} does not own this contract (owner is ${contract.ownerId.toBase58()})`);
  }
  const { identityKey, signer } = await signerFor(sdk, owner);

  contract.setSchemas(schemas, null, true, PlatformVersion.latest());
  contract.version = currentVersion + 1;

  console.log(`broadcasting contract update to version ${currentVersion + 1} as ${owner.label} …`);
  await sdk.contracts.update({ dataContract: contract, identityKey, signer });

  const refetched = await sdk.contracts.fetch(args.contract);
  const postProps = Object.keys(refetched?.schemas?.post?.properties ?? {});
  const present = Object.keys(EMBED_PROPERTIES).every((name) => postProps.includes(name));
  console.log(`update confirmed: version ${refetched?.version}, embed fields present: ${present}`);
  if (!present) process.exit(1);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
process.exit(0);
