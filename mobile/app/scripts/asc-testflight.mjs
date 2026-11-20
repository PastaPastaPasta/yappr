#!/usr/bin/env node
// App Store Connect side of a TestFlight upload (mobile/RELEASE.md). Prints a Markdown summary.
//
//   asc-testflight.mjs preflight   read-only, before the upload: the app record, the bundle id
//                                  record and the certificate, checked against the denylist
//   asc-testflight.mjs post        after the upload: waits for processing, attaches an existing
//                                  export compliance declaration, sets What to Test, and adds
//                                  the build to the internal beta group
//
// Environment: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (the .p8), BUNDLE_ID; for post also
// APP_VERSION, BUILD_NUMBER, WHAT_TO_TEST, BETA_GROUP (default "Yappr Internal"),
// PROCESSING_TIMEOUT_MINUTES (default 45). CERT_SERIAL (hex) and SIGNING_NAME_DENYLIST
// (comma-separated) are optional.
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
};

const mode = process.argv[2];
if (mode !== 'preflight' && mode !== 'post') {
  console.error('usage: asc-testflight.mjs preflight|post');
  process.exit(2);
}

const API = 'https://api.appstoreconnect.apple.com';
const key = createPrivateKey(readFileSync(env('ASC_KEY_PATH')));
const keyId = env('ASC_KEY_ID');
const issuer = env('ASC_ISSUER_ID');
const bundleId = env('BUNDLE_ID');

const b64url = (data) => Buffer.from(data).toString('base64url');
function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }));
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64url(signature)}`;
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = '';
    try {
      detail = JSON.parse(text).errors?.map((e) => `${e.title}: ${e.detail}`).join('; ') ?? '';
    } catch {
      // A non-JSON error body adds nothing.
    }
    throw new ApiError(`${method} ${path.split('?')[0]} → ${response.status} ${detail}`.trim(), response.status);
  }
  return text ? JSON.parse(text) : {};
}

const DENYLIST = (process.env.SIGNING_NAME_DENYLIST ?? '')
  .split(',')
  .map((n) => n.trim().toLowerCase())
  .filter(Boolean);
const isDenied = (value) => DENYLIST.some((n) => String(value ?? '').toLowerCase().includes(n));

const lines = [];
let failed = false;
const out = (line = '') => lines.push(line);
const fail = (message) => {
  failed = true;
  out(`- **FAILED:** ${message}`);
};
// Fetched metadata is checked before it is printed; a hit prints the label only.
const field = (label, value) => {
  if (isDenied(value)) fail(`${label} contains a denylisted name (value withheld)`);
  else out(`- ${label}: \`${value ?? 'n/a'}\``);
};

async function findApp() {
  const apps = await api('GET', `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=name,bundleId,sku`);
  const app = apps.data?.find((a) => a.attributes.bundleId === bundleId);
  if (!app) throw new Error(`No App Store Connect app with bundle id ${bundleId}`);
  return app;
}

// The API has no provider endpoint; the team shows through the bundle id record and the certificate.
async function preflight() {
  const app = await findApp();
  out('### App Store Connect (before upload)');
  field('App', app.attributes.name);
  field('Bundle id', app.attributes.bundleId);
  field('SKU', app.attributes.sku);
  try {
    const ids = await api('GET', `/v1/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&fields[bundleIds]=identifier,name,seedId`);
    const record = ids.data?.find((b) => b.attributes.identifier === bundleId);
    if (record) field('Bundle id record', `${record.attributes.name} (team prefix ${record.attributes.seedId})`);
    else field('Bundle id record', 'not found');
  } catch (error) {
    if (error.status !== 403) throw error;
    field('Bundle id record', 'not readable with this key');
  }
  const serial = process.env.CERT_SERIAL;
  if (!serial) return;
  try {
    const certs = await api('GET', `/v1/certificates?filter[serialNumber]=${encodeURIComponent(serial)}&fields[certificates]=name,displayName,certificateType`);
    const cert = certs.data?.[0];
    if (cert) field('Certificate (as App Store Connect reports it)', `${cert.attributes.name} — ${cert.attributes.displayName} (${cert.attributes.certificateType})`);
    else field('Certificate (as App Store Connect reports it)', 'not found');
  } catch (error) {
    if (error.status !== 403) throw error;
    field('Certificate (as App Store Connect reports it)', 'not readable with this key');
  }
}

async function waitForBuild(appId, version, buildNumber, timeoutMs) {
  const query =
    `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}` +
    `&filter[preReleaseVersion.version]=${encodeURIComponent(version)}` +
    '&filter[preReleaseVersion.platform]=IOS&limit=1';
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let build;
    try {
      build = (await api('GET', query)).data?.[0];
    } catch (error) {
      // Rate limits, server errors and timeouts are retried until the deadline; others fail.
      const transient = [429, 500, 502, 503, 504].includes(error.status) || ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name);
      if (!transient || Date.now() > deadline) throw error;
      console.error(`build lookup failed (${error.status ?? error.name}); retrying`);
      await sleep(30_000);
      continue;
    }
    const state = build?.attributes.processingState;
    console.error(`build ${version} (${buildNumber}): ${state ?? 'not visible yet'}`);
    if (build && state !== 'PROCESSING') return build;
    if (Date.now() > deadline) throw new Error(`Build ${version} (${buildNumber}) still ${state ?? 'missing'} after the timeout`);
    await sleep(30_000);
  }
}

const COMPLIANCE_MANUAL = [
  'App Store Connect → Apps → the app → TestFlight → this build → Manage (Missing Compliance).',
  'Does your app use encryption? Yes (it ships its own end-to-end encryption; never answer No).',
  'Proprietary or non-standard algorithms? No: standard algorithms (secp256k1, XChaCha20-Poly1305, AES-GCM) from third-party libraries, not provided by Apple.',
  'Available on the French App Store? The owner decides (COMPLIANCE.md C8: French declaration filed, or France excluded).',
];

// The build's Info.plist says it uses non-exempt encryption, which is never changed here. The
// truthful answers are known except one: availability on the French store is the owner's call
// (COMPLIANCE.md C8). So a declaration is only reused, never created: the approved ones with the
// standard-algorithm answers, and only when they all give the same French-store answer.
async function exportCompliance(appId, buildId) {
  out('### Export compliance');
  let current = null;
  try {
    current = (await api('GET', `/v1/builds/${buildId}/appEncryptionDeclaration`)).data ?? null;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (current) {
    const state = current.attributes?.appEncryptionDeclarationState ?? 'unknown';
    field('Declaration', `${current.id} (${state}, already attached)`);
    if (state === 'APPROVED') return;
    // An attached declaration that isn't approved yet leaves compliance to App Store Connect and the owner.
    out('- The attached declaration is not approved yet, so the build may stay in **Missing Compliance**. In App Store Connect:');
    for (const step of COMPLIANCE_MANUAL) out(`  1. ${step}`);
    return;
  }
  const all = [];
  try {
    for (let path = `/v1/apps/${appId}/appEncryptionDeclarations?limit=200`; path; ) {
      const page = await api('GET', path);
      all.push(...(page.data ?? []));
      path = page.links?.next ? page.links.next.replace(API, '') : null;
    }
  } catch (error) {
    if (error.status !== 403 && error.status !== 404) throw error;
    out(`- The API can't list declarations with this key (${error.status}). The build stays in **Missing Compliance**. In App Store Connect:`);
    for (const step of COMPLIANCE_MANUAL) out(`  1. ${step}`);
    return;
  }
  const candidates = all.filter(
    (d) =>
      d.attributes.exempt === false &&
      d.attributes.containsProprietaryCryptography === false &&
      d.attributes.containsThirdPartyCryptography === true &&
      d.attributes.appEncryptionDeclarationState === 'APPROVED',
  );
  const frenchAnswers = new Set(candidates.map((d) => d.attributes.availableOnFrenchStore));
  const agreed = frenchAnswers.size === 1 && typeof [...frenchAnswers][0] === 'boolean';
  if (candidates.length > 0 && agreed) {
    const declaration = candidates[0];
    await api('PATCH', `/v1/builds/${buildId}/relationships/appEncryptionDeclaration`, {
      data: { type: 'appEncryptionDeclarations', id: declaration.id },
    });
    field('Declaration', `${declaration.id} (APPROVED, attached)`);
    field('Answers', `not exempt, standard third-party algorithms, no proprietary crypto, French store: ${declaration.attributes.availableOnFrenchStore}`);
    return;
  }
  out(
    candidates.length > 0
      ? '- Approved declarations disagree on, or omit, the French-store answer, so none is picked. The build stays in **Missing Compliance** (owner\'s call). In App Store Connect:'
      : '- No approved non-exempt declaration with the standard-algorithm answers exists, so the build stays in **Missing Compliance** (owner\'s call). In App Store Connect:',
  );
  for (const step of COMPLIANCE_MANUAL) out(`  1. ${step}`);
}

async function whatToTest(buildId, text) {
  const existing = await api('GET', `/v1/builds/${buildId}/betaBuildLocalizations`);
  const en = existing.data?.find((l) => l.attributes.locale === 'en-US');
  if (en) {
    await api('PATCH', `/v1/betaBuildLocalizations/${en.id}`, {
      data: { type: 'betaBuildLocalizations', id: en.id, attributes: { whatsNew: text } },
    });
  } else {
    await api('POST', '/v1/betaBuildLocalizations', {
      data: {
        type: 'betaBuildLocalizations',
        attributes: { locale: 'en-US', whatsNew: text },
        relationships: { build: { data: { type: 'builds', id: buildId } } },
      },
    });
  }
  field('What to Test', 'set (en-US)');
}

async function betaGroup(appId, buildId, groupName) {
  out('### Internal testing');
  const groups = await api('GET', `/v1/apps/${appId}/betaGroups?limit=200`);
  let group = groups.data?.find((g) => g.attributes.name === groupName);
  if (group && !group.attributes.isInternalGroup) throw new Error(`Beta group "${groupName}" exists but is external`);
  if (!group) {
    group = (
      await api('POST', '/v1/betaGroups', {
        data: {
          type: 'betaGroups',
          attributes: { name: groupName, isInternalGroup: true, hasAccessToAllBuilds: false },
          relationships: { app: { data: { type: 'apps', id: appId } } },
        },
      })
    ).data;
    field('Group', `${groupName} (created, ${group.id})`);
  } else {
    field('Group', `${groupName} (${group.id})`);
  }
  // A build still waiting on export compliance waits on the owner; it is reported, not added.
  const detail = await api('GET', `/v1/builds/${buildId}/buildBetaDetail`);
  const state = detail.data?.attributes?.internalBuildState;
  if (['MISSING_EXPORT_COMPLIANCE', 'IN_EXPORT_COMPLIANCE_REVIEW'].includes(state)) {
    out(`- Build in group: not yet, pending export compliance (${state}); add it to the group once compliance is done (RELEASE.md)`);
    return;
  }
  if (group.attributes.hasAccessToAllBuilds) {
    field('Build in group', 'yes (the group gets every build)');
    return;
  }
  await api('POST', `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: 'builds', id: buildId }] });
  field('Build in group', 'yes');
}

async function post() {
  const version = env('APP_VERSION');
  const buildNumber = env('BUILD_NUMBER');
  const groupName = env('BETA_GROUP', 'Yappr Internal');
  const timeoutMinutes = Number(env('PROCESSING_TIMEOUT_MINUTES', '45'));
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) throw new Error('PROCESSING_TIMEOUT_MINUTES must be a positive number');

  const app = await findApp();
  out('### App Store Connect (after upload)');
  field('App', app.attributes.name);
  const build = await waitForBuild(app.id, version, buildNumber, timeoutMinutes * 60_000);
  field('Build id', build.id);
  field('Version', version);
  field('Build number', build.attributes.version);
  field('processingState', build.attributes.processingState);
  if (build.attributes.processingState !== 'VALID') {
    fail(`the build finished processing as ${build.attributes.processingState}`);
    return;
  }
  await exportCompliance(app.id, build.id);
  if (process.env.WHAT_TO_TEST) await whatToTest(build.id, process.env.WHAT_TO_TEST);
  await betaGroup(app.id, build.id, groupName);
}

try {
  await (mode === 'preflight' ? preflight() : post());
} catch (error) {
  fail(isDenied(error.message) ? 'an App Store Connect error mentioned a denylisted name (withheld)' : error.message);
}
out(`- Denylist: ${DENYLIST.length} names checked against every value above`);
console.log(lines.join('\n'));
process.exitCode = failed ? 1 : 0;
