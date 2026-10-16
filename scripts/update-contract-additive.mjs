/**
 * Bring a deployed devnet contract up to its committed file, when the file only
 * ADDS optional properties to existing document types: the one schema change a
 * data-contract update keeps compatible with every stored document. The
 * contract keeps its id, its documents and its App Connect group membership;
 * its version goes up by one.
 *
 * It refuses anything else: a document type added, removed or changed beyond
 * new properties, a new property that is required, an existing property
 * changed, or a new property whose position does not follow the existing ones.
 * After the update it reads the contract back with proofs and requires its
 * document types to equal the file's, schema for schema.
 *
 *   NETWORK=devnet node scripts/update-contract-additive.mjs --entry storefront              # plan only
 *   NETWORK=devnet node scripts/update-contract-additive.mjs --entry storefront --live       # broadcast
 *
 * `--entry` names an App Connect member (scripts/app-connect-set.mjs), whose
 * file must carry the pinned sha256. Devnet only, signed by the devnet maker
 * (DEVNET_MAKER_IDENTITY_ID, seed index 9); testnet and mainnet updates are
 * not this script's to make. A member at a new version blocks new App Connect
 * logins on a build that pins the old one, so ship
 * `NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS` with `<id>:<new version>` together
 * with the update. Nothing here prints private key material.
 */
import { readFileSync } from 'node:fs';
import { DataContract, PlatformVersion, ensureInitialized } from '@dashevo/evo-sdk';
import { APP_CONNECT_ENTRIES, contractFilePath, fileSha256, sameSchemas } from './app-connect-set.mjs';
import { describeErr, signerFor } from './owner-keys.mjs';
import { contractSource, registrationJson, withInterim } from './register-lib.mjs';
import { envValue, network } from './sdk-env.mjs';
import { createSdkHandle, readback } from './seed/seed-lib.mjs';
import { resolveMakerOwner } from './social-battery-lib.mjs';

function parseArgs(argv) {
  const args = { entry: null, live: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--entry': args.entry = argv[++i]; break;
      case '--live': args.live = true; break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!args.entry) throw new Error('--entry <name> is required');
  return args;
}

/** `sameSchemas` compares any two renderings (key order and BigInts aside), not just whole schema maps. */
const same = sameSchemas;

/**
 * The properties `wanted` adds to `deployed`, as `[{ type, name, schema }]`, or
 * a thrown reason when the difference is anything but optional additions.
 */
function additiveChanges(deployed, wanted) {
  const deployedTypes = Object.keys(deployed).sort();
  const wantedTypes = Object.keys(wanted).sort();
  if (!same(deployedTypes, wantedTypes)) throw new Error(`document types differ: deployed [${deployedTypes}], file [${wantedTypes}]`);
  const added = [];
  for (const type of wantedTypes) {
    const { properties: before = {}, ...restBefore } = deployed[type];
    const { properties: after = {}, ...restAfter } = wanted[type];
    const required = (restAfter.required ?? []).map(String);
    const newlyRequired = required.filter((name) => !(name in before) && name in after);
    if (newlyRequired.length > 0) throw new Error(`${type}: a new property cannot be required (${newlyRequired})`);
    if (!same(restBefore, restAfter)) throw new Error(`${type}: changes more than its properties`);
    for (const [name, schema] of Object.entries(before)) {
      if (!(name in after)) throw new Error(`${type}.${name}: removed`);
      if (!same(schema, after[name])) throw new Error(`${type}.${name}: changed`);
    }
    const newNames = Object.keys(after).filter((name) => !(name in before));
    if (newNames.length === 0) continue;
    const top = Math.max(-1, ...Object.values(before).map((schema) => Number(schema.position)));
    const positions = newNames.map((name) => Number(after[name].position)).sort((a, b) => a - b);
    positions.forEach((position, index) => {
      if (position !== top + 1 + index) throw new Error(`${type}: new properties must take positions ${top + 1}…, got ${positions}`);
    });
    for (const name of newNames) added.push({ type, name, schema: after[name] });
  }
  return added;
}

const args = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    console.error('Usage: NETWORK=devnet node scripts/update-contract-additive.mjs --entry <name> [--live]');
    process.exit(1);
  }
})();

try {
  if (network() !== 'devnet') throw new Error(`devnet only (NETWORK is ${network()})`);
  const entry = APP_CONNECT_ENTRIES.find((candidate) => candidate.name === args.entry);
  if (!entry) throw new Error(`no App Connect entry named ${args.entry} (${APP_CONNECT_ENTRIES.map((e) => e.name).join(', ')})`);
  if (fileSha256(entry.file) !== entry.sha256) throw new Error(`${entry.file}: sha256 is not the pinned ${entry.sha256}`);
  const contractId = envValue(entry.envKey);
  if (!contractId) throw new Error(`${entry.envKey} is not set`);

  await ensureInitialized();
  const handle = createSdkHandle({ contractIds: [] });
  await handle.connect();
  const platformVersion = PlatformVersion.latest();
  const deployedContract = await readback(handle, () => handle.sdk.contracts.fetch(contractId));
  if (!deployedContract) throw new Error(`${entry.name}: ${contractId} not found`);
  const ownerId = deployedContract.ownerId.toBase58();
  const deployedJson = deployedContract.toJSON(platformVersion);
  const version = Number(deployedContract.version);
  console.log(`${entry.name} ${contractId}: version ${version}, owner ${ownerId}`);

  // The file rendered the way a create would carry it, so both sides are Platform's own rendering.
  const declared = contractSource(readFileSync(contractFilePath(entry.file), 'utf8'));
  const source = { ...declared, config: withInterim(declared.config, { network: network() }) };
  const wantedJson = DataContract.fromJSON(registrationJson(source, { id: contractId, ownerId }), true, platformVersion).toJSON(platformVersion);
  const wanted = wantedJson.documentSchemas;
  // Only document types are updated here, so the file must agree with the chain on everything else
  // (config, tokens, groups, keywords …), or a change there would silently not be applied.
  // The chain's own bookkeeping (createdAt…, updatedAt…) and the version are not the file's to set.
  const compared = (key) => key !== 'version' && key !== 'documentSchemas' && !/^(created|updated)At/.test(key);
  const keys = [...new Set([...Object.keys(deployedJson), ...Object.keys(wantedJson)])]
    .filter((key) => compared(key) && !same(deployedJson[key], wantedJson[key]));
  if (keys.length > 0) {
    throw new Error(`the file differs from the chain outside documentSchemas (${keys}); this script only adds properties`);
  }
  if (sameSchemas(deployedJson.documentSchemas, wanted)) {
    console.log('the deployed document types already equal the file: nothing to do');
    process.exit(0);
  }
  const added = additiveChanges(deployedJson.documentSchemas, wanted);
  for (const { type, name, schema } of added) console.log(`  + ${type}.${name} (position ${schema.position})`);

  const updated = DataContract.fromJSON({ ...deployedJson, version: version + 1, documentSchemas: wanted }, true, platformVersion);
  console.log(`update to version ${version + 1}: ${JSON.stringify(updated.toJSON(platformVersion)).length} B as JSON`);
  if (!args.live) {
    console.log('plan only: pass --live to broadcast');
    process.exit(0);
  }

  const owner = resolveMakerOwner();
  if (owner.ownerId !== ownerId) throw new Error(`the devnet maker is ${owner.ownerId}, but ${contractId} is owned by ${ownerId}`);
  const { identityKey, signer } = await signerFor(handle.sdk, owner);
  console.log(`broadcasting the update as ${owner.label} …`);
  try {
    await handle.sdk.contracts.update({ dataContract: updated, identityKey, signer });
  } catch (e) {
    // A gateway timeout on the wait does not mean the update was refused: the read-back decides.
    console.log(`broadcast returned an error, reading back to see whether it landed: ${describeErr(e)}`);
  }

  // A node that is behind still answers the old version, so read until it moves or the attempts run out.
  let after = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    after = await readback(handle, () => handle.sdk.contracts.fetch(contractId));
    if (after && Number(after.version) === version + 1) break;
    await new Promise((resolve) => setTimeout(resolve, 6000));
  }
  const ok = after && Number(after.version) === version + 1 && sameSchemas(after.toJSON(platformVersion).documentSchemas, wanted);
  console.log(`read back: version ${after?.version}, document types equal the file: ${Boolean(ok)}`);
  if (!ok) process.exit(1);
  console.log(`pin it: ${contractId}:${version + 1} in NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS`);
} catch (e) {
  console.error('ERROR:', describeErr(e));
  process.exit(1);
}
process.exit(0);
