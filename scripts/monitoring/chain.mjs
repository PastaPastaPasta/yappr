#!/usr/bin/env node
// This worker contains only proved reads. No keys, signers or transitions.
import { EvoSDK, PlatformVersion } from '@dashevo/evo-sdk';
import { checkAppConnectGroupTrust } from 'platform-auth';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expectations } from './manifest.mjs';
import { appConnectConfig, schemaHash, thresholds } from './config.mjs';
import { fetchText } from './sites.mjs';

const CHARTERS = 'EG7RGfV8fDTayC2FyVr8HwdpJh3fXDbVztcfE94UmN88';
const DPNS = 'GWRSAVFMjXx8HpQFaNJMqBV7MBgMK4br5UESsB4S31Ec';

function installPathShim(addresses) {
  const origins = new Set(addresses.map(address => new URL(address).origin));
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (origins.has(url.origin) && url.pathname.startsWith('//org.dash.platform.')) {
      url.pathname = url.pathname.slice(1);
      if (input instanceof Request) input = new Request(url, input);
      else input = url;
    }
    return original(input, init);
  };
}

export function checkFresh(metadata, limits, now = Date.now()) {
  const age = now - Number(metadata.timeMs);
  if (!Number.isFinite(age) || age > limits.MAX_PROOF_AGE_SECONDS * 1000 || age < -60000) throw new Error(`Proved block time is stale or invalid (age ${age} ms)`);
  if (metadata.protocolVersion < limits.MIN_PROTOCOL) throw new Error(`Proved protocol ${metadata.protocolVersion} below ${limits.MIN_PROTOCOL}`);
}

export function activityFilters(schema) {
  const indexes = schema.indices ?? [];
  if (indexes.some(index => Object.keys(index.properties[0])[0] === '$createdAt')) return [[]];
  for (const index of indexes) {
    if (index.properties.length < 2 || Object.keys(index.properties[1])[0] !== '$createdAt') continue;
    const field = Object.keys(index.properties[0])[0];
    const property = schema.properties[field];
    const boundedIntegers = property?.type === 'integer' && Number.isInteger(property.minimum) && Number.isInteger(property.maximum) && property.maximum >= property.minimum && property.maximum - property.minimum <= 20;
    const values = property?.enum ?? (property?.const !== undefined ? [property.const] : boundedIntegers ? Array.from({ length: property.maximum - property.minimum + 1 }, (_, i) => property.minimum + i) : null);
    if (!values?.length) continue;
    const optional = !schema.required?.includes(field);
    // An index that drops an optional field cannot establish a complete count.
    if (optional && index.skipIfAbsent) continue;
    return [...new Set([...(optional ? [null] : []), ...values])].map(value => [[field, '==', value]]);
  }
  throw new Error('No usable bounded time index for activity signal');
}

export async function countActivity(sdk, id, type, schema, since, max) {
  let count = 0;
  for (const prefix of activityFilters(schema)) {
    let startAfter;
    while (count <= max) {
      const page = await sdk.documents.query({ dataContractId: id, documentTypeName: type, where: [...prefix, ['$createdAt', '>=', since]], orderBy: [['$createdAt', 'asc']], limit: 100, ...(startAfter ? { startAfter } : {}) });
      const docs = [...page.values()].filter(Boolean);
      count += docs.length;
      const last = docs.at(-1);
      startAfter = last?.id.toBase58();
      for (const doc of docs) doc.free();
      if (page.size < 100) break;
      if (!startAfter) throw new Error('Activity pagination made no progress');
    }
    if (count > max) break;
  }
  if (count > max) throw new Error(`${type}: at least ${count} documents in window; threshold ${max}`);
  return `${type}: ${count} retained documents in window (threshold ${max})`;
}

export async function checkAppConnectGroup(sdk, env, limits) {
  const pins = appConnectConfig(env);
  if (!pins) throw new Error('No App Connect group configured');
  const { groupId, groupOwner: ownerId } = pins;
  const pinned = pins.members.map(member => ({ kind: 'contract', contractId: member.contractId }));
  const response = await sdk.contractGroups.infoWithProof(groupId);
  checkFresh(response.metadata, limits);
  const info = response.data;
  if (!info) throw new Error('App Connect group-not-found');
  try {
    const members = [];
    for (const kind of ['contracts', 'documentTypes', 'tokens']) {
      let startAfter;
      const seen = new Set();
      for (let pages = 0; ; pages++) {
        if (pages >= 100) throw new Error(`App Connect ${kind} membership exceeds monitoring page limit`);
        const result = await sdk.contractGroups.membersWithProof({ contractGroupId: groupId, kind, limit: 100, ...(startAfter ? { startAfter } : {}) });
        checkFresh(result.metadata, limits);
        const page = result.data;
        if (page.kind !== kind) throw new Error('App Connect membership kind mismatch');
        members.push(...(page.contracts ?? []).map(contractId => ({ kind: 'contract', contractId })),
          ...(page.documentTypes ?? []).map(member => ({ kind: 'documentType', ...member })),
          ...(page.tokens ?? []).map(member => ({ kind: 'token', contractId: member.contractId, position: member.tokenPosition })));
        if (!page.nextStartAfter) break;
        const cursor = schemaHash(page.nextStartAfter);
        if (seen.has(cursor)) throw new Error('App Connect membership pagination made no progress');
        seen.add(cursor);
        startAfter = page.nextStartAfter;
      }
    }
    const trust = await checkAppConnectGroupTrust({ groupInfo: async () => ({ ownerId: info.ownerId, adminIds: info.adminIds, members }) }, { groupId, ownerId, adminIds: [], members: pinned });
    if (!trust.ok) throw new Error(`App Connect ${trust.reason}${trust.members ? `: ${JSON.stringify(trust.members)}` : ''}`);
    return `Owner ${ownerId}; no admins; ${members.length} exact pinned members across all kinds (proved)`;
  } finally { info.free(); }
}

async function main() {
  const name = process.argv[2];
  const limits = thresholds();
  const manifestPath = process.argv[3];
  const config = manifestPath ? JSON.parse(readFileSync(manifestPath, 'utf8')).networks?.[name] : await expectations(process.cwd(), name);
  if (!config) throw new Error(`Deployment artifact has no ${name} network expectations`);
  async function record(suffix, fn) {
    const start = Date.now();
    let result;
    try { result = { key: `chain/${name}/${suffix}`, status: 'pass', detail: await fn() }; }
    catch (error) { result = { key: `chain/${name}/${suffix}`, status: 'fail', detail: String(error.message ?? error) }; }
    console.log(JSON.stringify({ ...result, ms: Date.now() - start }));
    return result;
  }
  if (config.skip) {
    console.log(JSON.stringify({ key: `chain/${name}`, status: 'skip', detail: config.skip }));
    return;
  }
  const { env } = config;
  const quorumUrl = env.NEXT_PUBLIC_QUORUM_URL || (config.network === 'devnet' ? `https://quorums.${env.NEXT_PUBLIC_DEVNET_NAME}.networks.dash.org` : 'https://quorums.testnet.networks.dash.org');
  let addresses = [...new Set((env.NEXT_PUBLIC_DAPI_ADDRESSES ?? '').split(',').map(address => address.trim()).filter(Boolean).map(address => new URL(address.includes('://') ? address : `https://${address}`).origin))];
  const discovery = await record('quorum', async () => {
    const list = JSON.parse(await fetchText(`${quorumUrl}/masternodes`));
    if (!addresses.length) addresses = [...new Set((list.data ?? []).filter(node => node.status === 'ENABLED').flatMap(node => node.addresses?.platform_https ?? []).map(address => `https://${address}`))];
    if (addresses.length < limits.NODE_SAMPLE) throw new Error(`Need ${limits.NODE_SAMPLE} distinct DAPI nodes; found ${addresses.length}`);
    return `${quorumUrl}; ${addresses.length} DAPI nodes discovered/configured; BLS trust context checked by node probes`;
  });
  if (discovery.status === 'fail') return;
  installPathShim(addresses);
  const healthy = [];
  const samples = [];
  for (const address of addresses.slice(0, limits.NODE_SAMPLE)) {
    const start = Date.now();
    try {
      const sdk = new EvoSDK({ network: config.network, trusted: true, addresses: [address], quorumUrl, ...(config.network === 'devnet' ? { devnetName: env.NEXT_PUBLIC_DEVNET_NAME } : {}), settings: { timeoutMs: 12000, connectTimeoutMs: 12000, retries: 0 } });
      await sdk.connect();
      // The system contract read ratchets rs-sdk's initial protocol floor.
      await sdk.contracts.fetch(DPNS);
      const response = await sdk.epoch.currentWithProof();
      const epoch = response.data;
      const metadata = response.metadata;
      checkFresh(metadata, limits);
      if (epoch.protocolVersion < limits.MIN_PROTOCOL) throw new Error(`Epoch protocol ${epoch.protocolVersion} below ${limits.MIN_PROTOCOL}`);
      const protocol = await sdk.protocol.versionUpgradeState();
      if (protocol.currentProtocolVersion < limits.MIN_PROTOCOL) throw new Error(`Proved protocol state ${protocol.currentProtocolVersion} below ${limits.MIN_PROTOCOL}`);
      healthy.push(sdk);
      samples.push(`${address}: proved epoch ${epoch.index}, epoch PV${epoch.protocolVersion}, current PV${protocol.currentProtocolVersion}, height ${metadata.height}, block ${new Date(Number(metadata.timeMs)).toISOString()} (${Date.now() - start} ms)`);
    } catch (error) { samples.push(`${address}: FAILED ${error.message ?? error} (${Date.now() - start} ms)`); }
  }
  await record('nodes', async () => {
    if (healthy.length !== limits.NODE_SAMPLE) throw new Error(samples.join('; '));
    return samples.join('; ');
  });
  await record('availability', async () => {
    if (healthy.length < limits.NODE_MIN) throw new Error(`${healthy.length}/${limits.NODE_SAMPLE} nodes healthy; need ${limits.NODE_MIN}`);
    return `${healthy.length}/${limits.NODE_SAMPLE} nodes verified proofs`;
  });
  const sdk = healthy[0];
  if (!sdk) return;
  const pv = PlatformVersion.latest();
  const owners = new Set();
  if (env.NEXT_PUBLIC_APP_CONNECT_GROUP_ID || env.NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER || env.NEXT_PUBLIC_APP_CONNECT_GROUP_MEMBERS) {
    await record('app-connect/group', () => checkAppConnectGroup(sdk, env, limits));
  } else {
    console.log(JSON.stringify({ key: `chain/${name}/app-connect/group`, status: 'skip', detail: 'No App Connect group configured' }));
  }

  for (const pin of config.pins) {
    let json;
    await record(`contract/${pin.id}`, async () => {
      const contract = await sdk.contracts.fetch(pin.id);
      if (!contract) throw new Error(`Contract ${pin.id} missing`);
      try {
        owners.add(contract.ownerId.toBase58());
        json = contract.toJSON(pv);
        const hash = schemaHash(json);
        if (pin.error) throw new Error(pin.error);
        if (contract.version !== pin.version) throw new Error(`Version ${contract.version}; expected ${pin.version}`);
        if (hash !== pin.schemaHash) throw new Error(`Schema hash ${hash}; expected ${pin.schemaHash}`);
        return `v${contract.version}, sha256 ${hash}`;
      } finally { contract.free(); }
    });
    if (!json) continue;
    if (json.config?.moderation?.moderators?.$type === 'elected') {
      await record(`pot/${pin.id}`, async () => {
        const pots = await sdk.contracts.feePots(pin.id);
        const credits = pots.moderators.credits;
        if (credits < BigInt(limits.POT_MIN_CREDITS) || credits > BigInt(limits.POT_MAX_CREDITS)) throw new Error(`Moderation pot ${credits} credits outside ${limits.POT_MIN_CREDITS}..${limits.POT_MAX_CREDITS}`);
        return `${credits} credits; last claim epoch ${pots.moderators.lastClaimEpoch ?? 'never'}`;
      });
      await record(`charter/${pin.id}`, async () => {
        const allowed = JSON.parse(process.env.MONITOR_CHARTER_LEADERS || '{}')[name]?.[pin.id] ?? [json.ownerId];
        if (!Array.isArray(allowed) || !allowed.length || allowed.some(id => typeof id !== 'string')) throw new Error('Charter leader allowlist must be a nonempty array of identity ids');
        const state = await sdk.voting.contestedResourceVoteState({ dataContractId: CHARTERS, documentTypeName: 'electedCharter', indexName: 'byTargetContract', indexValues: [pin.id], resultType: 'documentsAndVoteTally', limit: 100 });
        try {
          const contenders = state.contenders.map(contender => contender.identityId.toBase58());
          const rival = contenders.filter(id => !allowed.includes(id));
          const winner = state.winner;
          const winnerId = winner?.identityId?.toBase58();
          if (winnerId && !allowed.includes(winnerId)) rival.push(winnerId);
          if (rival.length || contenders.length >= 100) throw new Error(`Unexpected charter leaders: ${rival.join(', ') || 'contender list saturated'}; allowed ${allowed.join(', ')}`);
          const team = await sdk.moderationCharters.team(pin.id);
          const leader = team?.leaderId.toBase58();
          if (leader && !allowed.includes(leader)) throw new Error(`Seated leader outside allowlist: ${leader}`);
          return `${contenders.length} contenders; allowed ${allowed.join(', ')}; seated ${team ? 'yes' : 'no (election pending)'}`;
        } finally { state.free(); }
      });
    }
    for (const type of ['post', 'report']) {
      const schema = json.documentSchemas?.[type];
      if (!schema) continue;
      await record(`rate/${pin.id}/${type}`, () => countActivity(sdk, pin.id, type, schema, Date.now() - limits.WINDOW_MINUTES * 60000, type === 'post' ? limits.POST_MAX : limits.REPORT_MAX));
    }
  }
  // Contract owners are the sponsors. Check all owners, including non-group contracts.
  const pinnedMaker = env.NEXT_PUBLIC_APP_CONNECT_GROUP_OWNER || env.DEVNET_MAKER_IDENTITY_ID || env.TESTNET_MAKER_IDENTITY_ID;
  if (pinnedMaker) owners.add(pinnedMaker);
  for (const owner of owners) await record(`maker/${owner}`, async () => {
    const credits = await sdk.identities.balance(owner);
    if (credits === undefined || credits < BigInt(limits.MAKER_MIN_CREDITS)) throw new Error(`Maker ${owner}: ${credits ?? 'missing'} credits; minimum ${limits.MAKER_MIN_CREDITS} (~2 tDASH at default)`);
    return `${credits} credits (minimum ${limits.MAKER_MIN_CREDITS})`;
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().then(() => process.exit(0)).catch(error => { console.error(error.message ?? error); process.exit(1); });
