import { createHash } from 'node:crypto';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const quorumHost = (network) => `quorums.${network}.networks.dash.org`;
const isDapi = (url) => new URL(url).pathname.replace(/^\/+/u, '/').startsWith('/org.dash.platform.dapi.v0.Platform/');

async function requestKey(input, init) {
  const request = new Request(input instanceof Request ? input.clone() : input, init);
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/u, '/') + url.search;
  return `${request.method} ${isDapi(url) ? path : url.href} ${sha256(new Uint8Array(await request.arrayBuffer()))}`;
}

export function quorumDigest(entries, network) {
  const keys = entries.filter((entry) => new URL(entry.url).hostname === quorumHost(network))
    .map(({ key, body }) => ({ key, body })).sort((a, b) => a.key.localeCompare(b.key));
  if (keys.length === 0) throw new Error('Bundle has no quorum context');
  return sha256(JSON.stringify(keys));
}

// Replaying the wire responses runs the SDK's GroveDB and quorum-signature checks again.
export function installTransport({ network, replay } = {}) {
  const original = globalThis.fetch;
  const entries = [];
  globalThis.fetch = async (input, init) => {
    const url = new Request(input instanceof Request ? input.clone() : input, init).url;
    const key = await requestKey(input, init);
    if (replay) {
      const entry = replay.find((candidate) => candidate.key === key);
      if (!entry) throw new Error(`Offline verification blocked an unrecorded request: ${key}`);
      const response = new Response(Buffer.from(entry.body, 'base64'), { status: entry.status, headers: entry.headers });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }
    const response = await original(input, init);
    if (isDapi(url) || new URL(url).hostname === quorumHost(network)) {
      const entry = { key, url, status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.clone().arrayBuffer()).toString('base64') };
      // Retries can return different heights; retain the response actually consumed last.
      const index = entries.findIndex((candidate) => candidate.key === key);
      if (index === -1) entries.push(entry);
      else entries[index] = entry;
    }
    return response;
  };
  return { entries, restore: () => { globalThis.fetch = original; } };
}

export function resetDocumentEvidence(entries) {
  const base = entries.filter((entry) => !/\/(getDocuments|getContractDocumentRemovals) /u.test(entry.key));
  entries.splice(0, entries.length, ...base);
}
