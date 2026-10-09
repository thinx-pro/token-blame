// Generate a synthetic, deterministic Claude Code projects folder for the
// README demo and tests. It mirrors the real on-disk layout:
//   <project>/<session>.jsonl
//   <project>/<session>/subagents/agent-<id>.jsonl + agent-<id>.meta.json
// Each assistant message is written twice (one line per content block), as
// Claude Code does, so the parser's dedupe is exercised.
// Usage: node scripts/make-demo.js [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || path.join(here, '..', 'demo', 'claude');

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const between = (a, b) => Math.round(a + rnd() * (b - a));

const MAIN_MODEL = 'claude-opus-5-5';
let msg = 0;

function line(o) { return JSON.stringify(o); }

// One conversation stream. Returns jsonl lines and the final clock.
function stream({ sessionId, cwd, agentId, model, turns, start, t, idleAt = [], switchAt = -1, compactAt = Infinity }) {
  const out = [];
  let ctx = start;
  let curModel = model;
  let prevWrite1h = true;
  for (let i = 0; i < turns; i++) {
    const idle = idleAt.includes(i);
    t += idle ? between(75, 180) * 60 * 1000 : between(6, 50) * 1000;
    if (i === switchAt) curModel = 'claude-sonnet-5-5';
    const growth = between(1200, 6000);
    let usage;
    if (i === 0 || idle || i === switchAt) {
      usage = { input_tokens: between(1, 30), cache_creation_input_tokens: ctx, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: ctx } };
      if (i === 0 && agentId) { // subagents share the system prompt / tools prefix with the parent
        const shared = Math.min(ctx - 2000, 15000);
        usage = { input_tokens: between(1, 30), cache_creation_input_tokens: ctx - shared, cache_read_input_tokens: shared, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: ctx - shared } };
      }
    } else {
      usage = { input_tokens: between(1, 30), cache_creation_input_tokens: growth, cache_read_input_tokens: ctx, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: growth } };
    }
    usage.output_tokens = between(150, 1600);
    prevWrite1h = true;
    const id = `msg_demo_${++msg}`;
    const base = {
      type: 'assistant', sessionId, cwd, requestId: `req_demo_${msg}`, timestamp: new Date(t).toISOString(),
      ...(agentId ? { isSidechain: true, agentId } : {}),
    };
    // Two content blocks → two lines with the same usage.
    out.push(line({ ...base, message: { id, model: curModel, role: 'assistant', content: [{ type: 'thinking' }], usage } }));
    out.push(line({ ...base, message: { id, model: curModel, role: 'assistant', content: [{ type: 'text' }], usage } }));
    ctx += growth + usage.output_tokens;
    if (ctx > compactAt) {
      ctx = between(28000, 40000);
      compactAt = Infinity;
    }
  }
  return { out, t };
}

const projects = [
  { name: 'web-shop', sessions: 2 },
  { name: 'api-server', sessions: 2 },
];
const agentPlan = [
  { type: 'Explore', desc: ['Find where auth tokens are refreshed', 'Locate rate-limit middleware', 'Trace the checkout flow', 'Find unused feature flags'], turns: 28, start: 47000 },
  { type: 'general-purpose', desc: ['Migrate tests to node:test', 'Port fetch wrapper to undici', 'Split the orders module', 'Add pagination to /search'], turns: 70, start: 52000 },
  { type: 'code-reviewer', desc: ['Review the payment refactor diff', 'Review session-store change', 'Review cache headers PR', 'Review webhook retries'], turns: 22, start: 44000 },
  { type: 'Explore', desc: ['Map the routing layer', 'List all env vars read', 'Find N+1 queries', 'Map error handling paths'], turns: 24, start: 46000 },
];
let sessionN = 0;

fs.rmSync(outDir, { recursive: true, force: true });
let t = Date.parse('2026-10-01T08:30:00Z');
let agentN = 0;
for (const p of projects) {
  const projDir = path.join(outDir, '-demo-' + p.name);
  fs.mkdirSync(projDir, { recursive: true });
  for (let s = 0; s < p.sessions; s++) {
    const sessionId = `demo-${p.name}-${s + 1}`;
    const cwd = `/demo/${p.name}`;
    const main = stream({
      sessionId, cwd, model: MAIN_MODEL, turns: 110, start: 24000, t,
      idleAt: [35, 80], switchAt: s === 1 ? 60 : -1, compactAt: 170000,
    });
    fs.writeFileSync(path.join(projDir, sessionId + '.jsonl'), main.out.join('\n') + '\n');
    const subDir = path.join(projDir, sessionId, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    let at = t + 20 * 60 * 1000;
    const si = sessionN++;
    for (const a of agentPlan) {
      const agentId = 'a' + (++agentN).toString(16).padStart(16, '0');
      const r = stream({ sessionId, cwd, agentId, model: MAIN_MODEL, turns: a.turns + between(-4, 4), start: a.start, t: at });
      fs.writeFileSync(path.join(subDir, `agent-${agentId}.jsonl`), r.out.join('\n') + '\n');
      fs.writeFileSync(path.join(subDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: a.type, description: a.desc[si % a.desc.length], spawnDepth: 1 }));
      at += 25 * 60 * 1000;
    }
    t = main.t + 3 * 3600 * 1000;
  }
}
console.log(`wrote demo projects to ${outDir}`);
