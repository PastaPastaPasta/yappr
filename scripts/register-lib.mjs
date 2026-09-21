/**
 * What the two registration scripts share for the beta.3 contract grammar:
 * appointing moderators at publish time and auditing the moderation
 * declarations off the PARSED contract.
 */
import bs58 from 'bs58';
import { describeErr } from './owner-keys.mjs';

/** The parsed config hands appointed identities back as bytes; print them as ids. */
export function renderModeration(moderation) {
  const identities = moderation.moderators?.identities;
  if (!identities) return JSON.stringify(moderation);
  const rendered = identities.map((id) => (typeof id === 'string' ? id : bs58.encode(Uint8Array.from(Object.values(id)))));
  return JSON.stringify({ ...moderation, moderators: { ...moderation.moderators, identities: rendered } });
}

/**
 * A contract config with `moderators` appointed beside the owner. A file that
 * declares no `moderation` is returned untouched: moderation cannot be turned
 * on by naming moderators, only by the config the cut was built with. Refuses
 * a cut that does not moderate when moderators are passed, so a typo in the
 * file name does not publish an unmoderated contract with a silent flag.
 */
export function withModerators(config, moderators = []) {
  if (moderators.length === 0) return config;
  if (!config?.moderation) throw new Error('--moderators was passed, but the contract file declares no `config.moderation`');
  if (moderators.length > 16) throw new Error(`at most 16 moderators may be appointed (got ${moderators.length})`);
  return {
    ...config,
    moderation: { ...config.moderation, moderators: { $type: 'appointedModerators', identities: [...new Set(moderators)] } },
  };
}

/**
 * Every appointed moderator must exist on chain, or the create is refused,
 * PAID, with ContractModeratorIdentityNotFoundError (41110). Checked before
 * anything is signed.
 */
export async function requireModeratorsExist(sdk, moderators = []) {
  const missing = [];
  for (const id of moderators) {
    try {
      if (!(await sdk.identities.fetch(id))) missing.push(id);
    } catch (e) {
      throw new Error(`could not verify moderator ${id}: ${describeErr(e).slice(0, 160)}`);
    }
  }
  if (missing.length > 0) throw new Error(`moderator identit${missing.length === 1 ? 'y does' : 'ies do'} not exist on this chain: ${missing.join(', ')}`);
  if (moderators.length > 0) console.log(`  moderators verified on chain: ${moderators.join(', ')}`);
}

/**
 * Prints the moderation grammar as the PARSED contract reports it and refuses
 * the divergences the chain would refuse (or, worse, silently drop):
 *   - `config.moderation` declared in the file but not carried by the parse
 *     (a `$formatVersion: "1"` config drops it without a word);
 *   - a `canBeDeletedByModerators` type referenced as `permanentDocument`
 *     (40122 at registration);
 *   - `actionFees.*.moderators` on an unmoderated contract (10902).
 */
export function auditModeration(documentSchemas, dataContract) {
  const parsedModeration = dataContract.config.moderation;
  // `actionFees.pricing` sits beside the per-action entries and is not one.
  const declaredModeration = Object.values(documentSchemas).some((schema) =>
    schema.canBeDeletedByModerators
    || Object.entries(schema.actionFees ?? {}).some(([action, fee]) => action !== 'pricing' && fee.moderators));
  console.log(`  moderation: ${parsedModeration ? renderModeration(parsedModeration) : 'none'}`);
  if (declaredModeration && !parsedModeration) {
    throw new Error('document types rely on moderation (canBeDeletedByModerators / moderators fees) but the parsed config carries no `moderation` — is the config $formatVersion "2"?');
  }
  const deletable = new Set(Object.entries(documentSchemas).filter(([, s]) => s.canBeDeletedByModerators).map(([name]) => name));
  if (deletable.size > 0) console.log(`  moderator delete: ${[...deletable].join(', ')}`);
  for (const name of Object.keys(documentSchemas)) {
    for (const reference of dataContract.documentTypeReferences(name)) {
      if (deletable.has(reference.documentType) && reference.type !== 'deletableDocument') {
        throw new Error(`${name}.${reference.path} references moderator-deletable "${reference.documentType}" as ${reference.type} (40122)`);
      }
    }
  }
  const fees = Object.entries(documentSchemas).filter(([, s]) => s.actionFees).map(([n, s]) => `${n}=${JSON.stringify(s.actionFees)}`);
  if (fees.length > 0) console.log(`  action fees: ${fees.join(' ')}`);
}
