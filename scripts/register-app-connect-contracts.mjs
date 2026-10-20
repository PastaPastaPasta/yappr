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
 *   NETWORK=devnet node scripts/register-app-connect-contracts.mjs --plan --maker <id> --start-nonce 13
 *   NETWORK=devnet node scripts/register-app-connect-contracts.mjs --dry-run
 *   NETWORK=devnet node scripts/register-app-connect-contracts.mjs --signed-dry-run
 *   NETWORK=devnet node scripts/register-app-connect-contracts.mjs --live --journal ~/ops/appconnect-sakura.json
 *
 * NETWORK is required. Every elected contract (social, blog, storefront) is
 * rendered with:
 *   --interim <kind>                 the moderation interim (contractOwner | notYetUsable | noModeration)
 *   --election-windows <join>,<vote> the election windows, in seconds (mainnet: at least 86400 each)
 *   --election-delay <seconds>       delay after contract creation before the first charter
 * On a devnet both are optional and default to the committed file's values.
 * On testnet and mainnet (production networks) they are REQUIRED, never a
 * default, since both are frozen into the contracts for good; and:
 *   --maker <id>                     is required in every mode;
 *   --maker-key-file <path> --maker-key-id <n>
 *                                    is the only signing key source of --signed-dry-run and
 *                                    --live: an identity key file of this user's with mode 0600
 *                                    or tighter (no default path, no seed derivation). The key
 *                                    must be the maker's enabled CRITICAL AUTHENTICATION key on
 *                                    chain; --dry-run proves that too when given the file;
 *   --production                     is required by --live (and refused on a devnet);
 *   --journal                        must sit in a directory only its owner may enter (0700).
 * Testnet (owner decision D41):
 *   NETWORK=testnet node scripts/register-app-connect-contracts.mjs --plan --maker <id> --start-nonce <n> \
 *     --interim notYetUsable --election-windows 86400,86400 --election-delay 86400 --challenge-cool-down 1209600
 *   NETWORK=testnet node scripts/register-app-connect-contracts.mjs --live --production --journal <0700 dir>/journal.json \
 *     --maker <id> --maker-key-file <0600 file> --maker-key-id <n> --interim notYetUsable --election-windows 86400,86400 --election-delay 86400 --challenge-cool-down 1209600
 *
 * Every mode but --plan gates on the protocol version of the PROVED current
 * epoch (never a status page), and prints the cost estimate of what it would
 * register (each create's registration fee plus a storage allowance) beside
 * the maker's balance. --signed-dry-run and --live refuse to sign unless the
 * balance covers the estimate plus 20%.
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
 * On a devnet the maker defaults to DEVNET_MAKER_IDENTITY_ID (signing key: seed
 * index 9, `resolveMakerOwner`) unless a key file is named. The start nonce
 * defaults to the journal's, else the maker's chain nonce + 1. The journal
 * records the network, the interim and the election windows, and a resumed run
 * must name the same ones. Nothing here prints private key material.
 */
import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DataContract, DataContractCreateTransition, PlatformVersion, PrivateKey, StateTransition, ensureInitialized } from '@dashevo/evo-sdk';
import initWasmDpp2, * as dpp2 from '@dashevo/wasm-dpp2';
import bs58 from 'bs58';
import { APP_CONNECT_GROUP, appConnectEnvLines, contractFilePath, decideCreateOutcome, planAppConnectSet, sameSchemas, sha256Hex } from './app-connect-set.mjs';
import { STATE_TRANSITION_CAP, auditNodeRules, metaSchemaProblems } from './contract-probes.mjs';
import { describeErr, resolveKeyFileOwner, signerFor } from './owner-keys.mjs';
import { auditModeration, contractSource, registrationJson, withInterim } from './register-lib.mjs';
import { balanceGate, createCostEstimate, directoryProblem, formatCredits, isElected, registrationPolicy, withChallengeCoolDown, withElectionDelay, withElectionWindows } from './registration-policy.mjs';
import { envValue, keyNetwork, network } from './sdk-env.mjs';
import { NONCE_SEQUENCE_MASK, createSdkHandle, readback, sleep } from './seed/seed-lib.mjs';
import { resolveMakerOwner } from './social-battery-lib.mjs';

const SIGNATURE_ALLOWANCE = 100;
const MODES = ['--plan', '--dry-run', '--signed-dry-run', '--live'];
const generateId = (owner, nonce) => DataContract.generateId(owner, nonce).toBase58();
const big = (_key, value) => (typeof value === 'bigint' ? String(value) : value);

function parseArgs(argv) {
  const args = {
    mode: null, maker: null, startNonce: null, journal: null, upto: null, retryRefused: false,
    interim: null, electionWindows: null, electionDelay: null, challengeCoolDown: null, production: false, keyFile: null, keyId: null,
  };
  const value = (i, flag) => {
    const next = argv[i];
    if (next === undefined || next.startsWith('--')) throw new Error(`${flag} takes a value`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (MODES.includes(arg)) {
      if (args.mode) throw new Error(`pass exactly one of ${MODES.join(' | ')}`);
      args.mode = arg.slice(2);
      continue;
    }
    switch (arg) {
      case '--maker': args.maker = value(++i, arg); break;
      case '--start-nonce': args.startNonce = BigInt(value(++i, arg)); break;
      case '--journal': args.journal = value(++i, arg); break;
      case '--upto': args.upto = value(++i, arg); break;
      case '--retry-refused': args.retryRefused = true; break;
      case '--interim': args.interim = value(++i, arg); break;
      case '--election-windows': args.electionWindows = value(++i, arg); break;
      case '--election-delay': args.electionDelay = value(++i, arg); break;
      case '--challenge-cool-down': args.challengeCoolDown = value(++i, arg); break;
      case '--production': args.production = true; break;
      case '--maker-key-file': args.keyFile = value(++i, arg); break;
      case '--maker-key-id': args.keyId = value(++i, arg); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.mode) throw new Error(`pass exactly one of ${MODES.join(' | ')}`);
  if (args.mode === 'live' && !args.journal) throw new Error('--live needs --journal <file> (it keeps the signed bytes of every create)');
  if (args.mode !== 'live' && (args.journal || args.upto || args.retryRefused)) throw new Error('--journal, --upto and --retry-refused belong to --live');
  if (args.mode === 'plan' && args.startNonce === null) throw new Error('--plan needs --start-nonce <n> (the anchor\'s identity nonce)');
  return args;
}

/** The maker id and where it came from: --maker, else (devnet only) the devnet maker. */
function makerFor(args) {
  if (args.maker) return { id: args.maker, source: '--maker' };
  const devnetMaker = network() === 'devnet' ? envValue('DEVNET_MAKER_IDENTITY_ID') : undefined;
  if (devnetMaker) return { id: devnetMaker, source: 'DEVNET_MAKER_IDENTITY_ID' };
  throw new Error('pass --maker <identityId> (no devnet maker in the environment)');
}

/**
 * The config an elected declaration registers with: the run's interim (or, on
 * a devnet without --interim, the file's) and its election windows (or the
 * file's). Any other config registers as committed.
 */
function renderConfig(config, policy) {
  if (!isElected(config)) return config;
  return withChallengeCoolDown(withElectionDelay(withElectionWindows(withInterim(config, { network: network(), interim: policy.interim ?? undefined }), policy.electionWindows), policy.electionDelay), policy.challengeCoolDown);
}

/** The assembled create JSON for one entry, refusing a file whose bytes are not the pinned ones. */
function assemble(entry, ownerId, policy) {
  const bytes = readFileSync(contractFilePath(entry.file));
  const actual = sha256Hex(bytes);
  if (actual !== entry.sha256) throw new Error(`${entry.file}: sha256 ${actual} is not the pinned ${entry.sha256} (update APP_CONNECT_ENTRIES after review)`);
  const text = bytes.toString('utf8');
  if (text.includes('"SOCIAL_CONTRACT_ID"')) throw new Error(`${entry.file}: carries the SOCIAL_CONTRACT_ID placeholder; no App Connect member may embed another contract's id`);
  const declared = contractSource(text);
  const source = { ...declared, config: renderConfig(declared.config, policy) };
  return { source, json: registrationJson(source, { id: entry.id, ownerId }) };
}

/** A create at the entry's nonce, carrying the group registration (anchor only) and the membership. */
function buildCreate(entry, { plan, platformVersion, signing, policy }) {
  const { source, json } = assemble(entry, plan.groupOwner, policy);
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

/**
 * Builds and decodes one create, printing its size. Returns the bytes, the
 * signed size and what it is estimated to cost (`createCostEstimate`).
 */
function prepare(entry, { plan, platformVersion, signing, policy, feeMultiplierPermille }) {
  console.log(`  ${entry.name} (nonce ${entry.nonce})`);
  const { bytes, echoed } = buildCreate(entry, { plan, platformVersion, signing, policy });
  const size = decodeBoth(entry, bytes, { plan, echoed, signed: Boolean(signing), platformVersion });
  const estimate = createCostEstimate({ contract: echoed, signedBytes: size, feeMultiplierPermille });
  const role = entry.name === plan.anchor.name ? 'registers the group and joins it' : 'joins the group';
  console.log(`    ${signing ? '' : '~'}${size} B signed, ${role}; decoded by the wasm-sdk and wasm-dpp2; estimated ${formatCredits(estimate)}`);
  return { bytes, estimate };
}

/** How the run renders the elected contracts, as printed and journaled: null means the committed file's value. */
function describePolicy(policy) {
  const windows = policy.electionWindows ? `join ${policy.electionWindows.joinWindow} s, vote ${policy.electionWindows.voteWindow} s` : "the files' own";
  const delay = policy.electionDelay === null ? "the files' own" : `${policy.electionDelay} s`;
  return `interim ${policy.interim ?? "the files' own"}; election windows ${windows}; election delay ${delay}; challenge cool-down ${policy.challengeCoolDown === null ? "the files' own" : `${policy.challengeCoolDown} s`}`;
}

function printPlan(plan, makerSource, policy) {
  console.log(`App Connect contract set on ${network()}: maker ${plan.groupOwner} (${makerSource}), anchor nonce ${plan.anchor.nonce}`);
  console.log(`elected contracts register with: ${describePolicy(policy)}`);
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

/** What a journal records of the rendering, compared on resume (an older journal without it rendered the files' own values). */
const journalPolicy = (policy) => ({ interim: policy.interim, electionWindows: policy.electionWindows, electionDelay: policy.electionDelay, challengeCoolDown: policy.challengeCoolDown });

/**
 * A journal that matches the plan: same network, maker, anchor nonce, group,
 * interim and election windows; every entry from its pinned file at a
 * consistent id.
 */
function checkJournal(journal, plan, path, policy) {
  for (const [key, want] of [['network', network()], ['makerId', plan.groupOwner], ['startNonce', String(plan.anchor.nonce)], ['groupId', plan.groupId]]) {
    if (journal[key] !== want) throw new Error(`journal ${path}: ${key} is ${journal[key]}, this run's is ${want}`);
  }
  const recorded = JSON.stringify({ interim: journal.interim ?? null, electionWindows: journal.electionWindows ?? null, electionDelay: journal.electionDelay ?? null, challengeCoolDown: journal.challengeCoolDown ?? null });
  if (recorded !== JSON.stringify(journalPolicy(policy))) throw new Error(`journal ${path} was rendered with ${recorded}, this run with ${JSON.stringify(journalPolicy(policy))}; refusing to mix`);
  for (const c of plan.contracts) {
    const saved = journal.contracts[c.name];
    if (saved && (saved.sha256 !== c.sha256 || saved.id !== generateId(plan.groupOwner, BigInt(saved.nonce)))) {
      throw new Error(`journal ${path}: ${c.name} was prepared from another file or carries an inconsistent id; refusing to mix`);
    }
  }
}

/**
 * Replaces `path` with `contents` so that it survives a crash or power loss:
 * the data is flushed in a temporary file, renamed over the journal, and the
 * directory is flushed too. Any failure throws, which stops the run before
 * the next broadcast.
 */
function writeDurably(path, contents) {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    // Mode 0600 even when a stale temporary of another mode was left behind (open keeps an existing file's mode).
    fchmodSync(fd, 0o600);
    // writeFileSync on a descriptor loops until every byte is written (a bare writeSync may stop short).
    writeFileSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (readFileSync(tmp, 'utf8') !== contents) throw new Error(`${tmp}: the journal checkpoint did not read back intact; the previous journal is untouched`);
  renameSync(tmp, path);
  const dir = openSync(dirname(resolve(path)), 'r');
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/** Polls for a broadcast create; null when it did not show up (yet). Absence is decided by `createOutcome`. */
async function awaitContract(handle, id) {
  for (let attempt = 0; attempt < 45; attempt++) {
    await sleep(2000);
    try {
      const found = await handle.sdk.contracts.fetch(id);
      if (found) return found;
    } catch (e) {
      console.log(`  fetch: ${describeErr(e).slice(0, 120)}`);
    }
  }
  return null;
}

/**
 * What became of the create at `entry.nonce`, decided on proofs alone
 * (`decideCreateOutcome`): 'landed', 'pending' (the nonce is above the maker's,
 * or one of the still-missing ones below it, so the create may still land),
 * 'refused', or 'inconclusive' when no membership proof caught up with the
 * nonce proof's height. A contract fetch cannot decide absence: it proves
 * "not found" with no height to compare.
 */
async function createOutcome(handle, entry, plan) {
  const nonce = await readback(handle, () => handle.sdk.identities.nonceWithProof(plan.groupOwner));
  for (let attempt = 0; attempt < 5; attempt++) {
    const memberships = await readback(handle, () => handle.sdk.contractGroups.forContractWithProof(entry.id));
    const outcome = decideCreateOutcome({
      rawNonce: nonce.data ?? 0n, nonceHeight: nonce.metadata.height, nonce: entry.nonce,
      groupIds: memberships.data.contract, membershipHeight: memberships.metadata.height, groupId: plan.groupId,
    });
    if (outcome !== 'stale') return outcome;
    await sleep(3000);
  }
  return 'inconclusive';
}

/**
 * Proved read-back: the contract (its owner, and its document types equal to
 * the pinned file's, so a stray id can never pass for this entry), its
 * membership, and the group itself (owner the maker, no admins).
 */
async function verifyRegistered(handle, entry, plan, platformVersion, policy) {
  const read = (fn) => readback(handle, fn);
  const [contract, memberships, info] = await Promise.all([
    read(() => handle.sdk.contracts.fetch(entry.id)),
    read(() => handle.sdk.contractGroups.forContract(entry.id)),
    read(() => handle.sdk.contractGroups.info(plan.groupId)),
  ]);
  if (!contract || contract.ownerId.toBase58() !== plan.groupOwner) throw new Error(`${entry.name}: ${entry.id} absent or not owned by the maker`);
  const expected = DataContract.fromJSON(assemble(entry, plan.groupOwner, policy).json, true, platformVersion).toJSON(platformVersion);
  const registered = contract.toJSON(platformVersion);
  if (!sameSchemas(registered.documentSchemas, expected.documentSchemas)) throw new Error(`${entry.name}: ${entry.id} does not carry ${entry.file}'s document types`);
  if (!sameSchemas(registered.config, expected.config)) throw new Error(`${entry.name}: ${entry.id} does not carry the config this run rendered (${describePolicy(policy)})`);
  if (!memberships.contract.includes(plan.groupId)) throw new Error(`${entry.name}: ${entry.id} is not a member of ${plan.groupId}`);
  if (!info || info.ownerId !== plan.groupOwner || info.adminIds.length !== 0) throw new Error(`group ${plan.groupId}: owner ${info?.ownerId}, admins ${info?.adminIds}; expected ${plan.groupOwner} alone`);
}

/** The live run over the entries up to `--upto`, against the journal `state`. */
async function registerLive({ args, plan, state, handle, makerNonce, signing, platformVersion, policy }) {
  const save = () => writeDurably(args.journal, JSON.stringify(state, null, 2) + '\n');
  const read = (fn) => readback(handle, fn);
  /**
   * The maker's next nonce, never below what the journal already spent: a node
   * lagging behind would otherwise hand out a used nonce, and with it the id of
   * a contract already registered. Every nonce the maker spent beyond the
   * journal must not have produced a member of the group: one that did means
   * the journal lost a checkpoint, and registering again would put a second
   * copy of that contract in the group for good.
   */
  const nextNonce = async () => {
    const spent = [...Object.values(state.contracts), ...(state.refused ?? [])].map((c) => BigInt(c.nonce));
    const floor = spent.reduce((max, n) => (n > max ? n : max), plan.anchor.nonce - 1n);
    let chainNonce = await makerNonce();
    for (let attempt = 1; chainNonce < floor; attempt++) {
      if (attempt === 5) throw new Error(`the maker's nonce keeps reading behind the journal's ${floor}; re-run once the nodes catch up`);
      console.log(`  the maker's nonce reads ${chainNonce}, behind the journal's ${floor}; reading again`);
      await sleep(3000);
      chainNonce = await makerNonce();
    }
    for (let nonce = floor + 1n; nonce <= chainNonce; nonce++) {
      const id = generateId(plan.groupOwner, nonce);
      const memberships = await read(() => handle.sdk.contractGroups.forContract(id));
      if (memberships.contract.includes(plan.groupId)) throw new Error(`${id} (maker nonce ${nonce}) is in the group but not in the journal: the journal lost a checkpoint. Reconcile it by hand before registering anything else.`);
    }
    return chainNonce + 1n;
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
      // Proved refused once more before it is replaced: a create that did land must never get a twin.
      const outcome = await createOutcome(handle, { ...planned, nonce: BigInt(saved.nonce), id: saved.id }, plan);
      if (outcome === 'landed') {
        console.log(`  ${planned.name}: ${saved.id} turns out to have landed; verifying it instead of replacing it`);
        saved.state = 'broadcasting';
      } else if (outcome === 'refused') {
        state.refused = [...(state.refused ?? []), { name: planned.name, nonce: saved.nonce, id: saved.id }];
        delete state.contracts[planned.name];
        saved = undefined;
      } else {
        throw new Error(`${planned.name}: the refusal at nonce ${saved.nonce} could not be proved again (${outcome}); re-run later`);
      }
      save();
    }
    if (!saved) {
      const nonce = await nextNonce();
      if (planned === plan.anchor && nonce !== planned.nonce) throw new Error(`the anchor must take nonce ${planned.nonce} (it fixes APP_ID and GROUP_ID), but the maker's next nonce is ${nonce}`);
      if (nonce !== planned.nonce) console.log(`  NOTE: ${planned.name} takes nonce ${nonce}, not the planned ${planned.nonce}, so its id is not the plan's`);
      const entry = { ...planned, nonce, id: generateId(plan.groupOwner, nonce) };
      if (Object.values(state.contracts).some((c) => c.id === entry.id)) throw new Error(`${entry.name}: ${entry.id} is already in the journal`);
      if (await read(() => handle.sdk.contracts.fetch(entry.id))) throw new Error(`REFUSING: ${entry.name} ${entry.id} already exists on chain`);
      const { bytes } = prepare(entry, { plan, platformVersion, signing, policy });
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
      found = await awaitContract(handle, entry.id);
      if (found) break;
      const outcome = await createOutcome(handle, entry, plan);
      if (outcome === 'landed') {
        found = await read(() => handle.sdk.contracts.fetch(entry.id));
        if (found) break;
      }
      if (outcome === 'refused') {
        saved.state = 'refused'; save();
        throw new Error(`${entry.name}: the maker's nonce passed ${entry.nonce} and a membership proof at least as new shows ${entry.id} absent: the create was refused (paid), or another transition took the nonce. Investigate; --retry-refused prepares it again at the next nonce.`);
      }
      await handle.reconnect('contract not visible yet');
    }
    if (!found) throw new Error(`${entry.name} is not proven yet; re-run with the same journal (it re-broadcasts the same bytes, never a new nonce)`);
    await verifyRegistered(handle, entry, plan, platformVersion, policy);
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

/**
 * The oldest Drive that may take this set: beta.3 nodes report PV14 too but
 * cannot decode it, and social v16 needs 5.0.0-beta.6's
 * typed-array `where` and indexOnly element indexes.
 */
const MIN_DRIVE_VERSION = '5.0.0-beta.6';

/**
 * Orders two Drive versions (`major.minor.patch[-beta.N]`): negative when `a`
 * is older. A release outranks any of its betas; null for a shape it does not know.
 */
function compareDriveVersions(a, b) {
  const parse = (text) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/i.exec(String(text).trim());
    return match ? { core: [match[1], match[2], match[3]].map(Number), tag: match[4]?.toLowerCase() ?? null, n: Number(match[5] ?? 0) } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i += 1) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (x.tag === y.tag) return x.n - y.n;
  if (x.tag === null) return 1;
  if (y.tag === null) return -1;
  return x.tag < y.tag ? -1 : 1;
}

/**
 * Refuses to go on unless the node that answers runs Drive >= {@link MIN_DRIVE_VERSION}.
 * The proved protocol version cannot tell beta.3 from beta.6 (all are PV14),
 * and the set is registered with beta.6-only grammar. The status API names the
 * Drive of the one node that answered, so this cannot prove every node has
 * upgraded: confirm that with `ops/status.mjs` first.
 */
async function requireDriveVersion(handle) {
  const status = await readback(handle, () => handle.sdk.system.status());
  const drive = (status?.toJSON?.() ?? status)?.version?.software?.drive;
  const order = drive ? compareDriveVersions(drive, MIN_DRIVE_VERSION) : null;
  if (order === null) throw new Error(`could not read the nodes' Drive version from the status API (got ${JSON.stringify(drive)}); need ${MIN_DRIVE_VERSION} or newer`);
  if (order < 0) throw new Error(`the nodes run Drive ${drive}; this set needs ${MIN_DRIVE_VERSION} or newer. Upgrade the network first.`);
  console.log(`node Drive ${drive} (>= ${MIN_DRIVE_VERSION})`);
}

/**
 * The journal's directory, created 0700 when missing. Off devnet an existing
 * one must already be private to its owner: the journal holds the signed
 * creates any resume or reconciliation depends on.
 */
function prepareJournalDirectory(path) {
  const dir = dirname(resolve(path));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const problem = directoryProblem(statSync(dir));
  if (problem && network() !== 'devnet') throw new Error(`refusing the journal directory ${dir}: it ${problem}`);
}

/** The key the maker signs with: the named key file, else (devnet only) the devnet maker at seed index 9. */
function signingOwner(args, policy, maker) {
  const owner = args.keyFile !== null ? resolveKeyFileOwner({ file: args.keyFile, keyId: policy.keyId }) : resolveMakerOwner();
  if (owner.ownerId !== maker.id) throw new Error(`the signing key belongs to ${owner.ownerId}, not the maker ${maker.id}`);
  return owner;
}

/**
 * The maker's on-chain key for `owner`: an enabled AUTHENTICATION (purpose 0)
 * key at CRITICAL security level (1), the only kind a contract create takes,
 * whose public key is the one the local private key derives.
 */
async function verifySigningKey(sdk, owner) {
  const { identityKey } = await signerFor(sdk, owner);
  const { purpose, securityLevel, disabledAt } = identityKey.toObject();
  if (purpose !== 0 || securityLevel !== 1 || disabledAt !== undefined) {
    throw new Error(`key ${owner.keyId} of ${owner.ownerId} is not an enabled CRITICAL AUTHENTICATION key (purpose ${purpose}, security level ${securityLevel}${disabledAt !== undefined ? ', disabled' : ''})`);
  }
  const privateKey = PrivateKey.fromWIF(owner.wif);
  if (!identityKey.validatePrivateKey(privateKey.toBytes(), keyNetwork())) throw new Error(`the private key for ${owner.label} is not key ${owner.keyId} of ${owner.ownerId} on chain`);
  console.log(`signing key: ${owner.label}, an enabled CRITICAL AUTHENTICATION key matching the chain`);
  return { identityKey, privateKey };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = registrationPolicy({ ...args, network: network() });
  await Promise.all([ensureInitialized(), initWasmDpp2()]);
  const platformVersion = PlatformVersion.latest();
  const maker = makerFor(args);
  // Refused before anything is read from the chain: a key file others may read, a journal directory they may enter.
  // A --dry-run given a key file checks it too (on chain below), without signing.
  const signs = args.mode === 'signed-dry-run' || args.mode === 'live';
  const owner = signs || (args.keyFile !== null && args.mode !== 'plan') ? signingOwner(args, policy, maker) : null;
  if (args.mode === 'live') prepareJournalDirectory(args.journal);
  const journal = args.mode === 'live' && existsSync(args.journal) ? JSON.parse(readFileSync(args.journal, 'utf8')) : null;

  let handle = null;
  let startNonce = args.startNonce;
  let balance = null;
  let feeMultiplierPermille = 1000n;
  const makerNonce = async () => ((await readback(handle, () => handle.sdk.identities.nonce(maker.id))) ?? 0n) & NONCE_SEQUENCE_MASK;
  if (args.mode !== 'plan') {
    handle = createSdkHandle({ contractIds: [] });
    await handle.connect();
    // The protocol version the chain PROVES for the current epoch, not what a status page or one node reports.
    const epoch = await readback(handle, () => handle.sdk.epoch.currentWithProof());
    const { protocolVersion, index } = epoch.data;
    if (!(protocolVersion >= 14)) throw new Error(`contract groups need protocol version 14; the proved epoch ${index} runs ${protocolVersion}`);
    feeMultiplierPermille = BigInt(epoch.data.feeMultiplierPermille);
    await requireDriveVersion(handle);
    const chainNonce = await makerNonce();
    balance = BigInt((await readback(handle, () => handle.sdk.identities.balance(maker.id))) ?? 0n);
    console.log(`connected to ${network()}: proved epoch ${index} at height ${epoch.metadata.height} runs PV${protocolVersion}, fee multiplier ${feeMultiplierPermille}‰; maker nonce ${chainNonce}, ${formatCredits(balance)}`);
    if (journal) {
      if (startNonce !== null && startNonce !== BigInt(journal.startNonce)) throw new Error(`--start-nonce ${startNonce} disagrees with the journal's ${journal.startNonce}`);
      startNonce = BigInt(journal.startNonce);
    }
    startNonce ??= chainNonce + 1n;
    if (args.mode !== 'live' && chainNonce !== startNonce - 1n) throw new Error(`the maker is at nonce ${chainNonce}; the anchor at ${startNonce} needs it at ${startNonce - 1n}`);
  }
  // Before the balance gate, so a key file can be proved while the maker is still being funded.
  const signing = owner ? await verifySigningKey(handle.sdk, owner) : null;
  const plan = planAppConnectSet({ makerId: maker.id, startNonce, generateId });
  printPlan(plan, maker.source, policy);
  if (args.upto && !plan.contracts.some((c) => c.name === args.upto)) throw new Error(`--upto ${args.upto}: not an entry (${plan.contracts.map((c) => c.name).join(', ')})`);
  if (journal) checkJournal(journal, plan, args.journal, policy);

  // A fresh run: nothing of the planned set and not the group may exist yet. A resumed run
  // checks only what it allocates (registerLive), since a member may have landed at a later
  // nonce than planned, leaving its planned id to whatever else took that nonce.
  if (handle && Object.keys(journal?.contracts ?? {}).length === 0) {
    for (const c of plan.contracts) {
      if (await readback(handle, () => handle.sdk.contracts.fetch(c.id))) throw new Error(`REFUSING: ${c.name} ${c.id} already exists on chain`);
    }
    if (await readback(handle, () => handle.sdk.contractGroups.info(plan.groupId))) throw new Error(`REFUSING: group ${plan.groupId} already exists`);
  }

  // Every mode builds the whole set unsigned first: nothing is signed or broadcast unless all of it would pass.
  console.log('\ncreates (unsigned, at the planned nonces):');
  const estimates = new Map(plan.contracts.map((entry) => [entry.name, prepare(entry, { plan, platformVersion, signing: null, policy, feeMultiplierPermille }).estimate]));

  // What this run would still pay for: a live run skips what its journal verified and stops at --upto.
  // (A create a crashed run left `prepared` or `broadcasting` may have been paid already; it is counted again.)
  const last = args.upto ? plan.contracts.findIndex((c) => c.name === args.upto) : plan.contracts.length - 1;
  const pending = plan.contracts.slice(0, last + 1).filter((c) => journal?.contracts?.[c.name]?.state !== 'verified');
  const estimate = pending.reduce((sum, c) => sum + estimates.get(c.name), 0n);
  console.log(`\nestimated cost of ${pending.map((c) => c.name).join(', ') || 'nothing'}: ${formatCredits(estimate)}`);
  if (balance !== null) {
    const gate = balanceGate({ balance, estimate });
    const verdict = `the maker holds ${formatCredits(balance)}; signing needs ${formatCredits(gate.required)} (the estimate + 20%)`;
    if (!gate.ok && args.mode !== 'dry-run') throw new Error(`REFUSING to sign: ${verdict}. Top the maker up first.`);
    console.log(`balance gate: ${gate.ok ? 'PASS' : 'FAIL (signing would be refused)'}: ${verdict}`);
  }
  if (!signs) { printEnv(plan, 'env'); return; }

  if (args.mode === 'signed-dry-run') {
    console.log('\ncreates (signed, never broadcast):');
    for (const entry of plan.contracts) prepare(entry, { plan, platformVersion, signing, policy, feeMultiplierPermille });
    printEnv(plan, 'env');
    return;
  }

  const state = journal ?? { network: network(), makerId: plan.groupOwner, startNonce: String(plan.anchor.nonce), groupId: plan.groupId, ...journalPolicy(policy), contracts: {} };
  const verified = await registerLive({ args, plan, state, handle, makerNonce, signing, platformVersion, policy });
  printEnv({ ...plan, contracts: verified }, verified.length === plan.contracts.length ? 'env' : `env so far (${verified.length} of ${plan.contracts.length})`);
}

try {
  await main();
  process.exit(0);
} catch (e) {
  console.error(`ERROR: ${describeErr(e).split(' | ')[0]}`);
  process.exit(1);
}
