/**
 * The rules a contract registration runs under, as pure functions (no SDK,
 * no network, no keys), so they can be unit-tested (registration-policy.test.mjs).
 *
 * Testnet and mainnet are production networks: the contracts registered there
 * are the ones users write to, and what a create carries is frozen for good.
 * Nothing there may follow from a default, so off devnet:
 *   - NETWORK must be set (no script picks a network on its own);
 *   - the moderation interim and the election windows of an elected contract
 *     are named on the command line (`--interim`, `--election-windows`), never
 *     taken silently from the committed file;
 *   - the maker signs only with an explicit key file and key id, in a file
 *     nobody but its owner may read;
 *   - a broadcast also needs `--production`;
 *   - nothing is signed unless the maker can pay for it with a margin.
 */
import { INTERIM_KINDS, electionWindowBounds } from './contract-probes.mjs';

const NETWORKS = ['testnet', 'mainnet', 'devnet'];

/** The network named by `value` (NETWORK, or an explicit override); unset is an error, never testnet. */
export function requireNetwork(value) {
  const name = (value ?? '').trim();
  if (!name) throw new Error('NETWORK is not set: name the network explicitly (NETWORK=devnet, NETWORK=testnet or NETWORK=mainnet)');
  if (!NETWORKS.includes(name)) throw new Error(`NETWORK must be testnet, mainnet or devnet (got "${name}")`);
  return name;
}

/** `--election-windows <join>,<vote>` (seconds) as `{ joinWindow, voteWindow }`, or null when it is not that shape. */
export function parseElectionWindows(text) {
  const match = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(text ?? '');
  return match && { joinWindow: Number(match[1]), voteWindow: Number(match[2]) };
}

/** Why `windows` cannot register on `network` (empty when it can): any window within the range, and at least a day each on mainnet. */
export function electionWindowProblems(windows, network) {
  const [min, max] = electionWindowBounds(network);
  return ['joinWindow', 'voteWindow']
    .filter((key) => !Number.isSafeInteger(windows[key]) || windows[key] < min || windows[key] > max)
    .map((key) => `${key} ${windows[key]} s is outside ${min} to ${max} s on ${network}`);
}

export const isElected = (config) => config?.moderation?.moderators?.$type === 'elected';

/**
 * An elected declaration's config with its joinWindow and voteWindow replaced
 * by `windows`; any other config, or no `windows`, comes back untouched. The
 * committed files keep mainnet-legal windows; a network that elects faster
 * (testnet's one-hour windows) renders its own at registration.
 */
export function withElectionWindows(config, windows) {
  if (!windows || !isElected(config)) return config;
  const { moderators } = config.moderation;
  return { ...config, moderation: { ...config.moderation, moderators: { ...moderators, joinWindow: windows.joinWindow, voteWindow: windows.voteWindow } } };
}

const SIGNING_MODES = ['signed-dry-run', 'live'];

/**
 * Checks a publisher run's settings against its network and answers the
 * moderation it renders: `{ interim, electionWindows }`, each null when the
 * committed file's value stands (allowed on a devnet only).
 *
 * `options`: `{ network, mode, maker, interim, electionWindows (the raw flag), production, keyFile, keyId (the raw flag) }`.
 */
export function registrationPolicy(options) {
  const { network, mode, maker, interim = null, electionWindows: rawWindows = null, production = false, keyFile = null, keyId = null } = options;
  const devnet = network === 'devnet';
  const problems = [];
  if (interim !== null && !INTERIM_KINDS.includes(interim)) problems.push(`--interim must be one of ${INTERIM_KINDS.join(', ')} (got "${interim}")`);
  if (interim === 'appointedModerators') problems.push('--interim appointedModerators needs identities; declare them in the contract file');
  const electionWindows = rawWindows === null ? null : parseElectionWindows(rawWindows);
  if (rawWindows !== null && !electionWindows) problems.push(`--election-windows takes <joinSeconds>,<voteSeconds> (got "${rawWindows}")`);
  if (electionWindows) problems.push(...electionWindowProblems(electionWindows, network).map((p) => `--election-windows: ${p}`));
  if ((keyFile === null) !== (keyId === null)) problems.push('--maker-key-file and --maker-key-id go together');
  if (keyId !== null && !/^\d+$/.test(keyId)) problems.push(`--maker-key-id takes a key id (got "${keyId}")`);
  if (devnet) {
    if (production) problems.push('--production is for testnet and mainnet; this is a devnet');
  } else {
    if (!maker) problems.push(`--maker <identityId> is required on ${network}`);
    if (interim === null) problems.push(`--interim <kind> is required on ${network}: it is frozen into every elected contract`);
    if (rawWindows === null) problems.push(`--election-windows <join>,<vote> is required on ${network}: they are frozen into every elected contract`);
    if (SIGNING_MODES.includes(mode) && keyFile === null) problems.push(`--${mode} on ${network} signs with --maker-key-file <path> --maker-key-id <id>; no key is ever derived or looked up`);
    if (mode === 'live' && !production) problems.push(`--live on ${network} broadcasts to a production network: add --production`);
  }
  if (problems.length > 0) throw new Error(problems.join('\n  '));
  return { interim, electionWindows, keyId: keyId === null ? null : Number(keyId) };
}

/**
 * Why a key file may not be signed from (null when it may): it must be a
 * regular file owned by this user that no group or other user may read,
 * write or execute (mode 0600 or tighter). `stat` is an fs.Stats.
 */
export function keyFileProblem(stat, uid) {
  if (!stat.isFile()) return 'is not a regular file';
  if (uid !== undefined && stat.uid !== uid) return 'belongs to another user';
  return modeProblem(stat, '600');
}

/** Why an ops directory may not hold a production journal (null when it may): only its owner may enter it (mode 0700). */
export function directoryProblem(stat) {
  if (!stat.isDirectory()) return 'is not a directory';
  return modeProblem(stat, '700');
}

const modeProblem = (stat, chmod) => ((stat.mode & 0o077) === 0 ? null
  : `has mode ${(stat.mode & 0o777).toString(8).padStart(4, '0')}: group or other users may access it (chmod ${chmod} it)`);

/**
 * Data contract registration fees at protocol version 14 (rs-platform-version
 * fee/data_contract_registration v3, charged by rs-dpp registration_cost v2).
 */
const REGISTRATION_FEES = {
  base: 10_000_000_000n,
  documentType: 2_000_000_000n,
  index: 1_000_000_000n,
  contestedIndex: 100_000_000_000n,
  token: 10_000_000_000n,
  tokenDistribution: 10_000_000_000n,
  keyword: 10_000_000_000n,
};

/** The registration fee a contract (its parsed JSON: documentSchemas, tokens, keywords) is charged, in credits. */
export function registrationFee(contract) {
  let fee = REGISTRATION_FEES.base;
  for (const schema of Object.values(contract.documentSchemas ?? {})) {
    fee += REGISTRATION_FEES.documentType;
    for (const index of schema.indices ?? []) fee += index.contested ? REGISTRATION_FEES.contestedIndex : REGISTRATION_FEES.index;
  }
  for (const token of Object.values(contract.tokens ?? {})) {
    fee += REGISTRATION_FEES.token;
    const rules = token.distributionRules ?? {};
    for (const kind of ['perpetualDistribution', 'preProgrammedDistribution', 'oncePerIdentityDistribution']) {
      if (rules[kind] != null) fee += REGISTRATION_FEES.tokenDistribution;
    }
  }
  return fee + REGISTRATION_FEES.keyword * BigInt(contract.keywords?.length ?? 0);
}

/**
 * Storage and processing on top of the registration fee, per create: sakura's
 * beta.6 set paid 0.09e9–0.74e9 (about 0.05e9 plus 45,000 credits per signed
 * byte); this allows about twice that, scaled by the fee multiplier.
 */
const CREATE_OVERHEAD = { base: 100_000_000n, perByte: 100_000n };

/** What one create is expected to cost: its registration fee plus the storage/processing allowance for its signed size. */
export function createCostEstimate({ contract, signedBytes, feeMultiplierPermille = 1000n }) {
  const multiplier = feeMultiplierPermille > 1000n ? feeMultiplierPermille : 1000n;
  const overhead = ((CREATE_OVERHEAD.base + CREATE_OVERHEAD.perByte * BigInt(signedBytes)) * multiplier) / 1000n;
  return registrationFee(contract) + overhead;
}

const BALANCE_MARGIN_PERCENT = 20n;

/** Whether `balance` covers `estimate` plus the 20% margin: `{ ok, required }`. */
export function balanceGate({ balance, estimate }) {
  const required = estimate + (estimate * BALANCE_MARGIN_PERCENT) / 100n;
  return { ok: balance >= required, required };
}

/** Credits as `263.39e9 credits (≈15,803¢)`, at 1M credits ≈ 0.06¢ ($60/DASH). */
export function formatCredits(credits) {
  const value = Number(credits);
  const cents = value * 6e-8;
  const shown = cents >= 10 ? Math.round(cents).toLocaleString('en-US') : cents.toFixed(2);
  return `${(value / 1e9).toFixed(2)}e9 credits (≈${shown}¢)`;
}
