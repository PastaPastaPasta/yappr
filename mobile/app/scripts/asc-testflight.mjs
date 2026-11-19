#!/usr/bin/env node
// After a TestFlight upload (mobile/RELEASE.md): waits for App Store Connect to
// process the build, attaches an existing export compliance declaration, sets What to Test, and adds the
// build to the internal beta group. Prints a Markdown summary on stdout.
//
// Environment: ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (the .p8), BUNDLE_ID,
// APP_VERSION, BUILD_NUMBER, WHAT_TO_TEST, BETA_GROUP (default "Yappr Internal"),
// CERT_SERIAL (hex, optional), PROCESSING_TIMEOUT_MINUTES (default 45),
// SIGNING_NAME_DENYLIST (comma-separated, optional).
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
};

const API = 'https://api.appstoreconnect.apple.com';
const key = createPrivateKey(readFileSync(env('ASC_KEY_PATH')));
const keyId = env('ASC_KEY_ID');
const issuer = env('ASC_ISSUER_ID');
const bundleId = env('BUNDLE_ID');
const version = env('APP_VERSION');
const buildNumber = env('BUILD_NUMBER');
const groupName = env('BETA_GROUP', 'Yappr Internal');
const timeoutMs = Number(env('PROCESSING_TIMEOUT_MINUTES', '45')) * 60_000;

const b64url = (data) => Buffer.from(data).toString('base64url');
function token() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: issuer, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' }));
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${b64url(signature)}`;
}

class ApiError extends Error {}

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    const detail = (() => {
      try {
        return JSON.parse(text).errors?.map((e) => `${e.title}: ${e.detail}`).join('; ');
      } catch {
        return '';
      }
    })();
    throw new ApiError(`${method} ${path.split('?')[0]} → ${response.status} ${detail || ''}`.trim());
  }
  return text ? JSON.parse(text) : {};
}

const lines = [];
const out = (line = '') => lines.push(line);
const field = (label, value) => out(`- ${label}: \`${value ?? 'n/a'}\``);
const fetched = [];
let failed = false;

async function main() {
  const apps = await api('GET', `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=name,bundleId,sku`);
  const app = apps.data?.find((a) => a.attributes.bundleId === bundleId);
  if (!app) throw new Error(`No App Store Connect app with bundle id ${bundleId}`);
  out('### App Store Connect');
  field('App', app.attributes.name);
  field('Bundle id', app.attributes.bundleId);
  field('SKU', app.attributes.sku);
  fetched.push(app.attributes.name, app.attributes.sku);

  await team();

  const build = await waitForBuild(app.id);
  field('Build id', build.id);
  field('Version', version);
  field('Build number', build.attributes.version);
  field('processingState', build.attributes.processingState);
  if (build.attributes.processingState !== 'VALID') {
    failed = true;
    out(`- **FAILED:** the build finished processing as ${build.attributes.processingState}`);
    return;
  }

  await exportCompliance(app.id, build);
  await whatToTest(build.id);
  await betaGroup(app.id, build.id);
}

// The API has no provider endpoint; the team shows through the bundle id record and the certificate.
async function team() {
  try {
    const ids = await api('GET', `/v1/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&fields[bundleIds]=identifier,name,seedId`);
    const record = ids.data?.find((b) => b.attributes.identifier === bundleId);
    field('Bundle id record', record ? `${record.attributes.name} (team prefix ${record.attributes.seedId})` : 'not found');
    if (record) fetched.push(record.attributes.name);
  } catch (error) {
    field('Bundle id record', `not readable with this key (${error.message})`);
  }
  const serial = process.env.CERT_SERIAL;
  if (!serial) return;
  try {
    const certs = await api('GET', `/v1/certificates?filter[serialNumber]=${encodeURIComponent(serial)}&fields[certificates]=name,displayName,certificateType`);
    const cert = certs.data?.[0];
    field('Certificate (as ASC reports it)', cert ? `${cert.attributes.name} — ${cert.attributes.displayName} (${cert.attributes.certificateType})` : 'not found');
    if (cert) fetched.push(cert.attributes.name, cert.attributes.displayName);
  } catch (error) {
    field('Certificate (as ASC reports it)', `not readable with this key (${error.message})`);
  }
}

async function waitForBuild(appId) {
  const query =
    `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(buildNumber)}` +
    `&filter[preReleaseVersion.version]=${encodeURIComponent(version)}&limit=1`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const builds = await api('GET', query);
    const build = builds.data?.[0];
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
// (COMPLIANCE.md C8). So an existing declaration with the standard-algorithm answers is reused
// and attached; none is ever created, and without one the build stays in Missing Compliance.
async function exportCompliance(appId, build) {
  out('### Export compliance');
  try {
    const current = await api('GET', `/v1/builds/${build.id}/appEncryptionDeclaration`);
    if (current.data) {
      field('Declaration', `${current.data.id} (${current.data.attributes?.appEncryptionDeclarationState ?? 'attached'})`);
      return;
    }
    const existing = await api('GET', `/v1/apps/${appId}/appEncryptionDeclarations?limit=50`);
    const declaration = existing.data?.find(
      (d) =>
        d.attributes.containsProprietaryCryptography === false &&
        d.attributes.containsThirdPartyCryptography === true &&
        d.attributes.appEncryptionDeclarationState === 'APPROVED',
    );
    if (declaration) {
      await api('PATCH', `/v1/builds/${build.id}/relationships/appEncryptionDeclaration`, {
        data: { type: 'appEncryptionDeclarations', id: declaration.id },
      });
      field('Declaration', `${declaration.id} (${declaration.attributes.appEncryptionDeclarationState}, attached)`);
      field('Answers', `standard third-party algorithms, no proprietary crypto, French store: ${declaration.attributes.availableOnFrenchStore}`);
      return;
    }
    out('- No approved declaration with the standard-algorithm answers exists, so the build stays in **Missing Compliance** (owner\'s call). In App Store Connect:');
  } catch (error) {
    out(`- The API could not read or attach a declaration (${error.message}); the build stays in **Missing Compliance**. In App Store Connect:`);
  }
  for (const step of COMPLIANCE_MANUAL) out(`  1. ${step}`);
}

async function whatToTest(buildId) {
  const text = process.env.WHAT_TO_TEST;
  if (!text) return;
  try {
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
  } catch (error) {
    field('What to Test', `not set (${error.message})`);
  }
}

async function betaGroup(appId, buildId) {
  out('### Internal testing');
  const groups = await api('GET', `/v1/apps/${appId}/betaGroups?limit=200`);
  let group = groups.data?.find((g) => g.attributes.name === groupName);
  if (group && !group.attributes.isInternalGroup) {
    throw new Error(`Beta group "${groupName}" exists but is external`);
  }
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
  if (group.attributes.hasAccessToAllBuilds) {
    field('Build in group', 'yes (the group gets every build)');
    return;
  }
  try {
    await api('POST', `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: 'builds', id: buildId }] });
    field('Build in group', 'yes');
  } catch (error) {
    failed = true;
    out(`- **FAILED:** adding the build to ${groupName}: ${error.message}`);
  }
}

function denylist() {
  const names = (process.env.SIGNING_NAME_DENYLIST ?? '')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  const text = fetched.filter(Boolean).join('\n').toLowerCase();
  const hit = names.some((n) => text.includes(n));
  out(`- Denylisted names in the fetched app/build/team metadata: ${hit ? '**FOUND**' : 'none'} (${names.length} names checked)`);
  if (hit) failed = true;
}

try {
  await main();
} catch (error) {
  failed = true;
  out(`- **FAILED:** ${error.message}`);
}
denylist();
console.log(lines.join('\n'));
process.exitCode = failed ? 1 : 0;
