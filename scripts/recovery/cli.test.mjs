import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { captureEvidence, readPages } from '../recover-deleted.mjs';

const directory = mkdtempSync(join(tmpdir(), 'yappr-recovery-test-'));
const original = JSON.parse(readFileSync(new URL('./fixtures/blog-testnet.json', import.meta.url), 'utf8'));
const digest = '321835727f0bfb7cb2bb4031e9a1ac68cbcac7ef91af48810109fcd5cf132987';
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function verify(bundle, trust = digest) {
  const path = join(directory, 'bundle.json');
  writeFileSync(path, JSON.stringify(bundle));
  return spawnSync(process.execPath, ['scripts/recover-deleted.mjs', 'verify', path, '--trust-quorums', trust], { encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
}

describe('offline CLI verification', () => {
  it('re-verifies captured GroveDB proofs and quorum signatures without network access', () => {
    const result = verify(original);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('absent at height 668896');
  });
  it('rejects an untrusted quorum snapshot, changed record and changed raw proof', () => {
    expect(verify(original, '0'.repeat(64)).status).toBe(1);
    const changedRecord = structuredClone(original);
    changedRecord.record.reason.text = 'forged moderator reason';
    expect(verify(changedRecord).stderr).toContain('not the proved removal record');
    const changedProof = structuredClone(original);
    const response = changedProof.transport.find((entry) => entry.key.includes('/getContractDocumentRemovals '));
    expect(response).toBeDefined();
    const bytes = Buffer.from(response.body, 'base64');
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    response.body = bytes.toString('base64');
    const result = verify(changedProof);
    expect(result.status, result.stderr).toBe(1);
  });
  it('rejects a shadow response that keeps the trusted quorum digest', () => {
    const quorum = original.transport.find((entry) => new URL(entry.url).hostname.startsWith('quorums.'));
    expect(quorum).toBeDefined();
    const shadow = { ...quorum, url: 'https://archive.invalid/', body: Buffer.from('[]').toString('base64') };
    const shadowed = { ...original, transport: [shadow, ...original.transport] };
    const result = verify(shadowed);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/repeats a recorded request|does not match its request/u);
    const relabelled = { ...original, transport: original.transport.map((entry) => (entry === quorum ? { ...entry, url: 'https://archive.invalid/' } : entry)) };
    expect(verify(relabelled).stderr).toContain('does not match its request');
  });
});

describe('proved removal pagination', () => {
  it('continues past an owner-filtered empty page and keeps the page proof for each record', async () => {
    const calls = [];
    const sdk = { contracts: { documentRemovalsWithProof: async (query) => {
      calls.push(query);
      const data = query.startAfter ? { removals: [{ documentId: 'two', documentOwnerId: 'wanted' }] }
        : { removals: [{ documentId: 'one', documentOwnerId: 'other' }], nextStartAfter: 'one' };
      return { toJSON: () => ({ data }) };
    } } };
    const result = await readPages(sdk, { contractId: 'contract', type: 'post', owner: 'wanted' });
    expect(calls).toHaveLength(2);
    expect(calls[1].startAfter).toBe('one');
    expect(result.records).toEqual([{ record: { documentId: 'two', documentOwnerId: 'wanted' }, page: 1 }]);
  });
  it('uses the id query without mixing pagination options', async () => {
    let seen;
    const sdk = { contracts: { documentRemovalsWithProof: async (query) => {
      seen = query;
      return { toJSON: () => ({ data: { removals: [] } }) };
    } } };
    await readPages(sdk, { contractId: 'contract', type: 'post', id: 'one' });
    expect(seen).toEqual({ contractId: 'contract', documentTypeName: 'post', documentIds: ['one'] });
  });
  it('fails on a repeated cursor instead of truncating or looping', async () => {
    const sdk = { contracts: { documentRemovalsWithProof: async () => ({ toJSON: () => ({ data: { removals: [], nextStartAfter: 'again' } }) }) } };
    await expect(readPages(sdk, { contractId: 'contract', type: 'post' })).rejects.toThrow(/repeated a cursor/);
  });
});


describe('CLI argument checks before network calls', () => {
  it('rejects malformed serialization versions and unscoped raw transitions immediately', () => {
    for (const extra of [['--platform-version', 'oops'], ['--contract-version', '0'], ['--transition', 'raw.bin']]) {
      const result = spawnSync(process.execPath, ['scripts/recover-deleted.mjs', 'recover', '--contract', 'contract', '--type', 'post', '--out', directory, ...extra], { encoding: 'utf8', timeout: 3000, env: { ...process.env, NETWORK: 'testnet' } });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(/positive safe integer|--transition needs --id/);
    }
  });
});

describe('per-bundle proof capture', () => {
  const record = { documentId: 'doc', documentOwnerId: 'owner', documentHash: 'hash' };
  const entry = (method, body) => ({ key: `POST /org.dash.platform.dapi.v0.Platform/${method} ${body}`, url: `https://dapi.example/org.dash.platform.dapi.v0.Platform/${method}`, body });
  function fakeSdk(entries, { removed = record, onCurrent = () => {} } = {}) {
    return {
      contracts: {
        fetch: async () => { entries.push(entry('getDataContract', 'fresh')); return {}; },
        documentRemovalsWithProof: async () => { entries.push(entry('getContractDocumentRemovals', 'fresh')); return { toJSON: () => ({ data: { removals: [removed] } }) }; },
      },
      documents: { getWithProof: async () => { onCurrent(); entries.push(entry('getDocuments', 'fresh')); return { data: null, toJSON: () => ({ metadata: {}, proof: {} }) }; } },
    };
  }
  afterEach(() => vi.restoreAllMocks());

  it('re-fetches the contract with the removal and current-state proofs, long after the first contract read', async () => {
    const quorum = { key: 'GET https://quorums.testnet.networks.dash.org/quorums x', url: 'https://quorums.testnet.networks.dash.org/quorums', body: 'q' };
    const entries = [quorum, entry('getDataContract', 'stale'), entry('getContractDocumentRemovals', 'stale'), entry('getDocuments', 'stale')];
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 45 * 60 * 1000);
    const result = await captureEvidence(fakeSdk(entries), entries, { contractId: 'contract', type: 'post' }, record);
    expect(result.record).toEqual(record);
    expect(entries.map((item) => item.body)).toEqual(['q', 'fresh', 'fresh', 'fresh']);
  });
  it('refuses a record that changed since listing and a capture too slow to verify offline', async () => {
    await expect(captureEvidence(fakeSdk([], { removed: { ...record, documentHash: 'other' } }), [], { contractId: 'contract', type: 'post' }, record))
      .rejects.toThrow('changed while recovering');
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    await expect(captureEvidence(fakeSdk([], { onCurrent: () => { clock = 21 * 60 * 1000; } }), [], { contractId: 'contract', type: 'post' }, record))
      .rejects.toThrow('took too long');
  });
});

describe('quorum context recording', () => {
  it('keeps the last successful quorum response when a later refresh of it fails', async () => {
    const originalFetch = globalThis.fetch;
    const replies = [new Response('good', { status: 200 }), new Response('unavailable', { status: 503 }), new Response('newer', { status: 200 })];
    globalThis.fetch = async () => replies.shift();
    const { installTransport } = await import('./transport.mjs');
    const transport = installTransport({ network: 'testnet' });
    try {
      const url = 'https://quorums.testnet.networks.dash.org/previous';
      const body = () => Buffer.from(transport.entries[0].body, 'base64').toString();
      await fetch(url);
      await fetch(url);
      expect(transport.entries).toHaveLength(1);
      expect(body()).toBe('good');
      await fetch(url);
      expect(body()).toBe('newer');
    } finally {
      transport.restore();
      globalThis.fetch = originalFetch;
    }
  });
});
