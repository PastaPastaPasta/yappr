import { afterEach, describe, expect, it, vi } from 'vitest';
import { explorerCandidates } from './sources.mjs';

const record = { documentId: 'document', removedAt: '1792350209042' };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });
async function collect() {
  const results = [];
  for await (const candidate of explorerCandidates('https://archive.example', record)) results.push(candidate);
  return results;
}

describe('bounded archive reads', () => {
  it('rejects a repeated full page instead of waiting through thousands of pages', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({ resultSet: Array.from({ length: 100 }, (_, index) => ({ txHash: `tx-${index}`, revision: 1, transitionType: 'DOCUMENT_CREATE', timestamp: '2026-10-18T19:03:24.067Z' })) });
    };
    await expect(collect()).rejects.toThrow(/repeated a revision page/);
    expect(calls).toBe(2);
  });
  it('enforces the whole-source deadline between requests', async () => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    globalThis.fetch = async () => {
      now = 60001;
      return Response.json({ resultSet: [{ txHash: 'tx', revision: 1, transitionType: 'DOCUMENT_CREATE', timestamp: '2026-10-18T19:03:24.067Z' }] });
    };
    await expect(collect()).rejects.toThrow(/60 second deadline/);
  });
  it('caps response bytes before parsing JSON', async () => {
    globalThis.fetch = async () => new Response('x'.repeat(8 * 1024 * 1024 + 1));
    await expect(collect()).rejects.toThrow(/exceeds 8 MiB/);
  });
});
