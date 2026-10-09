// Attribute requests to who made them, find cache rebuilds, and replay
// subagent work on a cheaper model.
import { promptSize, totalTokens } from './parse.js';
import { cost, resolveModel } from './price.js';

const FIVE_MIN = 5 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function byStream(requests) {
  const m = new Map();
  for (const r of requests) {
    if (!m.has(r.stream)) m.set(r.stream, []);
    m.get(r.stream).push(r);
  }
  for (const list of m.values()) list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return m;
}

// Why was a big chunk of the prompt written to cache again instead of read?
// Returns null for normal incremental writes.
export function classifyRebuild(prev, r, minTokens = 10000) {
  const write = r.cacheWrite5m + r.cacheWrite1h;
  const size = promptSize(r);
  if (write < minTokens || write < 0.5 * size) return null;
  if (prev.model !== r.model) return 'model-switch';
  const prevSize = promptSize(prev);
  if (size < 0.6 * prevSize) return 'context-shrank';
  const ttl = prev.cacheWrite1h > 0 && prev.cacheWrite1h >= prev.cacheWrite5m ? ONE_HOUR : FIVE_MIN;
  const gap = (r.ts || 0) - (prev.ts || 0);
  if (Number.isFinite(gap) && gap > ttl) return 'expired';
  return 'invalidated';
}

export const REBUILD_LABEL = {
  expired: 'cache expired (idle past TTL)',
  'model-switch': 'model switched mid-stream',
  'context-shrank': 'context shrank (compact / clear)',
  invalidated: 'rebuilt before TTL (prefix changed)',
};

// What the rebuild cost beyond reading the same tokens from cache.
function rebuildPremium(r, prices) {
  const asRead = { ...r, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: r.cacheRead + r.cacheWrite5m + r.cacheWrite1h };
  const a = cost(r, prices);
  const b = cost(asRead, prices);
  return a == null || b == null ? 0 : a - b;
}

export function analyze(requests, prices, opts = {}) {
  const target = resolveModel(opts.to || 'claude-haiku-5-5', prices);
  const minRebuild = opts.minRebuild ?? 10000;
  const streams = byStream(requests);

  // The main conversation's model when each subagent started, to spot
  // inheritance: the last main request at or before the subagent's first one.
  const mains = new Map();
  for (const [key, list] of streams) if (key.startsWith('main:')) mains.set(list[0].session, list);
  const parentOf = new Map();
  for (const [key, list] of streams) {
    if (!key.startsWith('agent:')) continue;
    const main = mains.get(list[0].session);
    if (!main) continue;
    const t0 = list[0].ts;
    let pick = main[0];
    for (const m of main) { if (m.ts <= t0) pick = m; else break; }
    parentOf.set(key, pick.model);
  }

  const total = { requests: 0, tokens: 0, output: 0, cost: 0, unpriced: 0, unpricedModels: new Set() };
  const groups = new Map();
  const group = (name, kind) => {
    if (!groups.has(name)) {
      groups.set(name, {
        name, kind, runs: new Set(), requests: 0, tokens: 0, output: 0, cost: 0,
        whatIf: 0, whatIfPriced: true, models: new Map(), openings: [], inherited: 0,
      });
    }
    return groups.get(name);
  };

  // On another model a subagent can't read the cache it shared with its parent
  // (system prompt, tools, or the whole context for forks), so its first
  // request is replayed as a full cache write.
  const firsts = new Set([...streams.values()].map((list) => list[0]));
  const coldStart = (r) => ({ ...r, cacheWrite5m: r.cacheWrite5m + r.cacheRead, cacheRead: 0 });

  for (const r of requests) {
    const g = group(r.agentType, r.kind);
    const t = totalTokens(r);
    const c = cost(r, prices);
    g.runs.add(r.stream);
    g.requests += 1;
    g.tokens += t;
    g.output += r.output;
    g.models.set(r.model, (g.models.get(r.model) || 0) + t);
    total.requests += 1;
    total.tokens += t;
    total.output += r.output;
    if (c == null) { total.unpriced += 1; total.unpricedModels.add(r.model); g.whatIfPriced = false; continue; }
    g.cost += c;
    total.cost += c;
    if (r.kind === 'subagent') {
      if (parentOf.get(r.stream) === r.model) g.inherited += t;
      const switched = target && resolveModel(r.model, prices) !== target;
      const alt = switched ? cost(firsts.has(r) ? coldStart(r) : r, prices, target) : null;
      g.whatIf += alt == null ? c : alt;
    }
  }

  const rebuilds = { events: [], byReason: {} };
  const runs = [];
  for (const [key, list] of streams) {
    const first = list[0];
    groups.get(first.agentType).openings.push(promptSize(first));
    for (let i = 1; i < list.length; i++) {
      const reason = classifyRebuild(list[i - 1], list[i], minRebuild);
      if (!reason) continue;
      const r = list[i];
      const ev = {
        reason, kind: r.kind, agentType: r.agentType, tokens: r.cacheWrite5m + r.cacheWrite1h,
        premium: rebuildPremium(r, prices), gapMs: (r.ts || 0) - (list[i - 1].ts || 0),
      };
      rebuilds.events.push(ev);
      const b = (rebuilds.byReason[reason] ||= { reason, count: 0, tokens: 0, premium: 0, sizes: [] });
      b.count += 1;
      b.tokens += ev.tokens;
      b.premium += ev.premium;
      b.sizes.push(ev.tokens);
    }
    if (key.startsWith('agent:')) {
      let tokens = 0, c = 0;
      for (const r of list) { tokens += totalTokens(r); c += cost(r, prices) || 0; }
      runs.push({
        agentType: first.agentType, description: first.description, model: first.model,
        project: first.project, requests: list.length, tokens, cost: c, depth: first.depth,
      });
    }
  }
  for (const b of Object.values(rebuilds.byReason)) { b.median = median(b.sizes); delete b.sizes; }
  runs.sort((a, b) => b.tokens - a.tokens);

  const rows = [...groups.values()]
    .map((g) => ({
      name: g.name,
      kind: g.kind,
      runs: g.runs.size,
      requests: g.requests,
      tokens: g.tokens,
      output: g.output,
      cost: g.cost,
      tokenShare: total.tokens ? g.tokens / total.tokens : 0,
      costShare: total.cost ? g.cost / total.cost : 0,
      openingMedian: median(g.openings),
      models: [...g.models].sort((a, b) => b[1] - a[1]).map(([model, tokens]) => ({ model, share: g.tokens ? tokens / g.tokens : 0 })),
      inheritedShare: g.kind === 'subagent' && g.tokens ? g.inherited / g.tokens : null,
      whatIf: g.kind === 'subagent' ? g.whatIf : null,
      saving: g.kind === 'subagent' ? g.cost - g.whatIf : 0,
    }))
    .sort((a, b) => (a.kind === 'main' ? -1 : b.kind === 'main' ? 1 : b.tokens - a.tokens));

  const sub = rows.filter((r) => r.kind === 'subagent');
  const subTokens = sub.reduce((s, r) => s + r.tokens, 0);
  const subCost = sub.reduce((s, r) => s + r.cost, 0);
  const subInherited = sub.reduce((s, r) => s + (r.inheritedShare || 0) * r.tokens, 0);
  const subOpenings = [...groups.values()].filter((g) => g.kind === 'subagent').flatMap((g) => g.openings);
  const times = requests.map((r) => r.ts).filter(Number.isFinite);

  return {
    target,
    range: times.length ? { from: Math.min(...times), to: Math.max(...times) } : null,
    total: { ...total, unpricedModels: [...total.unpricedModels], sessions: new Set(requests.map((r) => r.session)).size },
    rows,
    subagents: {
      runs: sub.reduce((s, r) => s + r.runs, 0),
      tokens: subTokens,
      cost: subCost,
      tokenShare: total.tokens ? subTokens / total.tokens : 0,
      outputShare: total.output ? sub.reduce((s, r) => s + r.output, 0) / total.output : 0,
      costShare: total.cost ? subCost / total.cost : 0,
      inheritedShare: subTokens ? subInherited / subTokens : 0,
      openingMedian: median(subOpenings),
      saving: sub.reduce((s, r) => s + r.saving, 0),
    },
    rebuilds: {
      count: rebuilds.events.length,
      tokens: rebuilds.events.reduce((s, e) => s + e.tokens, 0),
      premium: rebuilds.events.reduce((s, e) => s + e.premium, 0),
      byReason: Object.values(rebuilds.byReason).sort((a, b) => b.tokens - a.tokens),
    },
    topRuns: runs.slice(0, opts.top ?? 5),
  };
}

// Plain-language findings with the config change that acts on each.
export function findings(a, prices) {
  const out = [];
  const tLabel = a.target ? prices.models[a.target].label : 'a cheaper model';
  const alias = a.target ? a.target.replace(/^claude-/, '').replace(/-\d.*$/, '') : 'haiku';
  if (a.subagents.tokens > 0) {
    out.push({
      level: a.subagents.tokenShare >= 0.25 ? 'warn' : 'info',
      text: `Subagents made ${pct(a.subagents.tokenShare)} of all tokens and ${pct(a.subagents.costShare)} of list-price cost across ${a.subagents.runs} runs.`,
    });
  }
  if (a.subagents.inheritedShare >= 0.5) {
    out.push({
      level: 'warn',
      text: `${pct(a.subagents.inheritedShare)} of subagent tokens ran on the same model as the main conversation (inherited, not chosen).`,
    });
  }
  const cand = a.rows.filter((r) => r.kind === 'subagent' && r.saving > 0.005 && r.cost > 0 && r.saving / r.cost >= 0.2)
    .sort((x, y) => y.saving - x.saving).slice(0, 3);
  for (const r of cand) {
    const builtin = r.name === 'Explore' || r.name === 'Plan';
    const claude = a.target && prices.models[a.target].vendor === 'anthropic';
    const how = !claude
      ? 'not selectable inside Claude Code — shown for comparison'
      : builtin
      ? `define .claude/agents/${r.name}.md with \`model: ${alias}\` (overrides the built-in)`
      : r.name === 'fork'
        ? `forks copy the main conversation, so move that work to a named subagent with \`model: ${alias}\``
      : r.name === 'general-purpose' || r.name === 'unknown'
        ? `set CLAUDE_CODE_SUBAGENT_MODEL=${alias}, or define a named subagent with \`model: ${alias}\``
        : `add \`model: ${alias}\` to the ${r.name} agent's frontmatter`;
    out.push({
      level: 'tip',
      text: `${r.name} on ${tLabel}: ${usd(r.cost)} → ${usd(r.whatIf)} (−${pct(r.saving / r.cost)}). To try it: ${how}.`,
    });
  }
  const exp = a.rebuilds.byReason.find((b) => b.reason === 'expired');
  if (exp && exp.count) {
    out.push({
      level: 'warn',
      text: `${exp.count} ${exp.count === 1 ? 'resume' : 'resumes'} after the cache expired re-wrote ${fmt(exp.tokens)} tokens (median ${fmt(exp.median)} each, ${usd(exp.premium)} over cache-read price).`,
    });
  }
  const inv = a.rebuilds.byReason.find((b) => b.reason === 'invalidated');
  if (inv && inv.count) {
    out.push({
      level: 'info',
      text: `${inv.count} cache ${inv.count === 1 ? 'rebuild' : 'rebuilds'} happened before the TTL ran out — the prompt prefix changed (tools, MCP servers, system prompt or memory edited mid-session).`,
    });
  }
  if (a.subagents.openingMedian > 0) {
    out.push({
      level: 'info',
      text: `A subagent's first request carries a median ${fmt(a.subagents.openingMedian)}-token prompt before it does any work.`,
    });
  }
  return out;
}

export function fmt(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(v));
}

export function usd(v) {
  if (v >= 100) return '$' + Math.round(v).toLocaleString('en-US');
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toFixed(v >= 0.01 ? 2 : 3);
}

export function pct(v) {
  return (v * 100).toFixed(v >= 0.1 ? 0 : 1) + '%';
}
