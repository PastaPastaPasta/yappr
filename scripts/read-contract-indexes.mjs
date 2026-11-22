/**
 * Proved read of every declared index of a registered contract set: for each
 * document type and each index, one `documents.query` that only that index can
 * answer (equality pins on every property but the last, ordered by the last),
 * plus `documents.count` on countable indexes (every property pinned, or a
 * range on the last) and `documents.ranked` on ranked ones, by count or by
 * average (over the oldest open window on a `timeRange` index). An index passes
 * only on at least one proved read; an unproved window fails it. Pins take a stored
 * document's values when the type has one, so a populated set answers with
 * rows; otherwise typed placeholder values prove the index answers empty.
 *
 *   NETWORK=testnet node scripts/read-contract-indexes.mjs --journal <register journal> [--only social,blog] [--out FILE]
 *   NETWORK=testnet node scripts/read-contract-indexes.mjs --contract social=<id> --contract blog=<id> ...
 *
 * The journal is register-app-connect-contracts.mjs's: every `contracts.<name>.id`
 * is read. Schemas come from the chain, not the repo. Read-only; any network.
 * Exits 1 when any index read fails.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { connectSdk } from './sdk-env.mjs';
import { describeErr } from './owner-keys.mjs';

const { values } = parseArgs({ options: {
  journal: { type: 'string' }, contract: { type: 'string', multiple: true }, only: { type: 'string' }, out: { type: 'string' },
} });

function contractSet() {
  const set = [];
  if (values.journal) {
    for (const [name, entry] of Object.entries(JSON.parse(readFileSync(values.journal, 'utf8')).contracts ?? {})) {
      if (entry?.id) set.push({ name, id: entry.id });
    }
  }
  for (const pair of values.contract ?? []) {
    const [name, id] = pair.split('=');
    if (!name || !id) throw new Error(`--contract takes name=id, got ${pair}`);
    set.push({ name, id });
  }
  const only = values.only?.split(',');
  const unknown = only?.filter((name) => !set.some((entry) => entry.name === name)) ?? [];
  if (unknown.length) throw new Error(`--only names no contract in the set: ${unknown.join(', ')}`);
  const selected = only ? set.filter(({ name }) => only.includes(name)) : set;
  if (selected.length === 0) throw new Error('no contracts: pass --journal or --contract name=id');
  return selected;
}

/** Errors that say this request was answered with a refusal, so retrying can't change it. */
const DEFINITIVE = /invalid argument|InvalidArgument|where clause|not indexed|no index|query must|not countable|no ranked|unknown document type|invalid query/i;
/** A ranked read of a window no document has landed in fails proof generation instead of proving it empty. */
const COLD_BUCKET = /single-path axis read must produce exactly one axis descent/i;

let sdk;
async function read(fn) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (DEFINITIVE.test(describeErr(e)) || COLD_BUCKET.test(describeErr(e))) break;
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
    }
  }
  throw lastError;
}

const SYSTEM_TIMES = new Set(['$createdAt', '$updatedAt', '$transferredAt']);
const SYSTEM_HEIGHTS = /^\$(created|updated|transferred)At(Core)?BlockHeight$/;

/** A pin value for `property`: the sample document's, else a placeholder of the schema's type. */
function pinValue(property, schema, sample, ownerId) {
  const stored = sample?.[property];
  const definition = schema.properties?.[property] ?? {};
  const isArray = definition.type === 'array' && !definition.byteArray;
  if (stored !== undefined && stored !== null) {
    const value = isArray ? stored[0] : stored;
    if (value !== undefined) return { value, isArray };
  }
  if (property === '$ownerId' || property === '$id') return { value: ownerId, isArray: false };
  if (SYSTEM_TIMES.has(property)) return { value: Date.now(), isArray: false };
  if (SYSTEM_HEIGHTS.test(property)) return { value: 1, isArray: false };
  const item = isArray ? definition.items ?? {} : definition;
  let value;
  if ('const' in item) value = item.const;
  else if (item.enum) value = item.enum[0];
  else if (item.type === 'identifier' || item.contentMediaType === 'application/x.dash.dpp.identifier') value = ownerId;
  else if (item.type === 'boolean') value = true;
  else if (item.type === 'integer' || item.type === 'number') value = item.minimum ?? 0;
  else if (item.type === 'string') value = item.pattern?.includes('a-z') ? 'a' : 'A';
  else if (item.type === 'array' && item.byteArray) value = new Uint8Array(item.minItems ?? 32);
  else value = ownerId;
  return { value, isArray };
}

const propertyNames = (index) => index.properties.map((entry) => Object.keys(entry)[0]);

function pins(names, schema, sample, ownerId) {
  return names.map((name) => {
    const { value, isArray } = pinValue(name, schema, sample, ownerId);
    return [name, isArray ? 'contains' : '==', value];
  });
}

/** The first shape that answers, or every shape's error. */
async function firstAnswer(shapes) {
  const errors = [];
  for (const { label, run } of shapes) {
    try {
      return { ok: true, label, answer: await read(run) };
    } catch (e) {
      const message = describeErr(e);
      if (COLD_BUCKET.test(message)) return { ok: false, cold: true, errors: [`${label}: no proved answer for this window (axis-descent error): ${message.slice(0, 200)}`] };
      errors.push(`${label}: ${message.slice(0, 300)}`);
    }
  }
  return { ok: false, errors };
}

const sizeOf = (result) => (result instanceof Map ? result.size : Array.isArray(result) ? result.length : result?.size ?? 0);
function countOf(raw) {
  if (raw instanceof Map) return [...raw.values()].reduce((sum, value) => sum + Number(value ?? 0), 0);
  if (typeof raw === 'bigint' || typeof raw === 'number') return Number(raw);
  return Object.values(raw ?? {}).reduce((sum, value) => sum + Number(value ?? 0), 0);
}

async function readIndex(contractId, type, schema, index, sample, ownerId) {
  const names = propertyNames(index);
  const last = names.at(-1);
  const lastIsArray = schema.properties?.[last]?.type === 'array' && !schema.properties[last].byteArray;
  const base = { dataContractId: contractId, documentTypeName: type };
  const result = {};
  if (index.integerRange) {
    return { window: { ok: false, errors: ['integerRange windows are not read by this tool; check this index by hand'] } };
  }

  const prefix = pins(names.slice(0, -1), schema, sample, ownerId);
  const full = pins(names, schema, sample, ownerId);
  const window = (selector) => (index.timeRange
    ? { timeRange: [{ field: index.timeRange.on, selector, grid: { range: index.timeRange.range, step: index.timeRange.step } }] }
    : {});
  const lastType = schema.properties?.[last]?.type;
  const rangeable = index.rangeCountable && (SYSTEM_TIMES.has(last) || lastType === 'integer' || lastType === 'number');
  const unwindowed = pins(names.filter((name) => name !== index.timeRange?.on), schema, sample, ownerId);
  if (index.summableOffCountIndex) {
    result.query = { ok: true, skipped: true, label: `n/a, count-only (summableOffCountIndex ${index.summableOffCountIndex})`, answer: '-' };
  } else if (schema.indexOnly) {
    result.query = { ok: true, skipped: true, label: 'n/a, indexOnly type stores no documents (count and ranked only)', answer: '-' };
  } else if (index.timeRange) {
    result.query = await firstAnswer([
      { label: `${unwindowed.length} pins, newest window`, run: async () => sizeOf(await sdk.documents.query({ ...base, where: unwindowed, ...window('newest'), limit: 2 })) },
    ]);
  } else {
    result.query = await firstAnswer([
      lastIsArray
        ? { label: `${full.length} pins`, run: async () => sizeOf(await sdk.documents.query({ ...base, where: full, limit: 2 })) }
        : { label: `${prefix.length} pins, orderBy ${last}`, run: async () => sizeOf(await sdk.documents.query({ ...base, where: prefix, orderBy: [[last, 'asc']], limit: 2 })) },
      { label: `${full.length} pins`, run: async () => sizeOf(await sdk.documents.query({ ...base, where: full, limit: 2 })) },
    ]);
  }

  if (index.countable || index.rangeCountable) {
    result.count = await firstAnswer(index.timeRange
      ? [{ label: `${unwindowed.length} pins, oldest window`, run: async () => countOf(await sdk.documents.count({ ...base, where: unwindowed, ...window('oldest') })) }]
      : [
          ...(rangeable ? [{ label: `${prefix.length} pins, ${last} > 0`, run: async () => countOf(await sdk.documents.count({ ...base, where: [...prefix, [last, '>', 0]] })) }] : []),
          { label: `${full.length} pins`, run: async () => countOf(await sdk.documents.count({ ...base, where: full })) },
        ]);
  }

  if (index.rankedCountable) {
    const at = index.rankedCountable?.at;
    const groupBys = Array.isArray(at) ? [...at].reverse() : typeof at === 'string' ? [at] : [last];
    result.ranked = await firstAnswer(groupBys.map((groupBy) => {
      const before = names.slice(0, names.indexOf(groupBy)).filter((name) => name !== index.timeRange?.on);
      const where = pins(before, schema, sample, ownerId);
      return {
        label: `groupBy ${groupBy}${where.length ? `, ${where.length} pins` : ''}${index.timeRange ? ', oldest window' : ''}`,
        run: async () => (await sdk.documents.ranked({ ...base, groupBy, aggregate: { type: 'count' }, direction: 'desc', limit: 3, ...(where.length ? { where } : {}), ...window('oldest') })).entries.length,
      };
    }));
  }
  if (index.rankedAverageable && index.averageable) {
    const where = prefix;
    result.rankedAvg = await firstAnswer([{
      label: `groupBy ${last}, avg(${index.averageable})${where.length ? `, ${where.length} pins` : ''}`,
      run: async () => (await sdk.documents.ranked({ ...base, groupBy: last, aggregate: { type: 'avg', property: index.averageable }, direction: 'desc', limit: 3, ...(where.length ? { where } : {}) })).entries.length,
    }]);
  }

  if (index.rankedSummable && index.summable) {
    result.rankedSum = await firstAnswer([{
      label: `groupBy ${last}, sum(${index.summable})${prefix.length ? `, ${prefix.length} pins` : ''}`,
      run: async () => (await sdk.documents.ranked({ ...base, groupBy: last, aggregate: { type: 'sum', property: index.summable }, direction: 'desc', limit: 3, ...(prefix.length ? { where: prefix } : {}) })).entries.length,
    }]);
  }

  if (Object.values(result).every((outcome) => outcome.skipped)) {
    result.query = await firstAnswer([
      { label: `${full.length} pins (index entries)`, run: async () => sizeOf(await sdk.documents.query({ ...base, where: full, limit: 2 })) },
      { label: `${prefix.length} pins, orderBy ${last} (index entries)`, run: async () => sizeOf(await sdk.documents.query({ ...base, where: prefix, orderBy: [[last, 'asc']], limit: 2 })) },
    ]);
  }
  return result;
}

async function sampleDocument(contractId, type) {
  try {
    const result = await read(() => sdk.documents.query({ dataContractId: contractId, documentTypeName: type, limit: 1 }));
    const document = result instanceof Map ? [...result.values()].find(Boolean) : null;
    return document ? document.toJSON() : null;
  } catch (e) {
    console.log(`     (no sample for ${type}, using placeholder pins: ${describeErr(e).slice(0, 160)})`);
    return null;
  }
}

if (values.out) writeFileSync(values.out, '', { flag: 'wx', mode: 0o600 });
sdk = await connectSdk();
await sdk.epoch.current();
const report = { network: process.env.NETWORK, readAt: new Date().toISOString(), contracts: [] };
let indexes = 0;
let failed = 0;
let missing = 0;
let cold = 0;
for (const { name, id } of contractSet()) {
  const contract = await read(() => sdk.contracts.fetch(id));
  if (!contract) {
    console.log(`FAIL ${name} ${id}: contract not found`);
    missing++;
    report.contracts.push({ name, id, missing: true });
    continue;
  }
  const json = contract.toJSON();
  const entry = { name, id, version: json.version, types: [] };
  report.contracts.push(entry);
  for (const [type, schema] of Object.entries(json.documentSchemas)) {
    const sample = schema.indexOnly ? null : await sampleDocument(id, type);
    const typeEntry = { type, sampled: Boolean(sample), indexes: [] };
    entry.types.push(typeEntry);
    for (const index of schema.indices ?? []) {
      indexes++;
      const reads = await readIndex(id, type, schema, index, sample, json.ownerId);
      const ok = Object.values(reads).every((outcome) => outcome.ok);
      if (!ok) failed++;
      if (Object.values(reads).some((outcome) => outcome.cold)) cold++;
      typeEntry.indexes.push({ name: index.name, ok, reads });
      const summary = Object.entries(reads)
        .map(([mode, outcome]) => (outcome.ok ? `${mode}(${outcome.label})=${outcome.answer}` : `${mode} FAILED`))
        .join('  ');
      console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}.${type}.${index.name}  ${summary}`);
      for (const [mode, outcome] of Object.entries(reads)) {
        if (!outcome.ok) for (const error of outcome.errors) console.log(`       ${mode} ${error}`);
      }
    }
  }
}
Object.assign(report, { indexes, failed, missingContracts: missing, coldWindowIndexes: cold });
if (values.out) writeFileSync(values.out, `${JSON.stringify(report, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`, { flag: 'r+' });
console.log(`${indexes - failed}/${indexes} indexes answered${failed ? `, ${failed} FAILED` : ''}` +
  `${cold ? `; ${cold} hit an unproved window` : ''}${missing ? `; ${missing} contract(s) NOT FOUND` : ''}`);
process.exitCode = failed || missing ? 1 : 0;
