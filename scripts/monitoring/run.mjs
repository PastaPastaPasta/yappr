#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NETWORKS, thresholds } from './config.mjs';
import { siteChecks } from './sites.mjs';

const args = process.argv.slice(2);
const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const output = option('--output') ?? 'monitoring-results.json';
const results = [];
const manifestPath = option('--manifest');
function add(result) { results.push(result); console.log(`${result.status.toUpperCase()} ${result.key}: ${result.detail}`); }
async function record(key, fn) {
  const start = Date.now();
  try { add({ key, status: 'pass', detail: await fn(), ms: Date.now() - start }); }
  catch (error) { add({ key, status: 'fail', detail: String(error.message ?? error), ms: Date.now() - start }); }
}
async function worker(network) {
  const script = fileURLToPath(new URL('./chain.mjs', import.meta.url));
  await new Promise(done => {
    execFile(process.execPath, [script, network, ...(manifestPath && existsSync(manifestPath) ? [resolve(manifestPath)] : [])], { cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('MONITOR_') || ['PATH', 'HOME', 'NODE_EXTRA_CA_CERTS'].includes(key))), timeout: 240000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      let count = 0;
      let onlySkips = true;
      for (const line of stdout.split('\n')) {
        let result;
        try { result = JSON.parse(line); } catch { continue; }
        if (!result.key?.startsWith(`chain/${network}`) || !['pass', 'fail', 'skip'].includes(result.status)) continue;
        add(result); count++;
        if (result.status !== 'skip') onlySkips = false;
      }
      if (error || !count) add({ key: `chain/${network}/worker`, status: 'fail', detail: `${error?.message ?? 'Worker returned no checks'}; ${stderr.slice(-3000)}` });
      else add({ key: `chain/${network}/worker`, status: onlySkips ? 'skip' : 'pass', detail: 'Read-only probe completed' });
      done();
    });
  });
}
try {
  thresholds();
  if (manifestPath) await record('monitor/expectations', async () => {
    if (!existsSync(manifestPath)) throw new Error('Deployment artifact unavailable; site expectations unknown; chain probes fall back to checked-in env files for diagnosis');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!manifest.networks) throw new Error('Deployment artifact missing network expectations');
    return 'Using deployed environment, version pins and schema hashes';
  });
  const network = option('--network');
  if (network && !Object.hasOwn(NETWORKS, network)) throw new Error(`Unknown network ${network}`);
  if (!args.includes('--chain-only')) {
    const path = option('--manifest') ?? 'monitoring-expectations.json';
    const manifest = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    await siteChecks(manifest, record);
  }
  if (!args.includes('--sites-only')) for (const name of network ? [network] : Object.keys(NETWORKS)) await worker(name);
  add({ key: 'monitor/runner', status: 'pass', detail: 'Monitoring orchestration completed' });
} catch (error) { add({ key: 'monitor/runner', status: 'fail', detail: String(error.message ?? error) }); }
const report = { version: 1, checkedAt: new Date().toISOString(), results };
writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Production monitoring\n\n${results.map(result => `- **${result.status.toUpperCase()}** ${result.key}: ${result.detail.replaceAll('\n', ' ')}`).join('\n')}\n`);
if (results.some(result => result.status === 'fail')) process.exitCode = 1;
