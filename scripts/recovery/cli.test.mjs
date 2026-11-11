import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { readPages } from '../recover-deleted.mjs';

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
