#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildSdk } from './sdk-env.mjs';
import { BUNDLE_FORMAT, json, plain, recoverCandidate, verifyContent } from './recovery/content.mjs';
import { DEFAULT_EXPLORERS, explorerCandidates, fileCandidates } from './recovery/sources.mjs';
import { installTransport, quorumDigest, resetDocumentEvidence } from './recovery/transport.mjs';

const HELP = `Read-only recovery of moderator-deleted Platform documents (no keys or fees).
  NETWORK=testnet|mainnet node scripts/recover-deleted.mjs list --contract ID --type TYPE [--owner ID] [--id ID] [--out FILE]
  NETWORK=testnet|mainnet node scripts/recover-deleted.mjs recover --contract ID --type TYPE [--id ID] [--owner ID] --out DIRECTORY
    [--explorer URL ...] [--source-file FILE ...] [--transition RAW_FILE --created-at MS --updated-at MS]
    [--platform-version 14] [--contract-version N]
  node scripts/recover-deleted.mjs verify BUNDLE --trust-quorums SHA256

Sources are untrusted; only a removal-hash match is accepted. verify is offline
and rechecks SDK proofs against the independently trusted quorum snapshot digest.
Presence or absence is a separate proved read, including restored records.
`;

function integer(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive safe integer`);
  return number;
}

export async function readPages(sdk, { contractId, type, id, owner }) {
  const pages = [];
  const records = [];
  const cursors = new Set();
  let startAfter;
  do {
    const query = { contractId, documentTypeName: type, ...(id ? { documentIds: [id] } : { limit: 100, ...(startAfter ? { startAfter } : {}) }) };
    const response = await sdk.contracts.documentRemovalsWithProof(query);
    const snapshot = response.toJSON();
    pages.push({ query, response: snapshot });
    for (const record of snapshot.data.removals) if (!owner || record.documentOwnerId === owner) records.push({ record, page: pages.length - 1 });
    startAfter = snapshot.data.nextStartAfter;
    if (startAfter && cursors.has(startAfter)) throw new Error('Removal pagination repeated a cursor');
    cursors.add(startAfter);
  } while (startAfter);
  return { pages, records };
}

async function verifyBundle(path, trust) {
  const bundle = JSON.parse(await readFile(path, 'utf8'));
  if (bundle.format !== BUNDLE_FORMAT || !['testnet', 'mainnet'].includes(bundle.network)) throw new Error('Unsupported recovery bundle');
  if (!trust || quorumDigest(bundle.transport, bundle.network) !== trust) throw new Error('Provide the independently trusted --trust-quorums digest printed during recovery');
  if (!Number.isSafeInteger(bundle.current?.metadata?.timeMs)) throw new Error('Bundle has no capture time');
  const transport = installTransport({ network: bundle.network, replay: bundle.transport, clockMs: bundle.current.metadata.timeMs });
  try {
    const sdk = buildSdk({ net: bundle.network });
    await sdk.connect();
    const contract = await sdk.contracts.fetch(bundle.contractId);
    const removal = await sdk.contracts.documentRemovalsWithProof(bundle.removal.query);
    if (json(removal.toJSON()) !== json(bundle.removal.response)) throw new Error('Removal proof response differs from bundle');
    const record = removal.toJSON().data.removals.find((item) => item.documentId === bundle.record.documentId);
    if (!record || json(record) !== json(bundle.record)) throw new Error('Bundle record is not the proved removal record');
    if (bundle.removal.query.contractId !== bundle.contractId || bundle.removal.query.documentTypeName !== bundle.type) throw new Error('Removal query targets a different contract/type');
    verifyContent(bundle, contract);
    const current = await sdk.documents.getWithProof(bundle.contractId, bundle.type, bundle.record.documentId);
    if (json(proofSnapshot(current)) !== json(bundle.current)) throw new Error('Current-state proof differs from bundle');
    console.log(`VERIFIED ${bundle.record.documentId}: document hash and SDK removal proof match; ${bundle.current.absent ? 'absent' : 'present'} at height ${bundle.current.metadata.height}.`);
    console.log('Offline evidence describes the exported heights. Quorum keys are trusted by the supplied digest; transition signature and block inclusion are not separately verified.');
  } finally { transport.restore(); }
}

// Offline replay checks every response against one capture time, so the SDK's 31-minute tolerance bounds the capture.
const CAPTURE_LIMIT_MS = 20 * 60 * 1000;

export async function captureEvidence(sdk, entries, { contractId, type }, listedRecord) {
  const started = Date.now();
  resetDocumentEvidence(entries);
  if (!await sdk.contracts.fetch(contractId)) throw new Error('Contract not found');
  const query = { contractId, documentTypeName: type, documentIds: [listedRecord.documentId] };
  const removal = { query, response: (await sdk.contracts.documentRemovalsWithProof(query)).toJSON() };
  const record = removal.response.data.removals.find((item) => item.documentId === listedRecord.documentId);
  if (!record) throw new Error('Removal record disappeared after listing');
  if (json(record) !== json(listedRecord)) throw new Error('Removal record changed while recovering; run recover again');
  const current = proofSnapshot(await sdk.documents.getWithProof(contractId, type, record.documentId));
  if (Date.now() - started > CAPTURE_LIMIT_MS) throw new Error('Proof capture took too long to verify offline; run recover again');
  return { record, removal, current };
}

function proofSnapshot(response) {
  const snapshot = response.toJSON();
  return { absent: response.data == null, metadata: snapshot.metadata, proof: snapshot.proof };
}

export async function findContent(context, contract, values, network, serialization = { platformVersion: 14 }) {
  const sources = [];
  if (values.transition) {
    const transitionBase64 = (await readFile(values.transition)).toString('base64');
    sources.push((async function* () { yield { source: `file:${values.transition}`, transitionBase64, createdAt: values['created-at'], updatedAt: values['updated-at'] }; })());
  }
  for (const path of values['source-file'] ?? []) sources.push(fileCandidates(path));
  for (const base of values.explorer ?? DEFAULT_EXPLORERS[network]) sources.push(explorerCandidates(base, context.record));
  const failures = [];
  for (const source of sources) {
    try {
      for await (const candidate of source) {
        try {
          const result = recoverCandidate(context, candidate, contract, serialization);
          return { candidate, result };
        } catch (error) { failures.push(error.message); }
      }
    } catch (error) { failures.push(error.message); }
  }
  throw new Error(`No verified copy found. ${[...new Set(failures)].join('; ') || 'No source has this document'}`);
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    contract: { type: 'string' }, type: { type: 'string' }, owner: { type: 'string' }, id: { type: 'string' },
    out: { type: 'string' }, explorer: { type: 'string', multiple: true }, 'source-file': { type: 'string', multiple: true },
    transition: { type: 'string' }, 'created-at': { type: 'string' }, 'updated-at': { type: 'string' },
    'platform-version': { type: 'string' }, 'contract-version': { type: 'string' }, 'trust-quorums': { type: 'string' }, help: { type: 'boolean' },
  } });
  const [command, file] = positionals;
  if (values.help || !command) { console.log(HELP); return; }
  if (command === 'verify') {
    if (!file || positionals.length !== 2) throw new Error('verify needs one bundle path');
    await verifyBundle(file, values['trust-quorums']);
    return;
  }
  if (!['list', 'recover'].includes(command) || positionals.length !== 1) throw new Error(HELP);
  const network = process.env.NETWORK;
  if (!['testnet', 'mainnet'].includes(network)) throw new Error('Set NETWORK=testnet or NETWORK=mainnet explicitly');
  if (!values.contract || !values.type) throw new Error('--contract and --type are required');
  if (command === 'recover' && !values.out) throw new Error('recover needs --out DIRECTORY');
  const serialization = {
    platformVersion: integer(values['platform-version'] ?? '14', 'platform-version'),
    contractVersion: values['contract-version'] ? integer(values['contract-version'], 'contract-version') : undefined,
  };
  if (values.transition && !values.id) throw new Error('--transition needs --id');
  for (const name of ['created-at', 'updated-at']) if (values[name]) integer(values[name], name);
  const transport = installTransport({ network });
  try {
    const sdk = buildSdk({ net: network });
    await sdk.connect();
    const context = { contractId: values.contract, type: values.type };
    const contract = await sdk.contracts.fetch(values.contract);
    if (!contract) throw new Error('Contract not found');
    const schema = contract.toJSON().documentSchemas[values.type];
    if (!schema) throw new Error(`Contract has no ${values.type} document type`);
    if (!schema.moderatorAbilities?.delete || schema.moderatorAbilities.deleteKeepsRecord === false) {
      console.log(`${network}: 0 recoverable removal records for ${values.contract}/${values.type}; the proved contract type does not keep moderator-removal records.`);
      if (values.out && command === 'list') await writeFile(values.out, json({ network, ...context, contract: contract.toJSON(), pages: [], transport: transport.entries }), { flag: 'wx' });
      return;
    }
    const { pages, records } = await readPages(sdk, { ...context, id: values.id, owner: values.owner });
    console.log(`${network}: ${records.length} removal record(s) for ${values.contract}/${values.type} (SDK proofs verified).`);
    for (const { record, page } of records) {
      console.log(`${record.documentId} owner=${record.documentOwnerId} moderator=${record.moderatorId} removed=${new Date(Number(record.removedAt)).toISOString()} restored=${record.restoredAt !== undefined}`);
      console.log(`  reason=${json(record.reason)} hash=${record.documentHash} proofHeight=${pages[page].response.metadata.height}`);
    }
    if (command === 'list') {
      if (values.out) await writeFile(values.out, json({ network, ...context, pages, transport: transport.entries }), { flag: 'wx' });
      return;
    }
    if (records.length === 0) return;
    await mkdir(values.out, { recursive: true });
    const sdkVersion = JSON.parse(await readFile(new URL('../node_modules/@dashevo/evo-sdk/package.json', import.meta.url), 'utf8')).version;
    let recovered = 0;
    for (const { record: listedRecord } of records) {
      try {
        const { candidate, result } = await findContent({ ...context, record: listedRecord }, contract, values, network, serialization);
        const { record, removal, current } = await captureEvidence(sdk, transport.entries, context, listedRecord);
        const bundle = plain({ format: BUNDLE_FORMAT, sdkVersion, network, ...context, record,
          removal, candidate, platformVersion: result.platformVersion, system: result.system,
          document: result.document, documentBase64: Buffer.from(result.bytes).toString('base64'), current,
          transport: transport.entries,
        });
        const digest = quorumDigest(bundle.transport, network);
        const path = resolve(join(values.out, `${record.documentId}.json`));
        await writeFile(path, json(bundle), { flag: 'wx' });
        recovered++;
        console.log(`RECOVERED ${record.documentId}: hash MATCH; ${current.absent ? 'proved absent' : 'proved present'} at height ${current.metadata.height}.`);
        console.log(json(result.document));
        console.log(`Bundle: ${path}\nQuorum snapshot SHA256 (save independently): ${digest}`);
      } catch (error) { console.error(`FAILED ${listedRecord.documentId}: ${error.message}`); }
    }
    console.log(`${values.type}: ${recovered}/${records.length} recovered and hash-verified.`);
    if (recovered !== records.length) process.exitCode = 1;
  } finally { transport.restore(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message ?? String(error)); process.exitCode = 1; });
}
