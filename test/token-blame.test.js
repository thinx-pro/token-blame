import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFile, loadRequests, promptSize } from '../src/parse.js';
import { analyze, classifyRebuild, findings, median } from '../src/analyze.js';
import { cost, resolveModel } from '../src/price.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const bin = path.join(root, 'bin', 'token-blame.js');
const prices = JSON.parse(fs.readFileSync(path.join(root, 'prices.json'), 'utf8'));

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'token-blame-')); }
function write(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
let seq = 0;
function asst({ session = 's1', model = 'claude-opus-5-5', ts, read = 0, w5 = 0, w1 = 0, input = 10, output = 100, extra = {}, id } = {}) {
  const mid = id || 'msg_' + ++seq;
  return {
    type: 'assistant', sessionId: session, cwd: '/x/proj', requestId: 'req_' + mid, timestamp: new Date(ts).toISOString(), ...extra,
    message: {
      id: mid, model, role: 'assistant', content: [],
      usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: w5 + w1, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 }, output_tokens: output },
    },
  };
}
const T0 = Date.parse('2026-10-01T00:00:00Z');
const MIN = 60 * 1000;

test('dedupes lines that repeat one message usage', () => {
  const d = tmp();
  const a = asst({ ts: T0, w1: 20000 });
  write(path.join(d, 's1.jsonl'), [a, a, { type: 'user', sessionId: 's1' }, asst({ ts: T0 + MIN, read: 20000, w1: 500 })]);
  const reqs = parseFile(path.join(d, 's1.jsonl'));
  assert.equal(reqs.length, 2);
  assert.equal(reqs[0].kind, 'main');
  assert.equal(reqs[0].agentType, 'main');
  assert.equal(promptSize(reqs[0]), 20010);
});

test('skips synthetic and API error messages', () => {
  const d = tmp();
  write(path.join(d, 's1.jsonl'), [
    asst({ ts: T0, model: '<synthetic>' }),
    asst({ ts: T0, extra: { isApiErrorMessage: true } }),
    asst({ ts: T0 }),
  ]);
  assert.equal(parseFile(path.join(d, 's1.jsonl')).length, 1);
});

test('attributes subagent files via meta.json, attributionAgent, or isSidechain', () => {
  const d = tmp();
  const sub = path.join(d, 'proj', 's1', 'subagents');
  write(path.join(sub, 'agent-aaa.jsonl'), [asst({ ts: T0, extra: { isSidechain: true, agentId: 'aaa' } })]);
  fs.writeFileSync(path.join(sub, 'agent-aaa.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'look around', spawnDepth: 1 }));
  write(path.join(sub, 'agent-bbb.jsonl'), [asst({ ts: T0, extra: { isSidechain: true, agentId: 'bbb', attributionAgent: 'general-purpose' } })]);
  write(path.join(d, 'proj', 'old.jsonl'), [asst({ ts: T0, session: 'old', extra: { isSidechain: true } })]);
  const { requests } = loadRequests([d]);
  const types = Object.fromEntries(requests.map((r) => [r.stream, r.agentType]));
  assert.equal(types['agent:aaa'], 'Explore');
  assert.equal(types['agent:bbb'], 'general-purpose');
  const old = requests.find((r) => r.session === 'old');
  assert.equal(old.kind, 'subagent');
  assert.equal(old.agentType, 'unknown');
  assert.equal(requests.find((r) => r.agentId === 'aaa').description, 'look around');
});

test('dedupes the same API message copied into two session files', () => {
  const d = tmp();
  const a = asst({ ts: T0, w1: 30000, id: 'msg_shared' });
  write(path.join(d, 'p', 'one.jsonl'), [a]);
  write(path.join(d, 'p', 'two.jsonl'), [{ ...a, sessionId: 'two' }]);
  assert.equal(loadRequests([d]).requests.length, 1);
});

test('classifies cache rebuilds', () => {
  const prev = { model: 'm', ts: T0, uncached: 0, cacheWrite5m: 0, cacheWrite1h: 2000, cacheRead: 100000, output: 0 };
  const next = (o) => ({ model: 'm', ts: T0 + MIN, uncached: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, ...o });
  assert.equal(classifyRebuild(prev, next({ cacheRead: 102000, cacheWrite1h: 3000 })), null, 'incremental write');
  assert.equal(classifyRebuild(prev, next({ cacheWrite1h: 102000, ts: T0 + 61 * MIN })), 'expired');
  assert.equal(classifyRebuild(prev, next({ cacheWrite1h: 102000, ts: T0 + 30 * MIN })), 'invalidated', '1h TTL still warm');
  const prev5 = { ...prev, cacheWrite1h: 0, cacheWrite5m: 2000 };
  assert.equal(classifyRebuild(prev5, next({ cacheWrite5m: 102000, ts: T0 + 6 * MIN })), 'expired', '5m TTL');
  assert.equal(classifyRebuild(prev, next({ model: 'other', cacheWrite1h: 102000 })), 'model-switch');
  assert.equal(classifyRebuild(prev, next({ cacheWrite1h: 30000 })), 'context-shrank');
  assert.equal(classifyRebuild(prev, next({ cacheWrite1h: 5000 })), null, 'below min size');
});

test('prices tiers and resolves model aliases', () => {
  assert.equal(resolveModel('haiku-5.5', prices), 'claude-haiku-5-5');
  assert.equal(resolveModel('claude-opus-5-5-20261001', prices), 'claude-opus-5-5');
  assert.equal(resolveModel('nope', prices), null);
  const r = { model: 'claude-opus-5-5', uncached: 1e6, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
  assert.equal(cost(r, prices), 4);
  // 1M-token prompt is above Haiku 5.5's 100K line → second tier ($0.50/M)
  assert.equal(cost(r, prices, 'claude-haiku-5-5'), 0.5);
  assert.equal(cost({ ...r, model: 'mystery' }, prices), null);
});

function scenario() {
  const d = tmp();
  const proj = path.join(d, 'proj');
  // main: Opus, 3 turns, then an idle gap past the 1h TTL
  write(path.join(proj, 's1.jsonl'), [
    asst({ ts: T0, w1: 30000 }),
    asst({ ts: T0 + MIN, read: 30000, w1: 2000 }),
    asst({ ts: T0 + 2 * MIN, read: 32000, w1: 2000 }),
    asst({ ts: T0 + 120 * MIN, w1: 34000 }),
  ]);
  const sub = path.join(proj, 's1', 'subagents');
  write(path.join(sub, 'agent-x1.jsonl'), [
    asst({ ts: T0 + 90 * 1000, read: 15000, w1: 5000, extra: { isSidechain: true, agentId: 'x1' } }),
    asst({ ts: T0 + 100 * 1000, read: 20000, w1: 3000, extra: { isSidechain: true, agentId: 'x1' } }),
  ]);
  fs.writeFileSync(path.join(sub, 'agent-x1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'find it' }));
  write(path.join(sub, 'agent-x2.jsonl'), [
    asst({ ts: T0 + 95 * 1000, model: 'claude-haiku-5-5', w1: 10000, extra: { isSidechain: true, agentId: 'x2' } }),
  ]);
  fs.writeFileSync(path.join(sub, 'agent-x2.meta.json'), JSON.stringify({ agentType: 'scout' }));
  return d;
}

test('attributes tokens, inheritance, replay and rebuilds', () => {
  const { requests } = loadRequests([scenario()]);
  const a = analyze(requests, prices);
  const row = (n) => a.rows.find((r) => r.name === n);
  assert.equal(a.rows[0].kind, 'main');
  assert.equal(row('Explore').runs, 1);
  assert.equal(row('Explore').requests, 2);
  assert.equal(row('Explore').inheritedShare, 1);
  assert.equal(row('scout').inheritedShare, 0);
  const shares = a.rows.reduce((s, r) => s + r.tokenShare, 0);
  assert.ok(Math.abs(shares - 1) < 1e-9);
  // Explore replayed on Haiku is cheaper; scout is already on Haiku → no saving
  assert.ok(row('Explore').whatIf < row('Explore').cost);
  assert.ok(Math.abs(row('scout').saving) < 1e-12);
  // the first Explore request is replayed as a full cache write, so the
  // replay costs more than a naive per-request reprice
  const naive = requests.filter((r) => r.agentType === 'Explore').reduce((s, r) => s + cost(r, prices, 'claude-haiku-5-5'), 0);
  assert.ok(row('Explore').whatIf > naive);
  assert.equal(a.rebuilds.count, 1);
  assert.equal(a.rebuilds.byReason[0].reason, 'expired');
  assert.equal(a.rebuilds.byReason[0].tokens, 34000);
  assert.ok(a.rebuilds.premium > 0);
  assert.equal(a.subagents.runs, 2);
  assert.equal(a.subagents.openingMedian, median([20010, 10010]));
  const f = findings(a, prices).map((x) => x.text).join('\n');
  assert.match(f, /Explore on Haiku 5\.5/);
  assert.match(f, /\.claude\/agents\/Explore\.md/);
  assert.match(f, /1 resume after the cache expired/);
});

test('CLI: --help, --json, --md, errors', () => {
  const help = execFileSync('node', [bin, '--help'], { encoding: 'utf8' });
  assert.match(help, /Usage/);
  const d = scenario();
  const j = JSON.parse(execFileSync('node', [bin, d, '--json'], { encoding: 'utf8' }));
  assert.equal(j.total.requests, 7);
  assert.equal(j.version, '0.1.0');
  const md = execFileSync('node', [bin, d, '--md'], { encoding: 'utf8' });
  assert.match(md, /\| Explore \|/);
  assert.doesNotMatch(md, /find it/, 'markdown leaves out task descriptions');
  const txt = execFileSync('node', [bin, d, '--no-color', '--no-desc'], { encoding: 'utf8' });
  assert.doesNotMatch(txt, /BIGGEST SUBAGENT RUNS/);
  assert.doesNotMatch(txt, /\x1b\[/);
  assert.equal(spawnSync('node', [bin, d, '--bogus']).status, 2);
  assert.equal(spawnSync('node', [bin, tmp()]).status, 2);
  assert.equal(spawnSync('node', [bin, d, '--to', 'not-a-model']).status, 2);
  assert.equal(spawnSync('node', [bin, d, '--since', '1h']).status, 2, 'fixture is older than 1h');
  const j2 = JSON.parse(execFileSync('node', [bin, d, '--json', '--since', '2026-10-01T01:00:00Z'], { encoding: 'utf8' }));
  assert.equal(j2.total.requests, 1);
});

test('demo generator output parses and shows subagent share', () => {
  const d = tmp();
  execFileSync('node', [path.join(root, 'scripts', 'make-demo.js'), d]);
  const { requests } = loadRequests([d]);
  const a = analyze(requests, prices);
  assert.ok(a.subagents.tokenShare > 0.3);
  assert.ok(a.rebuilds.byReason.some((b) => b.reason === 'expired'));
  assert.ok(a.rebuilds.byReason.some((b) => b.reason === 'model-switch'));
});
