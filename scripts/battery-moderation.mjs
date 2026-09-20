/**
 * Contract-moderation cases shared by the battery-lib batteries (blog v3,
 * storefront v3): a ban refuses a persona's writes (41107) until an unban, and
 * a moderator deletes a document of a `canBeDeletedByModerators` type, leaving
 * a removal record. The moderator is a seed persona holding the contract
 * owner's CRITICAL key (the persona the contract was published under), or an
 * appointed one; both sign the same transitions.
 *
 * Every helper here reads its verdict back from the chain, like the rest of
 * battery-lib, and never trusts an id it did not get from the create result.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selfTest } from './battery-lib.mjs';
import { REPO_ROOT, describeErr, sleep } from './seed/seed-lib.mjs';

/**
 * battery-lib's offline `selfTest`, extended with the beta.3 declarations a
 * moderated battery is written against. Per document type, on top of
 * `agreements`/`immutable`/`immutableAllowSetting`:
 *   moderatorDeletable: whether the type carries `canBeDeletedByModerators`
 *   keepsHistory:       whether it carries `documentsKeepHistory` (a
 *                       moderator-deletable type cannot)
 * and, contract-wide, `contract.moderation` = the lists `config.moderation`
 * must keep. Every reference at a moderator-deletable type must be a
 * `deletableDocument` reference (40122 at registration otherwise).
 */
export function selfTestModerated(file, expect, contract = {}) {
  const parsed = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts', file), 'utf8'));
  const schemas = parsed.documentSchemas ?? parsed;
  const problems = [];
  const base = {};
  for (const [docType, rules] of Object.entries(expect)) {
    const { moderatorDeletable, keepsHistory, ...rest } = rules;
    base[docType] = rest;
    const schema = schemas[docType];
    if (!schema) continue; // battery-lib reports the missing type
    if (moderatorDeletable !== undefined && (schema.canBeDeletedByModerators === true) !== moderatorDeletable) {
      problems.push(`${docType} canBeDeletedByModerators is ${schema.canBeDeletedByModerators ?? false}, expected ${moderatorDeletable}`);
    }
    if (keepsHistory !== undefined && (schema.documentsKeepHistory === true) !== keepsHistory) {
      problems.push(`${docType} documentsKeepHistory is ${schema.documentsKeepHistory ?? false}, expected ${keepsHistory}`);
    }
  }
  const deletable = new Set(Object.entries(schemas).filter(([, s]) => s.canBeDeletedByModerators).map(([n]) => n));
  for (const [name, schema] of Object.entries(schemas)) {
    for (const [property, definition] of Object.entries(schema.properties ?? {})) {
      const ref = definition.refersTo;
      if (ref?.documentType && deletable.has(ref.documentType) && ref.type !== 'deletableDocument') {
        problems.push(`${name}.${property} references moderator-deletable ${ref.documentType} as ${ref.type}`);
      }
    }
  }
  if (contract.moderation) {
    const declared = parsed.config?.moderation;
    for (const [list, kept] of Object.entries(contract.moderation)) {
      if ((declared?.[list] === true) !== kept) problems.push(`config.moderation.${list} is ${declared?.[list] ?? 'undeclared'}, expected ${kept}`);
    }
    if (parsed.config?.$formatVersion !== '2') problems.push(`config.$formatVersion is ${parsed.config?.$formatVersion}, moderation needs "2"`);
  }
  const baseCode = selfTest(file, base);
  for (const problem of problems) console.error(`FAIL  ${problem}`);
  return problems.length > 0 ? 1 : baseCode;
}

export const BANNED = /\bcode"?\s*[=:]\s*41107\b|contractuserbanned|is banned/i;
export const REFERENCE_NOT_FOUND_DELETABLE = /\bcode"?\s*[=:]\s*40120\b|referenced .{0,60}not found|referencedentitynotfound/i;

/**
 * Bans `target`, proves the ban and its reason, runs `writeWhileBanned()`
 * (which must return a battery outcome to be scored as refused 41107), unbans,
 * and proves the standing is clean again.
 */
export async function caseBan(ctx, { prefix, target, writeWhileBanned, writeAfterUnban }) {
  const { battery, contractId, moderator } = ctx;
  const { sdk } = battery;
  console.log(`\n--- ${prefix}. ban ${target.label}: writes refused (41107) until the unban ---`);
  try {
    await sdk.contracts.banUser({ identity: moderator.identity, contractId, identityId: target.ownerId, reason: { text: `${prefix} battery ban` }, signer: moderator.signer });
    battery.check(`${prefix}a moderator bans ${target.label}`, true);
  } catch (e) {
    battery.check(`${prefix}a moderator bans ${target.label}`, false, describeErr(e).slice(0, 220));
    return;
  }
  await sleep(3000);
  const status = await battery.readback(() => sdk.contracts.moderationStatus({ contractId, identityId: target.ownerId, lists: ['banlist'] }));
  battery.check(`${prefix}b moderationStatus proves the ban with its reason`, status.banned === true && status.banReason?.text === `${prefix} battery ban`, JSON.stringify(status));
  battery.expectRejected(`${prefix}c ${target.label}'s create while banned is refused (41107)`, await writeWhileBanned(), BANNED);
  try {
    await sdk.contracts.unbanUser({ identity: moderator.identity, contractId, identityId: target.ownerId, signer: moderator.signer });
    battery.check(`${prefix}d moderator unbans ${target.label}`, true);
  } catch (e) {
    battery.check(`${prefix}d moderator unbans ${target.label}`, false, describeErr(e).slice(0, 220));
    return;
  }
  await sleep(3000);
  const after = await battery.readback(() => sdk.contracts.moderationStatus({ contractId, identityId: target.ownerId, lists: ['banlist'] }));
  battery.check(`${prefix}e ${target.label} is no longer banned`, after.banned === false, JSON.stringify(after));
  if (writeAfterUnban) battery.expectAccepted(`${prefix}f ${target.label}'s create lands again`, await writeAfterUnban());
}

/**
 * Deletes `documentId` of `docType` as the moderator; proves it no longer
 * fetches and that the removal record carries the reason and the owner.
 * `afterwards(ctx)` runs the battery-specific consequences (a dangling
 * reference, a count that moved).
 */
export async function caseModeratorDelete(ctx, { prefix, docType, documentId, ownerId, afterwards }) {
  const { battery, contractId, moderator } = ctx;
  const { sdk } = battery;
  console.log(`\n--- ${prefix}. moderator deletes a ${docType}: absent document, removal record ---`);
  if (!documentId) { battery.check(`${prefix} fixture`, false, `no ${docType} fixture`); return; }
  try {
    const result = await sdk.contracts.moderatorDeleteDocument({ identity: moderator.identity, contractId, documentTypeName: docType, documentId, reason: { text: `${prefix} battery takedown` }, signer: moderator.signer });
    battery.check(`${prefix}a moderator deletes the ${docType}; the proof names its owner`, String(result.documentOwnerId) === ownerId || result.documentOwnerId?.toBase58?.() === ownerId, `owner=${result.documentOwnerId} removedAt=${result.removedAt}`);
  } catch (e) {
    battery.check(`${prefix}a moderator deletes the ${docType}`, false, describeErr(e).slice(0, 220));
    return;
  }
  await sleep(3000);
  battery.check(`${prefix}b the ${docType} no longer fetches`, (await battery.fetchDocument(docType, documentId)) === null);
  const page = await battery.readback(() => sdk.contracts.documentRemovals({ contractId, documentTypeName: docType, documentIds: [documentId] }));
  const record = page.removals.find((entry) => entry.documentId === documentId);
  battery.check(`${prefix}c documentRemovals carries the record with the reason`, record?.reason?.text === `${prefix} battery takedown` && record?.documentOwnerId === ownerId, JSON.stringify(record ?? page));
  if (afterwards) await afterwards(ctx);
}
