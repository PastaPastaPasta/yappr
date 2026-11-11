import { readFile } from 'node:fs/promises';

export const DEFAULT_EXPLORERS = {
  testnet: ['https://testnet.platform-explorer.pshenmic.dev'],
  mainnet: ['https://api.pe.dashhq.org', 'https://platform-explorer.pshenmic.dev'],
};

async function get(base, path, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Explorer source exceeded its 60 second deadline');
  const response = await fetch(`${base.replace(/\/$/u, '')}${path}`, { signal: AbortSignal.timeout(Math.min(20000, remaining)) });
  if (!response.ok) throw new Error(`Explorer HTTP ${response.status} for ${path}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('Explorer response exceeds 8 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function* explorerCandidates(base, record) {
  const deadline = Date.now() + 60000;
  const revisions = [];
  const seen = new Set();
  for (let page = 1; ; page++) {
    if (page > 100) throw new Error('Explorer history exceeds 100 pages');
    const response = await get(base, `/document/${encodeURIComponent(record.documentId)}/revisions?limit=100&order=asc&page=${page}`, deadline);
    if (!Array.isArray(response.resultSet)) throw new Error('Explorer returned no revision list');
    if (response.resultSet.length > 100) throw new Error('Explorer exceeded the requested page size');
    const rows = response.resultSet.map(({ transitionType, timestamp, txHash, revision }) => ({ transitionType, timestamp, txHash, revision }));
    const key = JSON.stringify(rows);
    if (seen.has(key)) throw new Error('Explorer repeated a revision page');
    seen.add(key);
    revisions.push(...rows);
    if (rows.length < 100 || revisions.length >= Number(response.pagination?.total ?? Infinity)) break;
  }
  const history = revisions.filter((revision) => ['DOCUMENT_CREATE', 'DOCUMENT_REPLACE'].includes(revision.transitionType)
    && Date.parse(revision.timestamp) <= Number(record.removedAt))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const create = history.find((revision) => revision.transitionType === 'DOCUMENT_CREATE');
  for (const revision of history.reverse()) {
    const transaction = await get(base, `/transaction/${encodeURIComponent(revision.txHash)}`, deadline);
    if (typeof transaction.data !== 'string') throw new Error('Explorer returned no raw transition bytes');
    yield {
      source: base, transactionHash: revision.txHash, transitionBase64: transaction.data,
      createdAt: create ? Date.parse(create.timestamp) : undefined,
      updatedAt: Date.parse(revision.timestamp), revision: revision.revision,
    };
  }
}

export async function* fileCandidates(path) {
  const input = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(input.candidates)) throw new Error('Source file needs a candidates array');
  for (const candidate of input.candidates) yield { ...candidate, source: `file:${path}` };
}
