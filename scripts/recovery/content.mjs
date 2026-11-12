import { createHash } from 'node:crypto';
import { BatchTransition, Document, Identifier, PlatformVersion, StateTransition } from '@dashevo/evo-sdk';

export const BUNDLE_FORMAT = 'yappr-deleted-content/1';
export const sha256d = (bytes) => createHash('sha256').update(createHash('sha256').update(bytes).digest()).digest('hex');
export const json = (value) => JSON.stringify(value, (key, item) => typeof item === 'bigint' ? item.toString() : item, 2);
export const plain = (value) => JSON.parse(json(value));

export function selectTransition(bytes, { contractId, type, record }) {
  const state = StateTransition.fromBytes(bytes);
  if (state.ownerId?.toString() !== record.documentOwnerId) throw new Error('Transition signer does not match removal owner');
  const transitions = BatchTransition.fromStateTransition(state).toObject().transitions;
  const matches = transitions.filter((entry) => entry.$type === type
    && new Identifier(entry.$id).toString() === record.documentId
    && new Identifier(entry.$dataContractId).toString() === contractId
    && (entry.$action === 'create' || entry.$action === 'replace' || entry.$action === 0 || entry.$action === 1));
  if (matches.length !== 1) throw new Error('Expected exactly one matching create/replace in the signed batch');
  if (!state.signature?.length) throw new Error('Unsigned transition');
  return matches[0];
}

export function rebuild({ transition, contractId, type, record, system, platformVersion }, contract) {
  const data = Object.fromEntries(Object.entries(transition).filter(([key]) => !key.startsWith('$')));
  const fields = ['$contractVersion', '$revision', '$createdAt', '$updatedAt', '$updatedAtBlockHeight', '$createdAtBlockHeight'];
  if (Object.keys(system).some((key) => !fields.includes(key))) throw new Error('Unsupported reconstruction system field');
  const object = { ...data, ...system, $formatVersion: '0', $id: record.documentId, $ownerId: record.documentOwnerId, $dataContractId: contractId, $type: type };
  for (const key of ['$revision', '$createdAt', '$updatedAt', '$updatedAtBlockHeight', '$createdAtBlockHeight']) if (object[key] !== undefined) object[key] = BigInt(object[key]);
  const version = new PlatformVersion(platformVersion);
  const document = Document.fromObject(object, version);
  const bytes = document.toBytes(contract, version);
  return { document: Document.fromBytes(bytes, contract, type, version).toJSON(version), bytes };
}

export function recoverCandidate(context, candidate, contract, { platformVersion = 14, contractVersion } = {}) {
  const transition = selectTransition(Buffer.from(candidate.transitionBase64, 'base64'), context);
  const schema = contract.toJSON().documentSchemas[context.type];
  if (!schema) throw new Error(`Contract has no ${context.type} schema`);
  const required = schema.required ?? [];
  const createdAt = context.record.keptFields?.$createdAt ?? candidate.createdAt;
  const updatedAt = context.record.keptFields?.$updatedAt ?? candidate.updatedAt;
  const revision = context.record.keptFields?.$revision ?? transition.$revision ?? candidate.revision ?? 1;
  const heights = Object.fromEntries(['$createdAtBlockHeight', '$updatedAtBlockHeight']
    .filter((field) => required.includes(field))
    .map((field) => [field, context.record.keptFields?.[field] ?? candidate[field.slice(1)]]));
  const versions = contractVersion ? [contractVersion] : Array.from({ length: Math.min(Number(contract.version), 100) }, (_, index) => index + 1);
  // Older registrations differ in which optional system fields they keep. Only a hash match wins.
  for (const version of versions) for (const withRevision of [true, false]) for (const withUpdatedAt of [true, false]) {
    const system = { $contractVersion: version };
    if (withRevision || required.includes('$revision')) system.$revision = String(revision);
    if (createdAt !== undefined) system.$createdAt = String(createdAt);
    if ((withUpdatedAt || required.includes('$updatedAt')) && updatedAt !== undefined) system.$updatedAt = String(updatedAt);
    for (const [field, height] of Object.entries(heights)) if (height !== undefined) system[field] = String(height);
    try {
      const rebuilt = rebuild({ ...context, transition, system, platformVersion }, contract);
      if (sha256d(rebuilt.bytes) === context.record.documentHash) return { ...rebuilt, system, platformVersion };
    } catch {
      // A historical field combination may not serialize under this schema.
    }
  }
  throw new Error('No serialization matches the proved removal hash (need complete history, original times, schema or contract version)');
}

export function verifyContent(bundle, contract) {
  if (bundle.format !== BUNDLE_FORMAT) throw new Error('Unsupported recovery bundle format');
  const transition = selectTransition(Buffer.from(bundle.candidate.transitionBase64, 'base64'), bundle);
  const rebuilt = rebuild({ ...bundle, transition }, contract);
  if (sha256d(rebuilt.bytes) !== bundle.record.documentHash) throw new Error('Rebuilt document does not match removal hash');
  if (!Buffer.from(rebuilt.bytes).equals(Buffer.from(bundle.documentBase64, 'base64'))) throw new Error('Exported document bytes differ from rebuilt document');
  if (json(rebuilt.document) !== json(bundle.document)) throw new Error('Exported document differs from rebuilt document');
  return rebuilt;
}
