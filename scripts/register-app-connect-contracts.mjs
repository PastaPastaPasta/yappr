/**
 * Registers the App Connect contract set (docs/APP_CONNECT_CONTRACTS.md) from
 * the maker: the `yappr-app` anchor first, whose create registers the contract
 * group "Yappr" (single owner, no admins) and joins it, then every member
 * contract in `APP_CONNECT_ENTRIES` order, each joining the group in its own
 * create. Memberships are fixed at creation, so this is the only way into the
 * group.
 *
 * The anchor's identity nonce N fixes APP_ID = generateId(maker, N) and
 * GROUP_ID = contractGroupId(maker, N) (`planAppConnectSet` in
 * app-connect-set.mjs). Member i is planned at N + i, which holds as long as
 * the maker spends no other identity nonce between the creates.
 *
 * Modes (exactly one):
 *   --plan                offline: prints the ids for --maker and --start-nonce, then builds,
 *                         decodes and audits every unsigned create (no network, no keys)
 *   --dry-run             read-only: --plan, plus the maker's nonce and balance, and that no
 *                         contract of the set and not the group exist yet
 *   --signed-dry-run      --dry-run, signed with the maker's key; nothing is broadcast
 *   --live --journal <f>  registers (below)
 *   [--upto <name>]       live: stop after that entry (`--upto app` registers only the anchor)
 *   [--retry-refused]     live: re-prepare a create the chain refused, at the next nonce
 *
 *   node scripts/register-app-connect-contracts.mjs --plan --maker <id> --start-nonce 13
 *   NETWORK=devnet node scripts/register-app-connect-contracts.mjs --dry-run
 *   NETWORK=devnet node scripts/register-app-connect-contracts.mjs --signed-dry-run
 *   NETWORK=devnet node scripts/register-app-connect-contracts.mjs --live --journal ~/ops/appconnect-sakura.json
 *
 * Every mode first builds and decodes every create unsigned, so a changed file
 * or a rule the node would refuse stops the run before anything is signed.
 * A live run then, one entry at a time:
 *   - signs the create at the maker's next nonce: the anchor only at N, a member at whatever
 *     comes next (normally N + i; anything else is reported, and its id is not the plan's);
 *   - journals the signed bytes before the first broadcast, and only ever re-broadcasts those
 *     bytes for that nonce, on this run or a resumed one;
 *   - reads the contract, its membership and the group back with proofs;
 *   - marks a create whose nonce was spent without producing the contract `refused` and stops.
 *     After investigating, `--retry-refused` prepares it again at the next nonce (a new id). A
 *     refused anchor leaves nothing of the set on chain: start a fresh journal.
 * The env lines it prints at the end carry the ids the journal recorded.
 *
 * The maker defaults to DEVNET_MAKER_IDENTITY_ID on a devnet (signing key: seed
 * index 9) and to the contract-maker file elsewhere (`resolveMakerOwner`).
 * The start nonce defaults to the journal's, else the maker's chain nonce + 1.
 * An elected declaration registers with the network's interim (`withInterim`).
 * Nothing here prints private key material.
 */
import { existsSync, readFileSync } from 'node:fs';
import { DataContract, DataContractCreateTransition, PlatformVersion, PrivateKey, StateTransition, ensureInitialized } from '@dashevo/evo-sdk';
import initWasmDpp2, * as dpp2 from '@dashevo/wasm-dpp2';
import bs58 from 'bs58';
import { APP_CONNECT_GROUP, appConnectEnvLines, contractFilePath, planAppConnectSet, sameSchemas, sha256Hex } from './app-connect-set.mjs';
import { STATE_TRANSITION_CAP, auditNodeRules, metaSchemaProblems } from './contract-probes.mjs';
import { describeErr, signerFor } from './owner-keys.mjs';
import { auditModeration, contractSource, registrationJson, withInterim } from './register-lib.mjs';
import { envValue, network } from './sdk-env.mjs';
import { NONCE_SEQUENCE_MASK, createSdkHandle, readback, sleep, writePrivateFile } from './seed/seed-lib.mjs';
import { resolveMakerOwner } from './social-battery-lib.mjs';

const SIGNATURE_ALLOWANCE = 100;
const MODES = ['--plan', '--dry-run', '--signed-dry-run', '--live'];
const generateId = (owner, nonce) => DataContract.generateId(owner, nonce).toBase58();
const big = (_key, value) => (typeof value === 'bigint' ? String(value) : value);

function parseArgs(argv) {
  const args = { mode: null, maker: null, startNonce: null, journal: null, upto: null, retryRefused: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (MODES.includes(arg)) {
      if (args.mode) throw new Error(`pass exactly one of ${MODES.join(' | ')}`);
      args.mode = arg.slice(2);
      continue;
    }
    switch (arg) {
      case '--maker': args.maker = argv[++i]; break;
      case '--start-nonce': args.startNonce = BigInt(argv[++i]); break;
      case '--journal': args.journal = argv[++i]; break;
      case '--upto': args.upto = argv[++i]; break;
      case '--retry-refused': args.retryRefused = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.mode) throw new Error(`pass exactly one of ${MODES.join(' | ')}`);
  if (args.mode === 'live' && !args.journal) throw new Error('--live needs --journal <file> (it keeps the signed bytes of every create)');
  if (args.mode !== 'live' && (args.journal || args.upto || args.retryRefused)) throw new Error('--journal, --upto and --retry-refused belong to --live');
  if (args.mode === 'plan' && args.startNonce === null) throw new Error('--plan needs --start-nonce <n> (the anchor\'s identity nonce)');
  return args;
}

/** The maker id and where it came from: --maker, else the devnet maker, else the contract-maker file. */
function makerFor(args) {
  if (args.maker) return { id: args.maker, source: '--maker' };
  const devnetMaker = network() === 'devnet' ? envValue('DEVNET_MAKER_IDENTITY_ID') : undefined;
  if (devnetMaker) return { id: devnetMaker, source: 'DEVNET_MAKER_IDENTITY_ID' };
  if (args.mode === 'plan') throw new Error('--plan needs --maker <identityId> (no devnet maker in the environment)');
  return { id: resolveMakerOwner().ownerId, source: 'the contract-maker file' };
}

/** The assembled create JSON for one entry, refusing a file whose bytes are not the pinned ones. */
function assemble(entry, ownerId) {
  const bytes = readFileSync(contractFilePath(entry.file));
  const actual = sha256Hex(bytes);
  if (actual !== entry.sha256) throw new Error(`${entry.file}: sha256 ${actual} is not the pinned ${entry.sha256} (update APP_CONNECT_ENTRIES after review)`);
  const text = bytes.toString('utf8');
  if (text.includes('"SOCIAL_CONTRACT_ID"')) throw new Error(`${entry.file}: carries the SOCIAL_CONTRACT_ID placeholder; no App Connect member may embed another contract's id`);
  const declared = contractSource(text);
  const source = { ...declared, config: withInterim(declared.config, { network: network() }) };
  return { source, json: registrationJson(source, { id: entry.id, ownerId }) };
}

/** A create at the entry's nonce, carrying the group registration (anchor only) and the membership. */
function buildCreate(entry, { plan, platformVersion, signing }) {
  const { source, json } = assemble(entry, plan.groupOwner);
  const dataContract = DataContract.fromJSON(json, true, platformVersion);
  if (dataContract.id.toBase58() !== entry.id) throw new Error(`${entry.name}: parsed id ${dataContract.id.toBase58()} != ${entry.id}`);
  if (json.config.moderation) auditModeration(json.documentSchemas, dataContract);
  const problems = [...auditNodeRules(source, { network: network() }), ...metaSchemaProblems(source)];
  if (problems.length > 0) throw new Error(`${entry.name}: ${problems.length} rule(s) the node would refuse: ${problems.join('; ')}`);
  const create = new DataContractCreateTransition(dataContract, entry.nonce, platformVersion);
  if (create.featureVersion !== 1) throw new Error(`${entry.name}: contract groups need a version 1 create (PV14); got ${create.featureVersion}`);
  if (entry.name === plan.anchor.name) create.setContractGroup({ name: APP_CONNECT_GROUP.name, description: APP_CONNECT_GROUP.description });
  create.setContractGroupMemberships([{ contractGroupId: bs58.decode(plan.groupId), member: 'contract' }]);
  const stateTransition = create.toStateTransition();
  if (signing) {
    stateTransition.verifyPublicKey(signing.identityKey);
    stateTransition.sign(signing.privateKey, signing.identityKey);
  }
  return { bytes: Buffer.from(stateTransition.toBytes()), echoed: dataContract.toJSON(platformVersion) };
}

/**
 * Decodes the bytes with the wasm-sdk (byte-identical re-encode, nonce, group
 * registration on the anchor only, membership == [group], carried contract ==
 * assembled) and with wasm-dpp2 (re-encode, nonce, full-validation parse).
 * Returns the signed size (an unsigned one plus the signature allowance).
 */
function decodeBoth(entry, bytes, { plan, echoed, signed, platformVersion }) {
  const st = StateTransition.fromBytes(bytes);
  if (!Buffer.from(st.toBytes()).equals(bytes)) throw new Error(`${entry.name}: the wasm-sdk does not re-encode it byte-identically`);
  const t = DataContractCreateTransition.fromStateTransition(st);
  if (t.identityNonce !== entry.nonce) throw new Error(`${entry.name}: nonce ${t.identityNonce} != ${entry.nonce}`);
  const group = t.contractGroup;
  if (entry.name === plan.anchor.name) {
    if (!group || group.name !== APP_CONNECT_GROUP.name || group.description !== APP_CONNECT_GROUP.description || (group.admins ?? []).length !== 0) {
      throw new Error(`${entry.name}: must register the group ${JSON.stringify(APP_CONNECT_GROUP)} with no admins, carries ${JSON.stringify(group, big)}`);
    }
  } else if (group !== undefined) {
    throw new Error(`${entry.name}: must NOT register a group`);
  }
  const memberships = (t.contractGroupMemberships ?? []).map((m) => [bs58.encode(Uint8Array.from(Object.values(m.contractGroupId))), m.member]);
  if (JSON.stringify(memberships) !== JSON.stringify([[plan.groupId, 'contract']])) throw new Error(`${entry.name}: memberships ${JSON.stringify(memberships)}, expected the whole contract in ${plan.groupId}`);
  const carried = t.getDataContract(platformVersion, true);
  if (carried.id.toBase58() !== entry.id || carried.ownerId.toBase58() !== plan.groupOwner) throw new Error(`${entry.name}: carried id/owner differ from the plan`);
  if (JSON.stringify(carried.toJSON(platformVersion), big) !== JSON.stringify(echoed, big)) throw new Error(`${entry.name}: carried contract != assembled`);
  if (Boolean(st.signature?.length) !== signed) throw new Error(`${entry.name}: expected ${signed ? 'a signed' : 'an unsigned'} transition`);
  const st2 = dpp2.StateTransition.fromBytes(bytes);
  if (!Buffer.from(st2.toBytes()).equals(bytes)) throw new Error(`${entry.name}: wasm-dpp2 does not re-encode it byte-identically`);
  const t2 = dpp2.DataContractCreateTransition.fromStateTransition(st2);
  if (BigInt(t2.identityNonce) !== entry.nonce) throw new Error(`${entry.name}: wasm-dpp2 nonce ${t2.identityNonce}`);
  const pv2 = dpp2.PlatformVersion.latest();
  dpp2.DataContract.fromJSON(t2.getDataContract(pv2, true).toJSON(pv2), true, pv2);
  const size = bytes.length + (signed ? 0 : SIGNATURE_ALLOWANCE);
  if (size >= STATE_TRANSITION_CAP) throw new Error(`${entry.name}: ~${size} B signed, over the ${STATE_TRANSITION_CAP} B cap`);
  return size;
}

/** Builds and decodes one create, printing its size; returns the bytes. */
function prepare(entry, { plan, platformVersion, signing }) {
  console.log(`  ${entry.name} (nonce ${entry.nonce})`);
  const { bytes, echoed } = buildCreate(entry, { plan, platformVersion, signing });
  const size = decodeBoth(entry, bytes, { plan, echoed, signed: Boolean(signing), platformVersion });
  const role = entry.name === plan.anchor.name ? 'registers the group and joins it' : 'joins the group';
  console.log(`    ${signing ? '' : '~'}${size} B signed, ${role}; decoded by the wasm-sdk and wasm-dpp2`);
  return bytes;
}

function printPlan(plan, makerSource) {
  console.log(`App Connect contract set on ${network()}: maker ${plan.groupOwner} (${makerSource}), anchor nonce ${plan.anchor.nonce}`);
  console.log(`APP_ID=${plan.appId}`);
  console.log(`GROUP_ID=${plan.groupId}`);
  console.log(`GROUP_OWNER=${plan.groupOwner}`);
  console.log('nonce  contract    id                                            source');
  for (const c of plan.contracts) {
    const role = c === plan.anchor ? ' (registers the group and joins it)' : '';
    console.log(`${String(c.nonce).padStart(5)}  ${c.name.padEnd(10)}  ${c.id.padEnd(44)}  ${c.file} ${c.sha256.slice(0, 12)}…${role}`);
  }
}

function printEnv(set, heading) {
  console.log(`\n${heading} (docs/APP_CONNECT_CONTRACTS.md):`);
  for (const line of appConnectEnvLines(set)) console.log(line);
}

/** A journal that matches the plan: same network, maker, anchor nonce and group; every entry from its pinned file at a consistent id. */
function checkJournal(journal, plan, path) {
  for (const [key, want] of [['network', network()], ['makerId', plan.groupOwner], ['startNonce', String(plan.anchor.nonce)], ['groupId', plan.groupId]]) {
    if (journal[key] !== want) throw new Error(`journal ${path}: ${key} is ${journal[key]}, this run's is ${want}`);
  }
  for (const c of plan.contracts) {
    const saved = journal.contracts[c.name];
    if (saved && (saved.sha256 !== c.sha256 || saved.id !== generateId(plan.groupOwner, BigInt(saved.nonce)))) {
      throw new Error(`journal ${path}: ${c.name} was prepared from another file or carries an inconsistent id; refusing to mix`);
    }
  }
}

/**
 * Polls for a broadcast create. `absent` is true only when the last read
 * succeeded and proved the contract absent; a read that failed proves nothing.
 */
async function awaitContract(handle, id) {
  let absent = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    await sleep(2000);
    try {
      const found = await handle.sdk.contracts.fetch(id);
      if (found) return { contract: found, absent: false };
      absent = true;
    } catch (e) {
      absent = false;
      console.log(`  fetch: ${describeErr(e).slice(0, 120)}`);
    }
  }
  return { contract: null, absent };
}

/**
 * Proved read-back: the contract (its owner, and its document types equal to
 * the pinned file's, so a stray id can never pass for this entry), its
 * membership, and the group itself (owner the maker, no admins).
 */
async function verifyRegistered(handle, entry, plan, platformVersion) {
  const read = (fn) => readback(handle, fn);
  const [contract, memberships, info] = await Promise.all([
    read(() => handle.sdk.contracts.fetch(entry.id)),
    read(() => handle.sdk.contractGroups.forContract(entry.id)),
    read(() => handle.sdk.contractGroups.info(plan.groupId)),
  ]);
  if (!contract || contract.ownerId.toBase58() !== plan.groupOwner) throw new Error(`${entry.name}: ${entry.id} absent or not owned by the maker`);
  const expected = DataContract.fromJSON(assemble(entry, plan.groupOwner).json, true, platformVersion).toJSON(platformVersion).documentSchemas;
  if (!sameSchemas(contract.toJSON(platformVersion).documentSchemas, expected)) throw new Error(`${entry.name}: ${entry.id} does not carry ${entry.file}'s document types`);
  if (!memberships.contract.includes(plan.groupId)) throw new Error(`${entry.name}: ${entry.id} is not a member of ${plan.groupId}`);
  if (!info || info.ownerId !== plan.groupOwner || info.adminIds.length !== 0) throw new Error(`group ${plan.groupId}: owner ${info?.ownerId}, admins ${info?.adminIds}; expected ${plan.groupOwner} alone`);
}

/** The live run over the entries up to `--upto`, against the journal `state`. */
async function registerLive({ args, plan, state, handle, makerNonce, signing, platformVersion }) {
  // Written to a temporary file and renamed over the journal, so an interrupted save never truncates it.
  const save = () => writePrivateFile(args.journal, JSON.stringify(state, null, 2) + '\n');
  const read = (fn) => readback(handle, fn);
  /**
   * The maker's next nonce, never below what the journal already spent: a node
   * lagging behind would otherwise hand out a used nonce, and with it the id of
   * a contract already registered.
   */
  const nextNonce = async () => {
    const spent = [...Object.values(state.contracts), ...(state.refused ?? [])].map((c) => BigInt(c.nonce));
    const floor = spent.reduce((max, n) => (n > max ? n : max), plan.anchor.nonce - 1n);
    for (let attempt = 0; attempt < 5; attempt++) {
      const chainNonce = await makerNonce();
      if (chainNonce >= floor) return chainNonce + 1n;
      console.log(`  the maker's nonce reads ${chainNonce}, behind the journal's ${floor}; reading again`);
      await sleep(3000);
    }
    throw new Error(`the maker's nonce keeps reading behind the journal's ${floor}; re-run once the nodes catch up`);
  };
  save();
  console.log('\nregistering:');
  const last = args.upto ? plan.contracts.findIndex((c) => c.name === args.upto) : plan.contracts.length - 1;
  for (const planned of plan.contracts.slice(0, last + 1)) {
    let saved = state.contracts[planned.name];
    if (saved?.state === 'verified') { console.log(`  ${planned.name}: already verified (${saved.id})`); continue; }
    if (saved?.state === 'refused') {
      if (planned === plan.anchor) throw new Error('the anchor create was refused, so neither it nor the group exists: start a fresh journal');
      if (!args.retryRefused) throw new Error(`${planned.name} was refused at nonce ${saved.nonce}; investigate, then re-run with --retry-refused to prepare it at the next nonce (a new id)`);
      // Proved absent once more before it is replaced: a create that did land must never get a twin.
      if (await read(() => handle.sdk.contracts.fetch(saved.id))) {
        console.log(`  ${planned.name}: ${saved.id} turns out to exist; verifying it instead of replacing it`);
        saved.state = 'broadcasting';
      } else {
        state.refused = [...(state.refused ?? []), { name: planned.name, nonce: saved.nonce, id: saved.id }];
        delete state.contracts[planned.name];
        saved = undefined;
      }
      save();
    }
    if (!saved) {
      const nonce = await nextNonce();
      if (planned === plan.anchor && nonce !== planned.nonce) throw new Error(`the anchor must take nonce ${planned.nonce} (it fixes APP_ID and GROUP_ID), but the maker's next nonce is ${nonce}`);
      if (nonce !== planned.nonce) console.log(`  NOTE: ${planned.name} takes nonce ${nonce}, not the planned ${planned.nonce}, so its id is not the plan's`);
      const entry = { ...planned, nonce, id: generateId(plan.groupOwner, nonce) };
      if (Object.values(state.contracts).some((c) => c.id === entry.id)) throw new Error(`${entry.name}: ${entry.id} is already in the journal`);
      const bytes = prepare(entry, { plan, platformVersion, signing });
      saved = { nonce: String(nonce), id: entry.id, file: entry.file, sha256: entry.sha256, bytes: bytes.length, transition: bytes.toString('base64'), state: 'prepared' };
      state.contracts[planned.name] = saved;
      save();
    }

    const entry = { ...planned, nonce: BigInt(saved.nonce), id: saved.id };
    const before = await read(() => handle.sdk.identities.balance(plan.groupOwner));
    let found = await read(() => handle.sdk.contracts.fetch(entry.id));
    for (let attempt = 1; !found && attempt <= 5; attempt++) {
      console.log(`  broadcasting ${entry.name} ${entry.id} at nonce ${entry.nonce} (attempt ${attempt})`);
      saved.state = 'broadcasting'; save();
      try {
        await handle.sdk.stateTransitions.broadcastStateTransition(StateTransition.fromBase64(saved.transition), { timeoutMs: 30000 });
      } catch (e) {
        console.log(`  broadcast: ${describeErr(e).slice(0, 300)}`);
      }
      const polled = await awaitContract(handle, entry.id);
      found = polled.contract;
      if (found) break;
      // Refused only on proof: the nonce is spent AND a read that succeeded (readback throws
      // when every attempt fails) still finds no contract.
      if (polled.absent && (await makerNonce()) >= entry.nonce) {
        found = await read(() => handle.sdk.contracts.fetch(entry.id));
        if (found) break;
        saved.state = 'refused'; save();
        throw new Error(`${entry.name}: the maker's nonce passed ${entry.nonce} but ${entry.id} is proved absent: the create was refused (paid), or another transition took the nonce. Investigate; --retry-refused prepares it again at the next nonce.`);
      }
      await handle.reconnect('contract not visible yet');
    }
    if (!found) throw new Error(`${entry.name} is not proven yet; re-run with the same journal (it re-broadcasts the same bytes, never a new nonce)`);
    await verifyRegistered(handle, entry, plan, platformVersion);
    const after = await read(() => handle.sdk.identities.balance(plan.groupOwner));
    Object.assign(saved, { state: 'verified', verifiedAt: new Date().toISOString(), makerCreditsSpent: String(BigInt(before ?? 0) - BigInt(after ?? 0)) });
    save();
    console.log(`  VERIFIED ${entry.name} ${entry.id} (${saved.makerCreditsSpent} credits)`);
  }

  const verified = plan.contracts.filter((c) => state.contracts[c.name]?.state === 'verified').map((c) => ({ ...c, nonce: BigInt(state.contracts[c.name].nonce), id: state.contracts[c.name].id }));
  if (new Set(verified.map((c) => c.id)).size !== verified.length) throw new Error('the journal records one id for two entries; refusing to print env lines');
  const page = await read(() => handle.sdk.contractGroups.members({ contractGroupId: plan.groupId, kind: 'contracts', limit: 100 }));
  for (const c of verified) if (!page.contracts?.includes(c.id)) throw new Error(`${c.name} ${c.id} is not enumerated by the group`);
  state.groupMembers = page.contracts;
  if (verified.length === plan.contracts.length) state.completedAt = new Date().toISOString();
  save();
  console.log(`\ngroup ${plan.groupId}: ${page.contracts?.length ?? 0} member(s); ${verified.length}/${plan.contracts.length} of the set verified`);
  return verified;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await Promise.all([ensureInitialized(), initWasmDpp2()]);
  const platformVersion = PlatformVersion.latest();
  const maker = makerFor(args);
  const journal = args.mode === 'live' && existsSync(args.journal) ? JSON.parse(readFileSync(args.journal, 'utf8')) : null;

  let handle = null;
  let startNonce = args.startNonce;
  const makerNonce = async () => ((await readback(handle, () => handle.sdk.identities.nonce(maker.id))) ?? 0n) & NONCE_SEQUENCE_MASK;
  if (args.mode !== 'plan') {
    handle = createSdkHandle({ contractIds: [] });
    const { protocolVersion } = await handle.connect();
    if (!(protocolVersion >= 14)) throw new Error(`contract groups need protocol version 14; the chain reports ${protocolVersion}`);
    const chainNonce = await makerNonce();
    const balance = await readback(handle, () => handle.sdk.identities.balance(maker.id));
    console.log(`connected to ${network()} (PV${protocolVersion}); maker nonce ${chainNonce}, ${balance} credits`);
    if (journal) {
      if (startNonce !== null && startNonce !== BigInt(journal.startNonce)) throw new Error(`--start-nonce ${startNonce} disagrees with the journal's ${journal.startNonce}`);
      startNonce = BigInt(journal.startNonce);
    }
    startNonce ??= chainNonce + 1n;
    if (args.mode !== 'live' && chainNonce !== startNonce - 1n) throw new Error(`the maker is at nonce ${chainNonce}; the anchor at ${startNonce} needs it at ${startNonce - 1n}`);
  }
  const plan = planAppConnectSet({ makerId: maker.id, startNonce, generateId });
  printPlan(plan, maker.source);
  if (args.upto && !plan.contracts.some((c) => c.name === args.upto)) throw new Error(`--upto ${args.upto}: not an entry (${plan.contracts.map((c) => c.name).join(', ')})`);
  if (journal) checkJournal(journal, plan, args.journal);

  if (handle) {
    const ours = new Set(Object.values(journal?.contracts ?? {}).map((c) => c.id));
    for (const c of plan.contracts) {
      if (!ours.has(c.id) && await readback(handle, () => handle.sdk.contracts.fetch(c.id))) throw new Error(`REFUSING: ${c.name} ${c.id} already exists on chain`);
    }
    if (!ours.has(plan.appId) && await readback(handle, () => handle.sdk.contractGroups.info(plan.groupId))) throw new Error(`REFUSING: group ${plan.groupId} already exists`);
  }

  // Every mode builds the whole set unsigned first: nothing is signed or broadcast unless all of it would pass.
  console.log('\ncreates (unsigned, at the planned nonces):');
  for (const entry of plan.contracts) prepare(entry, { plan, platformVersion, signing: null });
  if (args.mode === 'plan' || args.mode === 'dry-run') { printEnv(plan, 'env'); return; }

  const owner = resolveMakerOwner();
  if (owner.ownerId !== maker.id) throw new Error(`the maker key belongs to ${owner.ownerId}, not ${maker.id}`);
  const { identityKey } = await signerFor(handle.sdk, owner);
  const signing = { identityKey, privateKey: PrivateKey.fromWIF(owner.wif) };
  if (args.mode === 'signed-dry-run') {
    console.log('\ncreates (signed, never broadcast):');
    for (const entry of plan.contracts) prepare(entry, { plan, platformVersion, signing });
    printEnv(plan, 'env');
    return;
  }

  const state = journal ?? { network: network(), makerId: plan.groupOwner, startNonce: String(plan.anchor.nonce), groupId: plan.groupId, contracts: {} };
  const verified = await registerLive({ args, plan, state, handle, makerNonce, signing, platformVersion });
  printEnv({ ...plan, contracts: verified }, verified.length === plan.contracts.length ? 'env' : `env so far (${verified.length} of ${plan.contracts.length})`);
}

try {
  await main();
  process.exit(0);
} catch (e) {
  console.error(`ERROR: ${describeErr(e).split(' | ')[0]}`);
  process.exit(1);
}
