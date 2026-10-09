// Terminal and Markdown renderers.
import { fmt, usd, pct, REBUILD_LABEL, findings } from './analyze.js';
import { label } from './price.js';

const codes = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 };

function painter(on) {
  const p = {};
  for (const [k, c] of Object.entries(codes)) p[k] = (s) => (on ? `\x1b[${c}m${s}\x1b[0m` : String(s));
  return p;
}

const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const padR = (s, w) => s + ' '.repeat(Math.max(0, w - visible(s).length));
const padL = (s, w) => ' '.repeat(Math.max(0, w - visible(s).length)) + s;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

function wrap(text, width) {
  const out = [];
  let cur = '';
  for (const w of text.split(' ')) {
    if (cur && cur.length + 1 + w.length > width) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) out.push(cur);
  return out;
}

function bar(share, width, c) {
  const full = Math.round(share * width);
  return c.cyan('█'.repeat(full)) + c.gray('░'.repeat(width - full));
}

function who(r) {
  return r.kind === 'main' ? 'main conversation' : r.name;
}

function modelMix(r, prices) {
  return r.models.slice(0, 2).map((m) => `${label(m.model, prices)} ${pct(m.share)}`).join(', ');
}

export function renderText(a, prices, opts = {}) {
  const c = painter(opts.color);
  const L = [];
  L.push(c.bold('token-blame') + c.gray(' · who spent your Claude Code tokens'));
  const range = a.range ? `${day(a.range.from)} → ${day(a.range.to)}` : 'no timestamps';
  L.push(c.gray(`${a.total.requests.toLocaleString('en-US')} requests · ${a.total.sessions} sessions · ${range} · list prices from prices.json (${prices.retrieved})`));
  L.push('');

  const head = [padR('WHO', 20), padL('RUNS', 5), padL('REQS', 7), padL('TOKENS', 8), '  ' + padR('SHARE', 17), padL('COST', 9), '  ' + 'MODEL'];
  L.push(c.bold(head.join('')));
  for (const r of a.rows) {
    const raw = who(r).length > 19 ? who(r).slice(0, 18) + '…' : who(r);
    const name = r.kind === 'main' ? c.bold(raw) : raw;
    L.push([
      padR(name, 20),
      padL(String(r.runs), 5),
      padL(fmt(r.requests), 7),
      padL(fmt(r.tokens), 8),
      '  ' + bar(r.tokenShare, 12, c) + ' ' + padL(pct(r.tokenShare), 4),
      padL(usd(r.cost), 9),
      '  ' + c.gray(modelMix(r, prices)),
    ].join(''));
  }
  L.push('');

  const s = a.subagents;
  if (s.tokens > 0) {
    L.push(c.bold('SUBAGENTS ') + [
      `${c.yellow(pct(s.tokenShare))} of tokens`,
      `${pct(s.outputShare)} of output`,
      `${pct(s.costShare)} of cost`,
      `${c.yellow(pct(s.inheritedShare))} on the parent's model`,
      `opening prompt median ${fmt(s.openingMedian)}`,
    ].join(c.gray(' · ')));
    const t = a.target ? prices.models[a.target].label : '?';
    const tips = a.rows.filter((r) => r.kind === 'subagent' && r.saving > 0.005);
    if (tips.length) {
      L.push(c.gray(`  replayed on ${t}:`));
      for (const r of tips.slice(0, 5)) {
        L.push(`  ${padR(r.name, 18)} ${padL(usd(r.cost), 9)} → ${c.green(padL(usd(r.whatIf), 8))}  ${c.green('−' + pct(r.saving / (r.cost || 1)))}`);
      }
    }
    L.push('');
  }

  if (a.rebuilds.count) {
    L.push(c.bold('CACHE REBUILDS ') + c.gray(`${a.rebuilds.count} times, ${fmt(a.rebuilds.tokens)} tokens re-written, ${usd(a.rebuilds.premium)} above cache-read price`));
    for (const b of a.rebuilds.byReason) {
      L.push(`  ${padR(REBUILD_LABEL[b.reason], 38)} ${padL(String(b.count), 5)}×  ${padL(fmt(b.tokens), 7)}  median ${padL(fmt(b.median), 6)}  ${c.yellow('+' + usd(b.premium))}`);
    }
    L.push('');
  }

  if (a.topRuns.length && !opts.hideDescriptions) {
    L.push(c.bold('BIGGEST SUBAGENT RUNS'));
    for (const r of a.topRuns) {
      const d = (r.description || '').replace(/\s+/g, ' ');
      const desc = d.length > 36 ? d.slice(0, 35) + '…' : d;
      L.push(`  ${padR(r.agentType, 16)} ${padR(c.gray(desc || '—'), 37)} ${padL(fmt(r.tokens), 7)} ${padL(usd(r.cost), 8)}  ${c.gray(label(r.model, prices))}`);
    }
    L.push('');
  }

  const f = findings(a, prices);
  if (f.length) {
    L.push(c.bold('FINDINGS'));
    const mark = { warn: c.yellow('!'), info: c.blue('·'), tip: c.green('→') };
    const width = Math.max(60, Math.min(opts.width || 100, 120));
    for (const x of f) L.push(`  ${mark[x.level]} ${wrap(x.text, width - 4).join('\n    ')}`);
    L.push('');
  }
  if (a.total.unpriced) {
    L.push(c.gray(`${a.total.unpriced} requests on models missing from prices.json were counted in tokens but not cost: ${a.total.unpricedModels.join(', ')}`));
  }
  L.push(c.gray('Cost = API list price for the logged tokens. On a subscription you pay a flat fee; read cost as relative weight.'));
  return L.join('\n');
}

export function renderMarkdown(a, prices) {
  const L = [];
  const range = a.range ? `${day(a.range.from)} → ${day(a.range.to)}` : '';
  L.push(`## token-blame report`, '', `${a.total.requests} requests · ${a.total.sessions} sessions · ${range} · list prices ${prices.retrieved}`, '');
  L.push('| Who | Runs | Requests | Tokens | Share | List cost | Models |', '|---|---:|---:|---:|---:|---:|---|');
  for (const r of a.rows) {
    L.push(`| ${who(r)} | ${r.runs} | ${r.requests} | ${fmt(r.tokens)} | ${pct(r.tokenShare)} | ${usd(r.cost)} | ${modelMix(r, prices)} |`);
  }
  L.push('');
  if (a.rebuilds.count) {
    L.push('| Cache rebuild | Count | Tokens | Median | Premium |', '|---|---:|---:|---:|---:|');
    for (const b of a.rebuilds.byReason) L.push(`| ${REBUILD_LABEL[b.reason]} | ${b.count} | ${fmt(b.tokens)} | ${fmt(b.median)} | ${usd(b.premium)} |`);
    L.push('');
  }
  for (const x of findings(a, prices)) L.push(`- ${x.text}`);
  L.push('', '_Subagent task descriptions are left out of Markdown output on purpose._');
  return L.join('\n');
}
