import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BatchTransition, EvoSDK, StateTransition } from '@dashevo/evo-sdk';
import { BUNDLE_FORMAT, json, rebuild, recoverCandidate, selectTransition, sha256d, verifyContent } from './content.mjs';
import { installTransport, quorumDigest, resetDocumentEvidence } from './transport.mjs';
import { findContent } from '../recover-deleted.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/blog-testnet.json', import.meta.url), 'utf8'));
const trustedDigest = '321835727f0bfb7cb2bb4031e9a1ac68cbcac7ef91af48810109fcd5cf132987';
let contract;
let transport;
beforeAll(async () => {
  transport = installTransport({ network: 'testnet', replay: fixture.transport, clockMs: fixture.current.metadata.timeMs });
  const sdk = EvoSDK.testnetTrusted();
  await sdk.connect();
  contract = await sdk.contracts.fetch(fixture.contractId);
});
afterAll(() => transport?.restore());

describe('captured testnet removal', () => {
  it('rebuilds the exact deleted bytes from the raw transition', () => {
    const result = recoverCandidate(fixture, fixture.candidate, contract);
    expect(sha256d(result.bytes)).toBe('064f3aa33adc9bf6516943dd4acb0ebc2769597e0f7260f845c45264c4c328ef');
    expect(Buffer.from(result.bytes).toString('base64')).toBe(fixture.documentBase64);
    expect(result.document.name).toBe('Battery mve6s7cq-doomed');
    expect(verifyContent(fixture, contract).document).toEqual(fixture.document);
  });
  it('rejects changed content, hash, serialization version and bundle version', () => {
    for (const mutate of [
      (bundle) => { bundle.document.name = 'forged'; },
      (bundle) => { bundle.documentBase64 = 'AA=='; },
      (bundle) => { bundle.record.documentHash = '0'.repeat(64); },
      (bundle) => { bundle.platformVersion = 999; },
      (bundle) => { bundle.format = `${BUNDLE_FORMAT}-unknown`; },
      (bundle) => { bundle.system.name = 'override transition content'; },
    ]) {
      const changed = structuredClone(fixture);
      mutate(changed);
      expect(() => verifyContent(changed, contract)).toThrow();
    }
  });
  it('requires the exact document, contract and owner within a batch', () => {
    const bytes = Buffer.from(fixture.candidate.transitionBase64, 'base64');
    for (const changed of [
      { ...fixture, type: 'blogPost' },
      { ...fixture, contractId: fixture.record.documentId },
      { ...fixture, record: { ...fixture.record, documentId: fixture.contractId } },
      { ...fixture, record: { ...fixture.record, documentOwnerId: fixture.contractId } },
    ]) expect(() => selectTransition(bytes, changed)).toThrow();
    expect(selectTransition(bytes, fixture).name).toBe('Battery mve6s7cq-doomed');
  });
  it('selects the document id in a batch with several transitions of the same type', () => {
    const state = StateTransition.fromBytes(Buffer.from(fixture.candidate.transitionBase64, 'base64'));
    const batch = BatchTransition.fromStateTransition(state).toObject();
    const other = structuredClone(batch.transitions[0]);
    other.$identityContractNonce += 1n;
    other.$entropy = new Uint8Array(32).fill(42);
    other.$id = new Uint8Array(32).fill(42);
    other.name = 'different document';
    batch.transitions.unshift(other);
    const bytes = BatchTransition.fromObject(batch).toStateTransition().toBytes();
    expect(selectTransition(bytes, fixture).name).toBe('Battery mve6s7cq-doomed');
  });
  it('rejects incorrect block times and contract version instead of accepting an approximation', () => {
    expect(() => recoverCandidate(fixture, { ...fixture.candidate, createdAt: fixture.candidate.createdAt + 1 }, contract)).toThrow(/No serialization matches/);
    expect(() => recoverCandidate(fixture, fixture.candidate, contract, { contractVersion: 2 })).toThrow(/No serialization matches/);
  });
  it('pins quorum context independently and blocks all uncaptured network access', async () => {
    expect(quorumDigest(fixture.transport, 'testnet')).toBe(trustedDigest);
    const changed = structuredClone(fixture.transport);
    changed.find((entry) => entry.url.includes('/quorums')).body += 'AA==';
    expect(quorumDigest(changed, 'testnet')).not.toBe(trustedDigest);
    await expect(fetch('https://example.com/')).rejects.toThrow(/blocked an unrecorded request/);
  });
  it('preserves bigint values without JSON precision loss', () => {
    expect(json({ timestamp: 9007199254740993n })).toContain('"9007199254740993"');
  });
});

describe('other captured contract types', () => {
  for (const name of ['post', 'blogComment', 'storeItem']) {
    it(`verifies the ${name} fixture through SDK proofs and content reconstruction`, async () => {
      const bundle = JSON.parse(readFileSync(new URL(`./fixtures/${name}-testnet.json`, import.meta.url), 'utf8'));
      const session = installTransport({ network: bundle.network, replay: bundle.transport });
      try {
        const sdk = EvoSDK.testnetTrusted();
        await sdk.connect();
        const schema = await sdk.contracts.fetch(bundle.contractId);
        expect(sha256d(verifyContent(bundle, schema).bytes)).toBe(bundle.record.documentHash);
        expect(recoverCandidate(bundle, bundle.candidate, schema).document).toEqual(bundle.document);
        if (name === 'blogComment') expect(bundle.document.blogPostId).toBe('CTHsREajtY3G1J9Szxot2Tzj1588NaxezwBvrsCGLWJg');
        const current = await sdk.documents.getWithProof(bundle.contractId, bundle.type, bundle.record.documentId);
        expect(current.data == null).toBe(bundle.current.absent);
      } finally { session.restore(); }
    });
  }
});


describe('replacement and untrusted sources', () => {
  it('takes revision from a replace transition rather than archive metadata', () => {
    const batch = BatchTransition.fromStateTransition(StateTransition.fromBytes(Buffer.from(fixture.candidate.transitionBase64, 'base64'))).toObject();
    const replacement = batch.transitions[0];
    replacement.$action = 'replace';
    replacement.$revision = 2n;
    replacement.name = 'Synthetic edited blog';
    const candidate = { ...fixture.candidate, transitionBase64: Buffer.from(BatchTransition.fromObject(batch).toStateTransition().toBytes()).toString('base64'), revision: 999 };
    const context = structuredClone(fixture);
    const transition = selectTransition(Buffer.from(candidate.transitionBase64, 'base64'), context);
    const expected = rebuild({ ...context, transition, system: { ...fixture.system, $revision: '2' } }, contract);
    context.record.documentHash = sha256d(expected.bytes);
    expect(recoverCandidate(context, candidate, contract).document.$revision).toBe(2);
  });
  it('tries another archive after an HTTP failure and rejects a forged candidate before a good one', async () => {
    const originalFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith('https://broken.example')) return new Response('', { status: 503 });
      if (url.includes('/revisions')) return Response.json({ resultSet: [
        { transitionType: 'DOCUMENT_CREATE', timestamp: new Date(fixture.candidate.createdAt).toISOString(), txHash: 'good', revision: 1 },
        { transitionType: 'DOCUMENT_REPLACE', timestamp: new Date(fixture.candidate.updatedAt + 1).toISOString(), txHash: 'forged', revision: 2 },
      ] });
      return Response.json({ data: url.endsWith('/forged') ? 'AAAA' : fixture.candidate.transitionBase64 });
    };
    try {
      const found = await findContent(fixture, contract, { explorer: ['https://broken.example', 'https://good.example'] }, 'testnet');
      expect(found.result.document).toEqual(fixture.document);
      expect(urls.some((url) => url.endsWith('/forged'))).toBe(true);
      expect(urls.some((url) => url.endsWith('/good'))).toBe(true);
    } finally { globalThis.fetch = originalFetch; }
  });
});


describe('per-document export evidence', () => {
  it('keeps quorum evidence and drops the contract and every document read before a new bundle', () => {
    const entries = structuredClone(fixture.transport);
    const baseCount = entries.length - 3;
    resetDocumentEvidence(entries);
    expect(entries).toHaveLength(baseCount);
    expect(entries.some((entry) => /\/(getDataContract|getDocuments|getContractDocumentRemovals) /u.test(entry.key))).toBe(false);
    entries.push({ key: 'POST /org.dash.platform.dapi.v0.Platform/getDocuments new-document', url: 'https://dapi.example/org.dash.platform.dapi.v0.Platform/getDocuments', body: 'new' });
    const bundle = structuredClone(entries);
    resetDocumentEvidence(entries);
    expect(bundle.filter((entry) => entry.key.includes('/getDocuments '))).toHaveLength(1);
    expect(entries.filter((entry) => entry.key.includes('/getDocuments '))).toHaveLength(0);
    expect(quorumDigest(bundle, 'testnet')).toBe(trustedDigest);
  });
});
