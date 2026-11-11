import { createHash } from 'node:crypto';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const quorumHost = (network) => `quorums.${network}.networks.dash.org`;
const isDapi = (url) => new URL(url).pathname.replace(/^\/+/u, '/').startsWith('/org.dash.platform.dapi.v0.Platform/');

function requestTarget(href) {
  const url = new URL(href);
  return isDapi(url) ? url.pathname.replace(/^\/+/u, '/') + url.search : url.href;
}

async function requestKey(input, init) {
  const request = new Request(input instanceof Request ? input.clone() : input, init);
  return `${request.method} ${requestTarget(request.url)} ${sha256(new Uint8Array(await request.arrayBuffer()))}`;
}

// The digest and the replay lookup must select the same responses, so both go by key.
function checkReplay(entries) {
  const seen = new Set();
  for (const entry of entries) {
    const target = entry.key.split(' ')[1];
    if (seen.has(entry.key)) throw new Error(`Bundle repeats a recorded request: ${entry.key}`);
    if (requestTarget(entry.url) !== target) throw new Error(`Bundle entry URL does not match its request: ${entry.key}`);
    seen.add(entry.key);
  }
}

export function quorumDigest(entries, network) {
  checkReplay(entries);
  const keys = entries.filter((entry) => URL.canParse(entry.key.split(' ')[1]) && new URL(entry.key.split(' ')[1]).hostname === quorumHost(network))
    .map(({ key, body }) => ({ key, body })).sort((a, b) => a.key.localeCompare(b.key));
  if (keys.length === 0) throw new Error('Bundle has no quorum context');
  return sha256(JSON.stringify(keys));
}

// Replaying the wire responses runs the SDK's GroveDB and quorum-signature checks again.
// A replayed bundle is checked at its capture time: the SDK rejects responses older than about 31 minutes.
export function installTransport({ network, replay, clockMs } = {}) {
  if (replay) checkReplay(replay);
  const original = globalThis.fetch;
  const RealDate = globalThis.Date;
  if (clockMs !== undefined) {
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length === 0 ? [clockMs] : args)); }
      static now() { return clockMs; }
    };
  }
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
  return { entries, restore: () => { globalThis.fetch = original; globalThis.Date = RealDate; } };
}

export function resetDocumentEvidence(entries) {
  const base = entries.filter((entry) => !/\/(getDocuments|getContractDocumentRemovals) /u.test(entry.key));
  entries.splice(0, entries.length, ...base);
}
