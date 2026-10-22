import { describe, expect, it } from 'vitest';
import { APP_CONNECT_ENTRIES, TESTNET_REGISTERED_THROUGH, entriesToCreate, planAppConnectSet } from './app-connect-set.mjs';
import { appendNonces, checkJournal, isResumedAppend, journalPolicy, testnetAppendProblem } from './app-connect-journal.mjs';

const MAKER = 'hbGEcFcXKJ2W9Di24ekiozTWfFszrjqkxbjfEep3D8A';
/** A stand-in for DataContract.generateId: deterministic per (owner, nonce). */
const generateId = (owner, nonce) => `${owner.slice(0, 6)}-${nonce}`;
const plan = planAppConnectSet({ makerId: MAKER, startNonce: 57n, generateId });
const created = entriesToCreate(plan.contracts, TESTNET_REGISTERED_THROUGH);
const D41 = { interim: 'notYetUsable', electionWindows: { joinWindow: 86400, voteWindow: 86400 }, electionDelay: 86400, challengeCoolDown: 1209600 };
const HOUR = { ...D41, electionWindows: { joinWindow: 3600, voteWindow: 3600 }, electionDelay: 3600 };

/** The 2026-10-21 journal: the first eight entries verified at their planned ids, rendered with D41. */
function registeredJournal() {
  const contracts = {};
  for (const c of plan.contracts.filter((entry) => !created.includes(entry))) {
    contracts[c.name] = { nonce: String(c.nonce), id: c.id, file: c.file, sha256: c.sha256, state: 'verified' };
  }
  return { network: 'testnet', makerId: MAKER, startNonce: '57', groupId: plan.groupId, ...journalPolicy(D41), contracts };
}
const check = (journal, policy, appendAfter = TESTNET_REGISTERED_THROUGH) =>
  () => checkJournal(journal, plan, { path: 'j.json', policy, appendAfter, network: 'testnet', generateId });

describe('the testnet append guard', () => {
  it('lets testnet only append after the registered entries, and other networks anything', () => {
    expect(testnetAppendProblem('testnet', null)).toMatch(/--append-after passkeyVault/);
    expect(testnetAppendProblem('testnet', 'socialV18')).toMatch(/already holds the App Connect anchor/);
    expect(testnetAppendProblem('testnet', TESTNET_REGISTERED_THROUGH)).toBeNull();
    expect(testnetAppendProblem('devnet', null)).toBeNull();
    expect(testnetAppendProblem('mainnet', null)).toBeNull();
  });

  it('appends exactly social v18, blog v10 and storefront v11 at nonces 65-67', () => {
    expect(created.map((c) => [c.name, c.nonce])).toEqual([['socialV18', 65n], ['blogV10', 66n], ['storefrontV11', 67n]]);
    expect(APP_CONNECT_ENTRIES.filter((e) => e.replacedBy).map((e) => [e.name, e.envKey, e.replacedBy])).toEqual([
      ['social', null, 'socialV18'], ['blog', null, 'blogV10'], ['storefront', null, 'storefrontV11'],
    ]);
  });
});

describe('the maker nonce of a fresh append', () => {
  it('takes the planned nonces, or the next free ones when the maker spent some since', () => {
    expect(appendNonces(created, 64n)).toEqual([65n, 66n, 67n]);
    expect(appendNonces(created, 66n)).toEqual([67n, 68n, 69n]);
    expect(() => appendNonces(created, 63n)).toThrow(/below 64/);
  });
});

describe('checkJournal on an append', () => {
  it('starts the first batch on the 2026-10-21 journal under any rendering', () => {
    expect(check(registeredJournal(), HOUR)).not.toThrow();
    expect(isResumedAppend(created, registeredJournal())).toBe(false);
  });

  it('resumes a batch only under its own rendering', () => {
    const journal = { ...registeredJournal(), appends: [{ after: TESTNET_REGISTERED_THROUGH, policy: journalPolicy(HOUR) }] };
    journal.contracts.socialV18 = { nonce: '65', id: generateId(MAKER, 65n), sha256: created[0].sha256, policy: journalPolicy(HOUR), state: 'prepared' };
    expect(isResumedAppend(created, journal)).toBe(true);
    expect(check(journal, HOUR)).not.toThrow();
    expect(check(journal, D41)).toThrow(/refusing to mix/);
  });

  it('refuses a run that names no batch, or another one, on a journal with appends', () => {
    const journal = { ...registeredJournal(), appends: [{ after: TESTNET_REGISTERED_THROUGH, policy: journalPolicy(HOUR) }] };
    expect(check(journal, D41, null)).toThrow(/resume it with the same --append-after/);
    journal.contracts.socialV18 = { nonce: '65', id: generateId(MAKER, 65n), sha256: created[0].sha256, policy: journalPolicy(HOUR), state: 'verified' };
    journal.contracts.blogV10 = { nonce: '66', id: generateId(MAKER, 66n), sha256: created[1].sha256, policy: journalPolicy(HOUR), state: 'prepared' };
    expect(check(journal, D41, 'socialV18')).toThrow(/prepared by a run that named no --append-after socialV18 batch/);
  });

  it('refuses an unfinished entry prepared under another rendering, even with no batch policy', () => {
    const journal = { ...registeredJournal(), appends: [{ after: TESTNET_REGISTERED_THROUGH }] };
    journal.contracts.socialV18 = { nonce: '65', id: generateId(MAKER, 65n), sha256: created[0].sha256, policy: journalPolicy(D41), state: 'broadcasting' };
    expect(check(journal, HOUR)).toThrow(/socialV18 was prepared with/);
  });

  it('refuses a journal whose registered entries are not all verified, or not at their planned ids', () => {
    const unverified = registeredJournal();
    unverified.contracts.pollr.state = 'broadcasting';
    expect(check(unverified, D41)).toThrow(/pollr is not verified there/);
    const moved = registeredJournal();
    moved.contracts.pollr = { ...moved.contracts.pollr, nonce: '70', id: generateId(MAKER, 70n) };
    expect(check(moved, D41)).toThrow(/pollr .* landed at another id than planned/);
  });

  it('refuses another network, maker or anchor', () => {
    expect(check({ ...registeredJournal(), network: 'devnet' }, D41)).toThrow(/network is devnet/);
    expect(check({ ...registeredJournal(), startNonce: '58' }, D41)).toThrow(/startNonce is 58/);
  });
});
