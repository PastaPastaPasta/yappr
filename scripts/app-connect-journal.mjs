/**
 * The pure rules `register-app-connect-contracts.mjs` judges a registration
 * journal and an append run by (docs/APP_CONNECT_CONTRACTS.md,
 * docs/SOCIAL_V18.md), apart from the script so they can be tested. No
 * network, no keys, no wasm: `generateId` is passed in.
 */
import { TESTNET_REGISTERED_THROUGH } from './app-connect-set.mjs';

/** What a journal records of the rendering, compared on resume (an older journal without it rendered the files' own values). */
export const journalPolicy = (policy) => ({ interim: policy.interim, electionWindows: policy.electionWindows, electionDelay: policy.electionDelay, challengeCoolDown: policy.challengeCoolDown });

/** A recorded rendering, as compared: a key the record lacks reads as null (the file's own value). */
export const policyKey = (recorded) => JSON.stringify({ interim: recorded.interim ?? null, electionWindows: recorded.electionWindows ?? null, electionDelay: recorded.electionDelay ?? null, challengeCoolDown: recorded.challengeCoolDown ?? null });

/**
 * Why a run may not go ahead on `network`, or null. Testnet already holds the
 * set's anchor and group (2026-10-21): a run there may only append after
 * {@link TESTNET_REGISTERED_THROUGH}, so a second anchor or group can never
 * be registered by mistake.
 */
export function testnetAppendProblem(network, appendAfter) {
  if (network !== 'testnet' || appendAfter === TESTNET_REGISTERED_THROUGH) return null;
  return `testnet already holds the App Connect anchor and group: pass --append-after ${TESTNET_REGISTERED_THROUGH} (and --start-nonce 57)`;
}

/** Whether an append run resumes a batch: its journal already holds one of the entries it creates. */
export const isResumedAppend = (created, journal) => created.some((c) => journal?.contracts?.[c.name] !== undefined);

/**
 * The nonces a fresh append's creates will take: the planned ones when the
 * maker's chain nonce is just below the first, else the ones after the chain
 * nonce (the maker spent nonces since the plan; each id moves with its nonce).
 * Refuses a chain nonce below the plan's, which means the anchor nonce is wrong.
 */
export function appendNonces(created, chainNonce) {
  const planned = created[0].nonce - 1n;
  if (chainNonce < planned) throw new Error(`the maker is at nonce ${chainNonce}, below ${planned}: the anchor nonce or the --append-after entry is wrong`);
  return created.map((_c, i) => chainNonce + 1n + BigInt(i));
}

/**
 * A journal that matches the plan: same network, maker, anchor nonce, group,
 * interim and election windows; every entry from its pinned file at a
 * consistent id. For an append: every entry through `appendAfter` verified at
 * its planned id, the batch's rendering the run's, and nothing prepared
 * outside the batch. Every entry still to finish must have been prepared under
 * the run's rendering, since its saved bytes are re-broadcast as they are.
 */
export function checkJournal(journal, plan, { path, policy, appendAfter, network, generateId }) {
  for (const [key, want] of [['network', network], ['makerId', plan.groupOwner], ['startNonce', String(plan.anchor.nonce)], ['groupId', plan.groupId]]) {
    if (journal[key] !== want) throw new Error(`journal ${path}: ${key} is ${journal[key]}, this run's is ${want}`);
  }
  const appends = journal.appends ?? [];
  if (appendAfter === null && appends.length > 0) throw new Error(`journal ${path} holds append batches (after ${appends.map((b) => b.after).join(', ')}); resume it with the same --append-after`);
  // An append batch renders its own new entries: its policy is recorded under `appends`, apart
  // from the original set's, and a resumed batch must name the same one.
  const batch = appendAfter === null ? null : appends.find((b) => b.after === appendAfter);
  const recordedPolicy = appendAfter === null ? journal : batch?.policy;
  const runPolicy = JSON.stringify(journalPolicy(policy));
  if (recordedPolicy && policyKey(recordedPolicy) !== runPolicy) throw new Error(`journal ${path} was rendered with ${policyKey(recordedPolicy)}, this run with ${runPolicy}; refusing to mix`);
  if (appendAfter !== null) {
    const boundary = plan.contracts.findIndex((c) => c.name === appendAfter) + 1;
    const registered = plan.contracts.slice(0, boundary);
    const missing = registered.filter((c) => journal.contracts[c.name]?.state !== 'verified').map((c) => c.name);
    if (missing.length > 0) throw new Error(`journal ${path}: --append-after ${appendAfter}, but ${missing.join(', ')} is not verified there; an append resumes the set's own journal`);
    // The group is proved at the planned ids: one landed elsewhere (a --retry-refused) needs a hand-made plan.
    const moved = registered.filter((c) => journal.contracts[c.name].id !== c.id).map((c) => `${c.name} (${journal.contracts[c.name].id}, planned ${c.id})`);
    if (moved.length > 0) throw new Error(`journal ${path}: ${moved.join(', ')} landed at another id than planned; reconcile the plan by hand before appending`);
    const strays = plan.contracts.slice(boundary).filter((c) => journal.contracts[c.name]).map((c) => c.name);
    if (strays.length > 0 && !batch) throw new Error(`journal ${path}: ${strays.join(', ')} were prepared by a run that named no --append-after ${appendAfter} batch; refusing to mix`);
  }
  for (const [name, saved] of Object.entries(journal.contracts)) {
    if (saved.state !== 'verified' && saved.policy && policyKey(saved.policy) !== runPolicy) throw new Error(`journal ${path}: ${name} was prepared with ${policyKey(saved.policy)}, this run renders ${runPolicy}; refusing to mix`);
  }
  for (const c of plan.contracts) {
    const saved = journal.contracts[c.name];
    if (saved && (saved.sha256 !== c.sha256 || saved.id !== generateId(plan.groupOwner, BigInt(saved.nonce)))) {
      throw new Error(`journal ${path}: ${c.name} was prepared from another file or carries an inconsistent id; refusing to mix`);
    }
  }
}
