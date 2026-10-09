#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRequests } from '../src/parse.js';
import { analyze, findings } from '../src/analyze.js';
import { renderText, renderMarkdown } from '../src/render.js';
import { resolveModel } from '../src/price.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const prices = JSON.parse(fs.readFileSync(path.join(here, '..', 'prices.json'), 'utf8'));

const HELP = `token-blame ${pkg.version}
Who spent your Claude Code tokens: main conversation vs each subagent type,
cache rebuilds and why, and what subagents would cost on a cheaper model.
Reads local logs only; nothing leaves your machine.

Usage
  npx token-blame [paths...] [options]

Paths default to $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects.
A path can be a directory or a single session .jsonl file.

Options
  --since <when>     7d, 24h, 2w or YYYY-MM-DD (default: everything)
  --project <text>   only sessions whose project folder name contains <text>
  --to <model>       model to replay subagents on (default: haiku-5.5)
  --top <n>          biggest subagent runs to list (default: 5, 0 hides)
  --min-rebuild <n>  smallest cache rewrite counted as a rebuild (default: 10000)
  --no-desc          hide subagent task descriptions (for screenshots)
  --md               Markdown summary (no task descriptions)
  --json             machine-readable result
  --no-color         plain text
  -v, --version      print version
  -h, --help         this help
`;

function parseArgs(argv) {
  const o = { paths: [], top: 5, color: process.stdout.isTTY && !process.env.NO_COLOR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v == null) fail(`${a} needs a value`);
      return v;
    };
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a === '--since') o.since = val();
    else if (a === '--project') o.project = val();
    else if (a === '--to') o.to = val();
    else if (a === '--top') o.top = Number(val());
    else if (a === '--min-rebuild') o.minRebuild = Number(val());
    else if (a === '--no-desc') o.noDesc = true;
    else if (a === '--md') o.md = true;
    else if (a === '--json') o.json = true;
    else if (a === '--no-color') o.color = false;
    else if (a === '--color') o.color = true;
    else if (a.startsWith('-')) fail(`unknown option ${a} (see --help)`);
    else o.paths.push(a);
  }
  return o;
}

function fail(msg) {
  console.error('token-blame: ' + msg);
  process.exit(2);
}

export function sinceToMs(s, now = Date.now()) {
  const m = /^(\d+)([hdw])$/.exec(s);
  if (m) return now - Number(m[1]) * { h: 3600e3, d: 86400e3, w: 604800e3 }[m[2]];
  const t = Date.parse(s);
  if (Number.isNaN(t)) fail(`can't read --since ${s}`);
  return t;
}

const o = parseArgs(process.argv.slice(2));
if (o.help) { process.stdout.write(HELP); process.exit(0); }
if (o.version) { console.log(pkg.version); process.exit(0); }
if (o.to && !resolveModel(o.to, prices)) fail(`unknown model ${o.to}; known: ${Object.keys(prices.models).join(', ')}`);
if (!Number.isFinite(o.top) || o.top < 0) fail('--top must be a number ≥ 0');

const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const roots = o.paths.length ? o.paths : [path.join(base, 'projects')];
let { files, requests } = loadRequests(roots);
if (!files.length) fail(`no .jsonl session logs found in ${roots.join(', ')}`);
if (o.since) {
  const t = sinceToMs(o.since);
  requests = requests.filter((r) => Number.isFinite(r.ts) && r.ts >= t);
}
if (o.project) requests = requests.filter((r) => r.project.toLowerCase().includes(o.project.toLowerCase()));
if (!requests.length) fail('no API requests matched (check --since / --project)');

const a = analyze(requests, prices, { to: o.to, top: o.top, minRebuild: o.minRebuild });
if (o.json) console.log(JSON.stringify({ version: pkg.version, prices: prices.retrieved, files: files.length, ...a, findings: findings(a, prices) }, null, 2));
else if (o.md) console.log(renderMarkdown(a, prices));
else console.log(renderText(a, prices, { color: o.color, hideDescriptions: o.noDesc, width: process.stdout.columns }));
