#!/usr/bin/env node
// App Store Connect side of a TestFlight upload (mobile/RELEASE.md). Prints a Markdown summary.
//
//   asc-testflight.mjs preflight   read-only, before the upload: the app record, the bundle id
//                                  record and the certificate, checked against the denylist
//   asc-testflight.mjs post        after the upload: waits for processing, attaches an existing
//                                  export compliance declaration, sets What to Test, and adds
//                                  the build to the internal beta group
//   asc-testflight.mjs distribute  for an uploaded build: reports its state, adds it to the internal
//                                  group, makes sure the group has testers and resends their invites
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
if (!['preflight', 'post', 'distribute'].includes(mode)) {
  console.error('usage: asc-testflight.mjs preflight|post|distribute');
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

// The build only ever answers that it uses non-exempt encryption (never exempt). The
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
  const matching = all.filter(
    (d) =>
      d.attributes.containsProprietaryCryptography === false &&
      d.attributes.containsThirdPartyCryptography === true &&
      d.attributes.appEncryptionDeclarationState === 'APPROVED',
  );
  const frenchAnswers = new Set(matching.map((d) => d.attributes.availableOnFrenchStore));
  const agreed = frenchAnswers.size === 1 && typeof [...frenchAnswers][0] === 'boolean';
  const candidates = matching.filter((d) => d.attributes.exempt === false);
  if (candidates.length > 0 && agreed) {
    const declaration = candidates[0];
    await api('PATCH', `/v1/builds/${buildId}`, {
      data: {
        type: 'builds',
        id: buildId,
        attributes: { usesNonExemptEncryption: true },
        relationships: {
          appEncryptionDeclaration: { data: { type: 'appEncryptionDeclarations', id: declaration.id } },
        },
      },
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

const maskEmail = (email) => {
  const [local = '', domain = ''] = String(email ?? '').split('@');
  return `${local.slice(0, 2)}***@${domain}`;
};
const redactEmails = (text) => String(text).replace(/[^\s@"'`]+@[^\s@"'`]+/g, maskEmail);

async function listAll(path) {
  const all = [];
  for (let next = path; next; ) {
    const page = await api('GET', next);
    all.push(...(page.data ?? []));
    next = page.links?.next ? page.links.next.replace(API, '') : null;
  }
  return all;
}

const BLOCKED_INTERNAL_STATES = ['PROCESSING', 'PROCESSING_EXCEPTION', 'MISSING_EXPORT_COMPLIANCE', 'IN_EXPORT_COMPLIANCE_REVIEW', 'EXPIRED'];

const INTERNAL_TESTER_ROLES = ['ACCOUNT_HOLDER', 'ADMIN', 'APP_MANAGER', 'DEVELOPER', 'MARKETING'];
const GRANT_APP_ACCESS =
  'An Account Holder or Admin opens App Store Connect → Users and Access → People → this user → Apps, ' +
  'turns on Access to All Apps or adds the app with Edit, saves, and reruns this workflow';

// Internal testers must be App Store Connect users on the team who can see the app; anyone else is reported, not invited.
async function inviteTeamUser(app, group, email) {
  const label = `Tester ${maskEmail(email)}`;
  const users = await listAll(`/v1/users?filter[username]=${encodeURIComponent(email)}&fields[users]=username,firstName,lastName,roles,allAppsVisible&limit=200`);
  const user = users.find((u) => String(u.attributes.username).toLowerCase() === email);
  if (!user) {
    fail(`${label}: not a user on this App Store Connect team, so Apple can't add it as an internal tester (users lookup returned ${users.length} matches)`);
    return;
  }
  const roles = user.attributes.roles ?? [];
  field(`${label} team roles`, roles.join(', ') || 'none');
  if (!roles.some((r) => INTERNAL_TESTER_ROLES.includes(r))) {
    fail(`${label}: no role that internal testing accepts (${INTERNAL_TESTER_ROLES.join(', ')})`);
    return;
  }
  if (user.attributes.allAppsVisible) {
    field(`${label} app access`, 'all apps');
  } else {
    let visible;
    try {
      visible = await listAll(`/v1/users/${user.id}/visibleApps?fields[apps]=bundleId&limit=200`);
    } catch (error) {
      if (error.status !== 403) throw error;
      fail(`${label} has access to specific apps only, and this key can't read which. ${GRANT_APP_ACCESS}`);
      return;
    }
    const sees = visible.some((a) => a.id === app.id);
    field(`${label} app access`, `${visible.length} specific apps, ${sees ? 'including' : 'not including'} ${app.attributes.name}`);
    if (!sees) {
      fail(`${label} can't see ${app.attributes.name}, so Apple refuses it as an internal tester (409 "Tester(s) cannot be assigned"). ${GRANT_APP_ACCESS}`);
      return;
    }
  }
  const inGroup = async () =>
    (await listAll(`/v1/betaGroups/${group.id}/betaTesters?limit=200`)).find((t) => String(t.attributes.email).toLowerCase() === email);
  let tester = await inGroup();
  if (tester) {
    field(label, 'already in the group');
  } else {
    // Tester records are per app: link this app's record if one exists, otherwise create it in the group.
    const own = (await listAll(`/v1/betaTesters?filter[email]=${encodeURIComponent(email)}&filter[apps]=${app.id}&limit=200`))
      .find((t) => String(t.attributes.email).toLowerCase() === email);
    try {
      if (own) {
        await api('POST', `/v1/betaGroups/${group.id}/relationships/betaTesters`, { data: [{ type: 'betaTesters', id: own.id }] });
      } else {
        const u = user.attributes;
        await api('POST', '/v1/betaTesters', {
          data: {
            type: 'betaTesters',
            attributes: { email: u.username, firstName: u.firstName, lastName: u.lastName },
            relationships: { betaGroups: { data: [{ type: 'betaGroups', id: group.id }] } },
          },
        });
      }
    } catch (error) {
      if (error.status !== 409) throw error;
      tester = await inGroup();
      if (!tester) {
        fail(`${label}: ${redactEmails(error.message)} (${own ? `linking this app's tester record ${own.id}` : 'creating a tester record'}; the user can see the app, so check in App Store Connect → Users and Access that the team invitation is accepted, then TestFlight → Yappr Internal → Testers)`);
        return;
      }
    }
    tester = tester ?? (await inGroup());
    if (!tester) throw new Error(`${label} was added but is not listed in the group`);
    field(label, own ? "added to the group (this app's existing tester record)" : 'added to the group');
  }
  await api('POST', '/v1/betaTesterInvitations', {
    data: {
      type: 'betaTesterInvitations',
      relationships: {
        app: { data: { type: 'apps', id: app.id } },
        betaTester: { data: { type: 'betaTesters', id: tester.id } },
      },
    },
  });
  const t = (await inGroup())?.attributes ?? tester.attributes;
  field(`${label} invite`, `sent; inviteType ${t.inviteType ?? 'n/a'}, state ${t.state ?? 'n/a'}`);
}

async function distribute() {
  const buildNumber = env('BUILD_NUMBER');
  const groupName = env('BETA_GROUP', 'Yappr Internal');
  const app = await findApp();
  out('### Build');
  field('App', `${app.attributes.name} (${app.id})`);
  const builds = await listAll(
    `/v1/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(buildNumber)}` +
      '&filter[preReleaseVersion.platform]=IOS&limit=200',
  );
  if (builds.length !== 1) throw new Error(`Expected one iOS build numbered ${buildNumber}, found ${builds.length}`);
  const build = builds[0];
  const version = (await api('GET', `/v1/builds/${build.id}/preReleaseVersion`)).data?.attributes?.version;
  field('Build id', build.id);
  field('Version', `${version} (${build.attributes.version})`);
  field('processingState', build.attributes.processingState);
  field('usesNonExemptEncryption', build.attributes.usesNonExemptEncryption);
  field('expired', build.attributes.expired);
  const detail = (await api('GET', `/v1/builds/${build.id}/buildBetaDetail`)).data?.attributes ?? {};
  field('internalBuildState', detail.internalBuildState);
  field('externalBuildState', detail.externalBuildState);

  out('### Beta groups');
  const groups = await listAll(`/v1/apps/${app.id}/betaGroups?limit=200`);
  // Public enrollment links stay out of public run logs; App Store Connect shows them.
  for (const g of groups) {
    const a = g.attributes;
    field(`Group ${a.name} (${g.id})`, `${a.isInternalGroup ? 'internal' : 'external'}, public link ${a.publicLinkEnabled ? 'enabled (URL withheld)' : 'off'}`);
  }
  const group = groups.find((g) => g.attributes.name === groupName && g.attributes.isInternalGroup);
  if (!group) throw new Error(`No internal beta group named "${groupName}"`);

  if (build.attributes.processingState !== 'VALID' || build.attributes.expired || BLOCKED_INTERNAL_STATES.includes(detail.internalBuildState)) {
    fail(`build ${buildNumber} is not installable (${build.attributes.processingState}, ${detail.internalBuildState}); answer export compliance in App Store Connect if it is MISSING_EXPORT_COMPLIANCE, then rerun`);
    for (const step of COMPLIANCE_MANUAL) out(`  1. ${step}`);
    return;
  }

  const inGroup = group.attributes.hasAccessToAllBuilds ||
    (await listAll(`/v1/betaGroups/${group.id}/builds?limit=200`)).some((b) => b.id === build.id);
  if (!inGroup) await api('POST', `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: 'builds', id: build.id }] });
  field('Build in group', inGroup ? 'yes (already)' : 'yes (added now)');

  out('### Testers');
  const email = process.env.TESTER_EMAIL?.trim().toLowerCase();
  if (email) {
    await inviteTeamUser(app, group, email);
    return;
  }
  let testers = await listAll(`/v1/betaGroups/${group.id}/betaTesters?limit=200`);
  if (testers.length === 0) {
    // An empty internal group gets the team's account holder, who is always an App Store Connect user.
    for (const user of await listAll('/v1/users?filter[roles]=ACCOUNT_HOLDER&limit=200')) {
      const u = user.attributes;
      await api('POST', '/v1/betaTesters', {
        data: {
          type: 'betaTesters',
          attributes: { email: u.username, firstName: u.firstName, lastName: u.lastName },
          relationships: { betaGroups: { data: [{ type: 'betaGroups', id: group.id }] } },
        },
      });
      field('Added account holder', maskEmail(u.username));
    }
    testers = await listAll(`/v1/betaGroups/${group.id}/betaTesters?limit=200`);
  }
  field('Testers in group', testers.length);
  if (testers.length === 0) fail(`${groupName} has no testers`);
  for (const tester of testers) {
    const t = tester.attributes;
    const pasta = /pasta/i.test(`${t.email} ${t.firstName} ${t.lastName}`) ? ', matches pasta' : '';
    const label = `Tester ${maskEmail(t.email)}`;
    try {
      await api('POST', '/v1/betaTesterInvitations', {
        data: {
          type: 'betaTesterInvitations',
          relationships: {
            app: { data: { type: 'apps', id: app.id } },
            betaTester: { data: { type: 'betaTesters', id: tester.id } },
          },
        },
      });
      field(label, `inviteType ${t.inviteType ?? 'n/a'}, state ${t.state ?? 'n/a'}${pasta}, invite sent`);
    } catch (error) {
      fail(`${label}: inviteType ${t.inviteType ?? 'n/a'}, state ${t.state ?? 'n/a'}${pasta}, invite failed (${redactEmails(error.message)})`);
    }
  }
}

try {
  await ({ preflight, post, distribute })[mode]();
} catch (error) {
  fail(isDenied(error.message) ? 'an App Store Connect error mentioned a denylisted name (withheld)' : redactEmails(error.message));
}
out(`- Denylist: ${DENYLIST.length} names checked against every value above`);
console.log(lines.join('\n'));
process.exitCode = failed ? 1 : 0;
