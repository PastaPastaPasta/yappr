import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

it('deduplicates real issue API writes and closes only explicit recovery (offline gh fixture)', () => {
  const root = mkdtempSync(join(tmpdir(), 'yappr-incident-'));
  try {
    const statePath = join(root, 'state.json');
    const reportPath = join(root, 'report.json');
    writeFileSync(statePath, JSON.stringify({ issues: [], next: 1, labels: [] }));
    const gh = join(root, 'gh');
    writeFileSync(gh, `#!${process.execPath}\n
const fs = require('node:fs');
const path = process.env.MONITOR_FIXTURE_STATE;
const state = JSON.parse(fs.readFileSync(path, 'utf8'));
const args = process.argv.slice(2);
const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
const route = args.find(arg => arg.startsWith('repos/')).split('/').slice(3).join('/');
const body = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : {};
let result;
if (method === 'GET' && route.startsWith('issues?')) result = state.issues.filter(issue => issue.state === 'open');
else if (method === 'GET' && route.startsWith('labels?')) { console.log(state.labels.join('\\n')); process.exit(0); }
else if (method === 'POST' && route === 'labels') { state.labels.push(body.name); result = body; }
else if (method === 'POST' && route === 'issues') {
 result = { ...body, number: state.next++, state: 'open', html_url: 'https://github.com/fixture/repo/issues/' + (state.next - 1) }; state.issues.push(result);
} else if (method === 'PATCH' && route.startsWith('issues/')) {
 result = state.issues.find(issue => issue.number === Number(route.split('/')[1])); Object.assign(result, body);
} else throw new Error('Unexpected API operation: ' + method + ' ' + route);
fs.writeFileSync(path, JSON.stringify(state)); console.log(JSON.stringify(result));
`);
    chmodSync(gh, 0o700);
    const run = (status, key = 'site/production') => {
      writeFileSync(reportPath, JSON.stringify({ checkedAt: '2026-10-17T00:00:00Z', results: [{ key, status, detail: status }] }));
      execFileSync(process.execPath, [fileURLToPath(new URL('./incidents.mjs', import.meta.url)), reportPath], { env: { ...process.env, GITHUB_REPOSITORY: 'fixture/repo', PATH: `${root}:${process.env.PATH}`, MONITOR_FIXTURE_STATE: statePath }, encoding: 'utf8' });
      return JSON.parse(readFileSync(statePath, 'utf8'));
    };
    expect(run('fail').issues).toHaveLength(1);
    expect(run('fail').issues).toHaveLength(1);
    expect(run('skip').issues[0].state).toBe('open');
    expect(run('pass', 'site/mirror').issues[0].state).toBe('open');
    expect(run('pass').issues[0].state).toBe('closed');
    expect(JSON.parse(readFileSync(statePath, 'utf8')).labels).toEqual(['incident']);
  } finally { rmSync(root, { recursive: true }); }
}, 30000);
