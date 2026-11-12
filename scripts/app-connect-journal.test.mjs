import { describe, expect, it } from 'vitest';
import releaseConfig from './release-config.cjs';
import { TESTNET_REGISTERED_THROUGH, TESTNET_REHEARSAL_SET, appConnectEnvLines, entriesToCreate, planAppConnectSet, planRehearsalSet } from './app-connect-set.mjs';
import { appendNonces, checkJournal, isResumedAppend, journalIsComplete, journalPolicy, rebaseAppend, testnetAppendProblem } from './app-connect-journal.mjs';

const MAKER = TESTNET_REHEARSAL_SET.makerId;
/** A stand-in for DataContract.generateId: deterministic per (owner, nonce). */
const generateId = (owner, nonce) => `${owner.slice(0, 6)}-${nonce}`;
const plan = planRehearsalSet({ startNonce: 1n, generateId });
const created = entriesToCreate(plan.contracts, TESTNET_REGISTERED_THROUGH);
const D41 = { interim: 'notYetUsable', electionWindows: { joinWindow: 86400, voteWindow: 86400 }, electionDelay: 86400, challengeCoolDown: 1209600 };
const HOUR = { ...D41, electionWindows: { joinWindow: 3600, voteWindow: 3600 }, electionDelay: 3600 };

/** The rehearsal journal: the first eight entries verified at their planned ids, rendered with D41. */
function registeredJournal() {
  const contracts = {};
  for (const c of plan.contracts.filter((entry) => !created.includes(entry))) {
    contracts[c.name] = { nonce: String(c.nonce), id: c.id, file: c.file, sha256: c.sha256, state: 'verified' };
  }
  return { network: 'testnet', makerId: MAKER, startNonce: '1', groupId: plan.groupId, ...journalPolicy(D41), contracts };
}
const check = (journal, policy, appendAfter = TESTNET_REGISTERED_THROUGH) =>
  () => checkJournal(journal, plan, { path: 'j.json', policy, appendAfter, network: 'testnet', generateId });

describe('the testnet append guard', () => {
  it('allows new testnet makers to register v19 and keeps the historical makers guarded', () => {
    const fresh = { maker: '11111111111111111111111111111112' };
    expect(testnetAppendProblem('testnet', null, fresh)).toBeNull();
    expect(testnetAppendProblem('testnet', 'socialV18', fresh)).toMatch(/fresh registration/);
    expect(testnetAppendProblem('testnet', null)).toMatch(/explicit new maker/);
    expect(testnetAppendProblem('testnet', null, { maker: 'hbGEcFcXKJ2W9Di24ekiozTWfFszrjqkxbjfEep3D8A' })).toMatch(/requires a new maker/);
    expect(testnetAppendProblem('devnet', null)).toBeNull();
    expect(testnetAppendProblem('mainnet', null)).toBeNull();
  });

  it('appends exactly social v18, blog v10 and storefront v11 after the rehearsal vault', () => {
    expect(plan.contracts.find((c) => c.name === 'social')?.file).toBe('yappr-social-contract-v17.json');
    expect(plan.contracts.find((c) => c.name === 'blog')?.file).toBe('yappr-blog-contract.json');
    expect(plan.contracts.find((c) => c.name === 'storefront')?.file).toBe('yappr-storefront-contract.json');
    for (const file of ['yappr-social-contract-v19.json', 'yappr-blog-contract-v11.json', 'yappr-storefront-contract-v12.json']) expect(plan.contracts.some((c) => c.file === file)).toBe(false);
    expect(created.map((c) => [c.name, c.nonce])).toEqual([['socialV18', 9n], ['blogV10', 10n], ['storefrontV11', 11n]]);
    expect(plan.contracts.filter((e) => e.replacedBy).map((e) => [e.name, e.envKey, e.replacedBy])).toEqual([
      ['social', null, 'socialV18'], ['blog', null, 'blogV10'], ['storefront', null, 'storefrontV11'],
    ]);
  });
});

describe('the maker nonce of a fresh append', () => {
  it('takes the planned nonces, or the next free ones when the maker spent some since', () => {
    expect(appendNonces(created, 8n)).toEqual([9n, 10n, 11n]);
    expect(appendNonces(created, 10n)).toEqual([11n, 12n, 13n]);
    expect(() => appendNonces(created, 7n)).toThrow(/below 8/);
  });

  it('rebases the entries it creates, and so the env lines, onto the moved nonces; the registered prefix stays', () => {
    const same = rebaseAppend(plan, created, 8n, generateId);
    expect(same.plan.contracts.map((c) => c.id)).toEqual(plan.contracts.map((c) => c.id));
    expect(appConnectEnvLines(same.plan)).toEqual(appConnectEnvLines(plan));

    const moved = rebaseAppend(plan, created, 10n, generateId);
    expect(moved.created.map((c) => [c.name, c.nonce, c.id])).toEqual([
      ['socialV18', 11n, generateId(MAKER, 11n)], ['blogV10', 12n, generateId(MAKER, 12n)], ['storefrontV11', 13n, generateId(MAKER, 13n)],
    ]);
    // The registered prefix (anchor through the passkey vault) keeps its planned nonces and ids.
    const registered = plan.contracts.filter((c) => !created.includes(c));
    expect(moved.plan.contracts.slice(0, registered.length)).toEqual(registered);
    expect(moved.plan.anchor).toBe(plan.anchor);
    expect([moved.plan.appId, moved.plan.groupId]).toEqual([plan.appId, plan.groupId]);
    // Every rebased entry is the one the run builds, so the plan, the creates and the env agree.
    expect(moved.plan.contracts.slice(registered.length)).toEqual(moved.created);
    const env = appConnectEnvLines(moved.plan);
    expect(env).toContain(`NEXT_PUBLIC_YAPPR_CONTRACT_ID=${generateId(MAKER, 11n)}`);
    expect(env).toContain(`NEXT_PUBLIC_YAPPR_STOREFRONT_CONTRACT_ID=${generateId(MAKER, 13n)}`);
    expect(env.join('\n')).not.toContain(generateId(MAKER, 9n));
  });
});

describe('checkJournal on an append', () => {
  it('starts the first batch on the rehearsal journal under any rendering', () => {
    expect(check(registeredJournal(), HOUR)).not.toThrow();
    expect(isResumedAppend(created, registeredJournal())).toBe(false);
  });

  it('resumes a batch only under its own rendering', () => {
    const journal = { ...registeredJournal(), appends: [{ after: TESTNET_REGISTERED_THROUGH, policy: journalPolicy(HOUR) }] };
    journal.contracts.socialV18 = { nonce: '9', id: generateId(MAKER, 9n), sha256: created[0].sha256, policy: journalPolicy(HOUR), state: 'prepared' };
    expect(isResumedAppend(created, journal)).toBe(true);
    expect(check(journal, HOUR)).not.toThrow();
    expect(check(journal, D41)).toThrow(/refusing to mix/);
  });

  it('refuses a run that names no batch, or another one, on a journal with appends', () => {
    const journal = { ...registeredJournal(), appends: [{ after: TESTNET_REGISTERED_THROUGH, policy: journalPolicy(HOUR) }] };
    expect(check(journal, D41, null)).toThrow(/resume it with the same --append-after/);
    journal.contracts.socialV18 = { nonce: '9', id: generateId(MAKER, 9n), sha256: created[0].sha256, policy: journalPolicy(HOUR), state: 'verified' };
    journal.contracts.blogV10 = { nonce: '10', id: generateId(MAKER, 10n), sha256: created[1].sha256, policy: journalPolicy(HOUR), state: 'prepared' };
    expect(check(journal, D41, 'socialV18')).toThrow(/prepared by a run that named no --append-after socialV18 batch/);
  });

  it('refuses an unfinished entry prepared under another rendering, even with no batch policy', () => {
    const journal = { ...registeredJournal(), appends: [{ after: TESTNET_REGISTERED_THROUGH }] };
    journal.contracts.socialV18 = { nonce: '9', id: generateId(MAKER, 9n), sha256: created[0].sha256, policy: journalPolicy(D41), state: 'broadcasting' };
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

describe('the D36 rehearsal set', () => {
  const REHEARSAL = TESTNET_REHEARSAL_SET.makerId;
  const rehearsal = planRehearsalSet({ startNonce: 1n, generateId });
  const rehearsalCreated = entriesToCreate(rehearsal.contracts, TESTNET_REGISTERED_THROUGH);
  const rehearsalJournal = () => {
    const contracts = {};
    for (const c of rehearsal.contracts.filter((entry) => !rehearsalCreated.includes(entry))) {
      contracts[c.name] = { nonce: String(c.nonce), id: c.id, file: c.file, sha256: c.sha256, state: 'verified' };
    }
    return { network: 'testnet', makerId: REHEARSAL, startNonce: '1', groupId: rehearsal.groupId, interim: 'notYetUsable', electionWindows: { joinWindow: 3600, voteWindow: 3600 }, contracts };
  };
  const checkRehearsal = (journal, against = rehearsal) =>
    () => checkJournal(journal, against, { path: 'j.json', policy: HOUR, appendAfter: TESTNET_REGISTERED_THROUGH, network: 'testnet', generateId });

  it('is appended to only when named, from its own maker, on testnet, after the registered entries', () => {
    const named = { testnetSet: 'rehearsal', maker: REHEARSAL };
    expect(testnetAppendProblem('testnet', TESTNET_REGISTERED_THROUGH, named)).toBeNull();
    expect(testnetAppendProblem('testnet', null, named)).toMatch(/--append-after passkeyVault \(and --start-nonce 1\)/);
    expect(testnetAppendProblem('testnet', TESTNET_REGISTERED_THROUGH, { testnetSet: 'rehearsal', maker: '11111111111111111111111111111112' })).toMatch(/only from the rehearsal maker/);
    expect(testnetAppendProblem('testnet', TESTNET_REGISTERED_THROUGH, { maker: REHEARSAL })).toMatch(/--testnet-set rehearsal/);
    expect(testnetAppendProblem('testnet', TESTNET_REGISTERED_THROUGH, { testnetSet: 'release', maker: '11111111111111111111111111111112' })).toMatch(/takes rehearsal/);
    expect(testnetAppendProblem('devnet', null, named)).toMatch(/for testnet/);
    // A fresh release set uses a new maker and cannot append to a historical group.
    expect(testnetAppendProblem('testnet', TESTNET_REGISTERED_THROUGH, { maker: '11111111111111111111111111111112' })).toMatch(/fresh registration/);
    expect(testnetAppendProblem('testnet', null, { maker: '11111111111111111111111111111112' })).toBeNull();
  });

  it('plans its own anchor and group, pinning its registered entries to the cuts they were created from', () => {
    // The QA builds' fail-closed check names the same group (scripts/release-config.cjs).
    expect(releaseConfig.QA_BUILDS.beta.group).toEqual({ id: TESTNET_REHEARSAL_SET.groupId, owner: TESTNET_REHEARSAL_SET.makerId });
    expect(rehearsal.contracts).toHaveLength(11);
    expect(rehearsal.groupId).toBe(TESTNET_REHEARSAL_SET.groupId);
    expect(rehearsal.anchor).toBe(rehearsal.contracts[0]);
    expect(Object.keys(TESTNET_REHEARSAL_SET.registered)).toEqual(rehearsal.contracts.filter((c) => !rehearsalCreated.includes(c)).map((c) => c.name));
    expect(rehearsal.contracts.filter((c) => c.earlierCut).map((c) => c.name)).toEqual(['social', 'blog', 'storefront']);
    expect(Object.fromEntries(rehearsal.contracts.filter((c) => !rehearsalCreated.includes(c)).map((c) => [c.name, c.sha256]))).toEqual(TESTNET_REHEARSAL_SET.registered);
    expect(rehearsalCreated.map((c) => [c.name, c.nonce, c.earlierCut, c.sha256])).toEqual(
      plan.contracts.slice(-3).map((e, i) => [e.name, 9n + BigInt(i), undefined, e.sha256]));
    expect(() => planRehearsalSet({ startNonce: 57n, generateId })).toThrow(/anchor is at maker nonce 1/);
  });

  it('resumes its own journal, which the release plan refuses', () => {
    expect(checkRehearsal(rehearsalJournal())).not.toThrow();
    const releasePlan = planAppConnectSet({ makerId: REHEARSAL, startNonce: 1n, generateId });
    expect(checkRehearsal(rehearsalJournal(), releasePlan)).toThrow(/prepared from another file/);
  });
});

describe('release journal completion', () => {
  const release = planAppConnectSet({ makerId: MAKER, startNonce: 1n, generateId });
  it('completes at the vault, including a journal made by the old --upto tool', () => {
    const journal = { ...registeredJournal(), contracts: Object.fromEntries(release.contracts.map((c) => [c.name, {
      nonce: String(c.nonce), id: c.id, file: c.file, sha256: c.sha256, state: 'verified',
    }])) };
    expect(() => checkJournal(journal, release, { path: 'j.json', policy: D41, appendAfter: null, network: 'testnet', generateId })).not.toThrow();
    expect(journalIsComplete(release, journal)).toBe(true);
    journal.contracts.passkeyVault.state = 'broadcasting';
    expect(journalIsComplete(release, journal)).toBe(false);
    expect(journalIsComplete(plan, registeredJournal())).toBe(false);
  });

  it('refuses experimental entries in a release journal', () => {
    const journal = registeredJournal();
    journal.contracts.socialV18 = { state: 'verified' };
    expect(() => checkJournal(journal, release, { path: 'j.json', policy: D41, appendAfter: null, network: 'testnet', generateId })).toThrow(/outside the selected set/);
  });
});
