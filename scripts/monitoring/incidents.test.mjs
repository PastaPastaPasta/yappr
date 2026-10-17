import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

it('runs without npm packages, reports missing results, and deduplicates recovery (offline gh fixture)', () => {
  const root = mkdtempSync(join(tmpdir(), 'yappr-incident-'));
  try {
    // Resolve imports from an isolated directory with no node_modules ancestors.
    for (const name of ['incidents.mjs', 'incident-plan.mjs']) copyFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), join(root, name));
    const reporter = join(root, 'incidents.mjs');
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
      execFileSync(process.execPath, [reporter, reportPath], { env: { ...process.env, GITHUB_REPOSITORY: 'fixture/repo', PATH: `${root}:${process.env.PATH}`, MONITOR_FIXTURE_STATE: statePath }, encoding: 'utf8' });
      return JSON.parse(readFileSync(statePath, 'utf8'));
    };
    expect(run('fail').issues).toHaveLength(1);
    expect(run('fail').issues).toHaveLength(1);
    expect(run('skip').issues[0].state).toBe('open');
    expect(run('pass', 'site/mirror').issues[0].state).toBe('open');
    expect(run('pass').issues[0].state).toBe('closed');
    expect(JSON.parse(readFileSync(statePath, 'utf8')).labels).toEqual(['incident']);
    unlinkSync(reportPath);
    execFileSync(process.execPath, [reporter, reportPath], { cwd: root, env: { GITHUB_REPOSITORY: 'fixture/repo', PATH: `${root}:${process.env.PATH}`, MONITOR_FIXTURE_STATE: statePath }, encoding: 'utf8' });
    expect(JSON.parse(readFileSync(statePath, 'utf8')).issues.at(-1)).toMatchObject({ title: '[monitoring] monitor/execution', state: 'open' });
  } finally { rmSync(root, { recursive: true }); }
}, 30000);
