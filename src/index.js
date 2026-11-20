'use strict';
/* Scope Guard Lite - GitHub Action entry point. Warn-only: this action never fails a job
   because of findings, and it swallows its own errors into warnings. No dependencies. */
const fs = require('fs');
const { analyze } = require('./checks');

const MARKER = '<!-- scope-guard-lite-report -->';
const GUMROAD = 'https://gillardlogan.gumroad.com/l/scope-guard';
const API = process.env.GITHUB_API_URL || 'https://api.github.com';

function input(name) {
  return (process.env['INPUT_' + name.replace(/ /g, '_').toUpperCase()] || '').trim();
}
const warn = (m) => console.log('::warning::' + String(m).replace(/\r?\n/g, ' '));
const info = (m) => console.log(m);

function listInput(value) {
  return value.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

async function gh(token, method, path, body, accept) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'scope-guard-lite',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(method + ' ' + path + ' -> ' + res.status + ' ' + text.slice(0, 200));
    err.status = res.status;
    throw err;
  }
  return text;
}

function esc(s) { return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }

function render(report, task, allowed) {
  const f = report.findings;
  const L = ['## Scope Guard Lite', ''];
  if (!f.length) {
    L.push('No findings in the free checks (' + report.files_scanned + ' file' + (report.files_scanned === 1 ? '' : 's') + ' scanned).', '');
  } else {
    const crit = f.filter((x) => x.severity === 'critical').length;
    L.push('**' + f.length + ' finding' + (f.length === 1 ? '' : 's') + '** in ' + report.files_scanned +
      ' file' + (report.files_scanned === 1 ? '' : 's') + ' scanned' + (crit ? ' (' + crit + ' critical)' : '') +
      '. This is a warning only; it does not block the merge.', '');
    L.push('| Severity | Rule | Location | Summary |', '| --- | --- | --- | --- |');
    f.slice(0, 50).forEach((x) => {
      const loc = x.path ? x.path + (x.line ? ':' + x.line : '') : '-';
      L.push('| ' + x.severity + ' | `' + x.rule_id + '` | `' + esc(loc) + '` | ' + esc(x.title) + ' |');
    });
    if (f.length > 50) L.push('', '_Showing the first 50 of ' + f.length + ' findings._');
    L.push('');
    f.slice(0, 20).forEach((x) => {
      if (x.evidence) L.push('<details><summary>' + esc(x.title) + '</summary>', '', '```', x.evidence, '```', '</details>', '');
    });
  }
  if (!allowed.length) L.push('_`allowed-paths` is not set, so the outside-allowed-paths check was skipped._', '');
  else L.push('_Checked against `allowed-paths`: ' + allowed.map((p) => '`' + esc(p) + '`').join(', ') + '._', '');
  if (task) {
    const t = task.replace(/\s+/g, ' ').slice(0, 160);
    L.push('_Task read: "' + t + (task.length > 160 ? '\u2026' : '') + '". Lite does not compare it with the diff._', '');
  }
  L.push('---', 'Want it to block merges and run the full rule set? [Scope Guard](' + GUMROAD + ') on Gumroad.');
  return L.join('\n');
}

async function upsertComment(token, repo, pr, body) {
  const base = '/repos/' + repo + '/issues/' + pr + '/comments';
  let existing = null;
  for (let page = 1; page <= 10 && !existing; page++) {
    const list = JSON.parse(await gh(token, 'GET', base + '?per_page=100&page=' + page));
    existing = list.find((c) => c.body && c.body.indexOf(MARKER) !== -1) || null;
    if (list.length < 100) break;
  }
  if (existing) {
    await gh(token, 'PATCH', '/repos/' + repo + '/issues/comments/' + existing.id, { body });
    return 'updated';
  }
  await gh(token, 'POST', base, { body });
  return 'created';
}

async function main() {
  const token = input('github-token');
  const repo = process.env.GITHUB_REPOSITORY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event = eventPath && fs.existsSync(eventPath) ? JSON.parse(fs.readFileSync(eventPath, 'utf8')) : {};
  const pr = event.pull_request;
  if (!pr) { info('Scope Guard Lite runs on pull_request events. Nothing to do.'); return; }
  if (!token) { warn('No github-token available.'); return; }

  const allowed = listInput(input('allowed-paths'));
  const task = input('task') || [pr.title, pr.body].filter(Boolean).join('\n\n');

  let diff;
  try {
    diff = await gh(token, 'GET', '/repos/' + repo + '/pulls/' + pr.number, null, 'application/vnd.github.v3.diff');
  } catch (e) {
    warn('Could not fetch the PR diff: ' + e.message);
    return;
  }

  const report = analyze(diff, { allowedPaths: allowed });
  const body = MARKER + '\n' + render(report, task, allowed);
  info('Scope Guard Lite: ' + report.findings.length + ' finding(s) in ' + report.files_scanned + ' file(s).');
  report.findings.forEach((x) => warn(x.rule_id + ' ' + (x.path || '') + (x.line ? ':' + x.line : '') + ' ' + x.title));

  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, body.replace(MARKER, '') + '\n'); } catch (e) { /* ignore */ }
  }
  if (input('comment') === 'false') return;
  try {
    const how = await upsertComment(token, repo, pr.number, body);
    info('PR comment ' + how + '.');
  } catch (e) {
    warn('Could not post the PR comment (' + e.message + '). Fork PRs get a read-only token. Findings are in the job summary.');
  }
}

main().catch((e) => { warn('Scope Guard Lite hit an error and skipped: ' + (e && e.message)); });
