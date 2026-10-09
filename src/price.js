// List-price a request, on its own model or replayed on another one.
import { promptSize } from './parse.js';

const LEGACY_RATIO = 1.3; // Anthropic: Claude 4.7+ tokenizer yields ~30% more tokens

export function resolveModel(id, prices) {
  if (!id) return null;
  if (prices.models[id]) return id;
  let s = String(id).toLowerCase().replace(/\[.*?\]$/, '').replace(/^(anthropic|openai)\//, '');
  s = s.replace(/[-@]\d{8}$/, '').replace(/\./g, '-');
  if (prices.models[s]) return s;
  if (prices.models['claude-' + s]) return 'claude-' + s; // short names: haiku-5.5, sonnet-5-5
  const keys = Object.keys(prices.models).sort((a, b) => b.length - a.length);
  return keys.find((k) => s.startsWith(k + '-')) || null;
}

const UNIT = { 'claude-2026': 1, 'claude-legacy': 1 / LEGACY_RATIO };

function ratio(fromId, toId, prices) {
  const a = prices.models[fromId]?.tokenizer;
  const b = prices.models[toId]?.tokenizer;
  if (!a || !b || a === b || !UNIT[a] || !UNIT[b]) return 1;
  return UNIT[b] / UNIT[a];
}

// Cost in USD of request r billed at model `target` (defaults to its own model).
// Returns null when the model is not in the price table.
export function cost(r, prices, target) {
  const own = resolveModel(r.model, prices);
  const id = target ? resolveModel(target, prices) : own;
  if (!id) return null;
  const model = prices.models[id];
  const k = own ? ratio(own, id, prices) : 1;
  const tok = {
    uncached: r.uncached * k,
    cacheWrite5m: r.cacheWrite5m * k,
    cacheWrite1h: r.cacheWrite1h * k,
    cacheRead: r.cacheRead * k,
    output: r.output * k,
  };
  const size = promptSize(tok);
  const tier = model.tiers.find((t) => t.upTo == null || size <= t.upTo);
  return (
    tok.uncached * tier.input +
    tok.cacheWrite5m * tier.cacheWrite5m +
    tok.cacheWrite1h * tier.cacheWrite1h +
    tok.cacheRead * tier.cacheRead +
    tok.output * tier.output
  ) / 1e6;
}

export function label(id, prices) {
  const k = resolveModel(id, prices);
  return k ? prices.models[k].label : String(id);
}
