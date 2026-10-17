#!/usr/bin/env node
// GitHub issue writes only; no Dash SDK, keys, or chain operations.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { incidentPlan } from './incident-plan.mjs';

const repo = process.env.GITHUB_REPOSITORY;
if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) throw new Error('Set GITHUB_REPOSITORY=owner/repo');
const path = process.argv[2] ?? 'monitoring-results.json';
const report = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { results: [{ key: 'monitor/execution', status: 'fail', detail: 'Monitoring failed before producing results; inspect the workflow log.' }] };
if (!report.results?.length) throw new Error('Empty monitoring report');
// A successful execution explicitly resolves a prior setup/execution incident.
if (existsSync(path)) report.results.push({ key: 'monitor/execution', status: 'pass', detail: 'Monitoring produced a report.' });
function api(method, route, body) {
  const args = ['api', '--method', method, `repos/${repo}/${route}`];
  if (body) args.push('--input', '-');
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', ...(body ? { input: JSON.stringify(body) } : {}) }) || 'null');
}
const marker = '<!-- yappr-read-only-monitor:v1 -->';
const issues = [];
for (let page = 1; ; page++) {
  const batch = api('GET', `issues?state=open&labels=incident&per_page=100&page=${page}`);
  issues.push(...batch.filter(issue => !issue.pull_request && issue.body?.includes(marker)));
  if (batch.length < 100) break;
}
const plan = incidentPlan(report.results, issues);
if (plan.some(item => item.action === 'open')) {
  const labels = execFileSync('gh', ['api', '--paginate', `repos/${repo}/labels?per_page=100`, '--jq', '.[].name'], { encoding: 'utf8' }).trim().split('\n');
  if (!labels.includes('incident')) api('POST', 'labels', { name: 'incident', color: 'b60205', description: 'Production monitoring incident' });
}
const runUrl = process.env.GITHUB_RUN_ID ? `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : 'Local read-only monitoring run';
for (const item of plan) {
  const body = `${marker}\n${item.result.status === 'pass' ? 'Recovered' : 'Failing'} at ${report.checkedAt ?? new Date().toISOString()}\n\nCheck: \`${item.result.key}\`\n\n${item.result.detail.slice(0, 12000)}\n\nRun: ${runUrl}\n\nResponse guide: docs/MONITORING.md\n`;
  if (item.action === 'open') {
    const issue = api('POST', 'issues', { title: item.title, labels: ['incident'], body });
    console.log(`Opened ${issue.html_url}`);
  } else for (const issue of item.issues) {
    api('PATCH', `issues/${issue.number}`, { body, ...(item.action === 'close' ? { state: 'closed', state_reason: 'completed' } : {}) });
    console.log(`${item.action === 'close' ? 'Closed recovered' : 'Updated'} ${issue.html_url}`);
  }
}
