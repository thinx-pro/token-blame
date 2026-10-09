// Render token-blame's colored output as an HTML page, for README screenshots.
// Usage: node bin/token-blame.js demo/claude --color | node scripts/ansi-html.js > out.html
//    or: node scripts/ansi-html.js <input.txt> <output.html>
import fs from 'node:fs';

const [inFile, outFile] = process.argv.slice(2);
const src = fs.readFileSync(inFile || 0, 'utf8');
const color = { 1: 'font-weight:700', 2: 'opacity:.6', 31: 'color:#ff7b72', 32: 'color:#7ee787', 33: 'color:#e3b341', 34: 'color:#79c0ff', 35: 'color:#d2a8ff', 36: 'color:#56d4dd', 90: 'color:#8b949e' };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let open = 0;
const body = esc(src).replace(/\x1b\[(\d+)m/g, (_, c) => {
  if (c === '0') { const s = '</span>'.repeat(open); open = 0; return s; }
  open += 1;
  return `<span style="${color[c] || ''}">`;
});
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#0d1117;}
.win{margin:24px;border-radius:10px;background:#161b22;box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden;width:max-content}
.bar{height:30px;background:#21262d;display:flex;align-items:center;gap:8px;padding:0 12px}
.dot{width:12px;height:12px;border-radius:50%}
pre{margin:0;padding:18px 22px 22px;color:#c9d1d9;font:14px/1.45 "SF Mono",Menlo,Consolas,monospace}
.cmd{color:#8b949e}
</style><div class="win"><div class="bar"><span class="dot" style="background:#ff5f56"></span><span class="dot" style="background:#ffbd2e"></span><span class="dot" style="background:#27c93f"></span></div><pre><span class="cmd">$ npx github:thinx-pro/token-blame</span>\n\n${body}</pre></div>`;
if (outFile) fs.writeFileSync(outFile, html); else process.stdout.write(html);
