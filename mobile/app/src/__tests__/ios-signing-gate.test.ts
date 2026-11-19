import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const GATE = path.resolve(__dirname, '../../scripts/ios-signing-gate.sh');
const ORG = 'The Dash Foundation, Inc.';
const TEAM = 'ABCDE12345';

describe('ios-signing-gate.sh cert (TestFlight signing gate)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signing-gate-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function cert(subject: string): string {
    const pem = path.join(dir, `${Buffer.from(subject).toString('hex').slice(0, 40)}.pem`);
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '2',
      '-keyout', path.join(dir, 'key.pem'), '-out', pem, '-subj', subject,
    ], { stdio: 'ignore' });
    return pem;
  }

  function gate(pem: string, env: Record<string, string> = {}) {
    return spawnSync('bash', [GATE, 'cert', pem], {
      encoding: 'utf8',
      env: { ...process.env, APPLE_TEAM_ID: TEAM, APPLE_EXPECTED_ORG_NAME: ORG, SIGNING_NAME_DENYLIST: '', ...env },
    });
  }

  // -subj takes "/"-separated attributes, so the comma in the org name is a plain character here.
  const good = () => cert(`/UID=X/CN=Apple Distribution: ${ORG} (${TEAM})/OU=${TEAM}/O=${ORG}/C=US`);

  it('passes the expected organization, comma included, and records the evidence', () => {
    const result = gate(good());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`- O: \`${ORG}\``);
    expect(result.stdout).toContain(`- OU: \`${TEAM}\``);
    expect(result.stdout).toContain('Not after');
  });

  it('fails another organization, team or a personal certificate', () => {
    expect(gate(cert(`/CN=Apple Distribution: The Dash Foundation (${TEAM})/OU=${TEAM}/O=The Dash Foundation/C=US`)).status).toBe(1);
    expect(gate(cert(`/CN=Apple Distribution: ${ORG} (ZZZZZ99999)/OU=ZZZZZ99999/O=${ORG}/C=US`)).status).toBe(1);
    expect(gate(cert(`/CN=Apple Distribution: Jane Example (${TEAM})/OU=${TEAM}/O=Jane Example/C=US`)).status).toBe(1);
  });

  it('fails a denylisted name anywhere in the subject, case-insensitively, and ignores empty entries', () => {
    const pem = good();
    expect(gate(pem, { SIGNING_NAME_DENYLIST: ' , ' }).status).toBe(0);
    const denied = gate(pem, { SIGNING_NAME_DENYLIST: 'nobody, dash FOUNDATION' });
    expect(denied.status).toBe(1);
    expect(denied.stdout).toContain('contains a denylisted name (value withheld)');
    expect(denied.stdout.toLowerCase()).not.toContain('dash foundation');
    expect(denied.stderr.toLowerCase()).not.toContain('dash foundation');
  });

  it('requires the team and organization to be configured', () => {
    expect(gate(good(), { APPLE_TEAM_ID: '' }).status).not.toBe(0);
    expect(gate(good(), { APPLE_EXPECTED_ORG_NAME: '' }).status).not.toBe(0);
  });
});
