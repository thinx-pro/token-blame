// Read Claude Code session logs into a flat list of API requests, each tagged
// with who made it: the main conversation or a subagent (and which type).
//
// A request is { session, project, stream, kind, agentType, agentId, depth,
//                description, model, ts, uncached, cacheWrite5m, cacheWrite1h,
//                cacheRead, output }.
// stream = one continuous conversation (the main session, or one subagent run).

import fs from 'node:fs';
import path from 'node:path';

export function listJsonl(root) {
  const out = [];
  let st;
  try { st = fs.statSync(root); } catch { return out; }
  if (st.isFile()) return root.endsWith('.jsonl') ? [root] : out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  }
  return out.sort();
}

function* lines(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    try { yield JSON.parse(line); } catch { /* skip partial line */ }
  }
}

const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function split(u) {
  const cc = u.cache_creation || {};
  let cw1 = n(cc.ephemeral_1h_input_tokens);
  let cw5 = n(cc.ephemeral_5m_input_tokens);
  const cwTotal = n(u.cache_creation_input_tokens);
  if (cw1 + cw5 === 0 && cwTotal > 0) cw5 = cwTotal; // older logs: no split, assume 5m
  return {
    uncached: n(u.input_tokens),
    cacheWrite5m: cw5,
    cacheWrite1h: cw1,
    cacheRead: n(u.cache_read_input_tokens),
    output: n(u.output_tokens),
  };
}

// Subagent transcripts live in <session>/subagents/agent-<id>.jsonl, with an
// optional agent-<id>.meta.json next to them ({ agentType, description, spawnDepth }).
function readMeta(file) {
  const metaFile = file.replace(/\.jsonl$/, '.meta.json');
  try { return JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch { return null; }
}

function projectName(cwd, file) {
  if (cwd) return path.basename(cwd);
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf('subagents');
  return i > 2 ? parts[i - 2] : path.basename(path.dirname(file));
}

// Claude Code writes one JSONL line per content block, each repeating the
// message usage. Keep the last line per message id + request id.
export function parseFile(file) {
  const inSubDir = file.split(path.sep).includes('subagents');
  const meta = inSubDir ? readMeta(file) : null;
  const byId = new Map();
  let anon = 0;
  for (const d of lines(file)) {
    if (d.type !== 'assistant' || !d.message || !d.message.usage) continue;
    const m = d.message;
    if (!m.model || m.model === '<synthetic>' || d.isApiErrorMessage) continue;
    const isSub = inSubDir || !!d.isSidechain || !!d.agentId;
    const agentId = isSub ? (d.agentId || path.basename(file, '.jsonl').replace(/^agent-/, '')) : null;
    const session = d.sessionId || d.session_id || path.basename(file, '.jsonl');
    const agentType = isSub
      ? (meta && meta.agentType) || d.attributionAgent || 'unknown'
      : 'main';
    const key = m.id || d.requestId ? (m.id || '') + '|' + (d.requestId || '') : 'anon' + anon++;
    const base = {
      session,
      project: projectName(d.cwd, file),
      stream: isSub ? 'agent:' + agentId : 'main:' + session,
      kind: isSub ? 'subagent' : 'main',
      agentType,
      agentId,
      depth: isSub ? (meta && meta.spawnDepth) || 1 : 0,
      description: (meta && meta.description) || '',
      model: m.model,
      ts: d.timestamp ? Date.parse(d.timestamp) : NaN,
    };
    const iters = Array.isArray(m.usage.iterations)
      ? m.usage.iterations.filter((it) => it && (it.type === 'message' || it.type === undefined))
      : [];
    const parts = iters.length > 1 ? iters.map(split) : [split(m.usage)];
    byId.set(key, parts.map((p, i) => ({ ...base, ...p, uid: key.startsWith('anon') ? null : key + '#' + i })));
  }
  return [...byId.values()].flat();
}

export function loadRequests(roots) {
  const files = roots.flatMap(listJsonl);
  // The same request can appear in more than one file (resumed / forked
  // sessions copy history). Dedupe across files on the API message/request id.
  const seen = new Set();
  const out = [];
  for (const f of files) {
    for (const r of parseFile(f)) {
      const k = r.uid || [r.stream, r.ts, r.model, r.uncached, r.cacheWrite5m, r.cacheWrite1h, r.cacheRead, r.output].join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
  }
  return { files, requests: out };
}

export function promptSize(r) {
  return r.uncached + r.cacheWrite5m + r.cacheWrite1h + r.cacheRead;
}

export function totalTokens(r) {
  return promptSize(r) + r.output;
}
