/*
 * Tiny storage layer for stats, admin credentials and sessions.
 *
 * If an Upstash Redis integration is linked to the Vercel project
 * (KV_REST_API_URL/TOKEN or UPSTASH_REDIS_REST_URL/TOKEN env vars),
 * everything is persistent. Otherwise it falls back to in-memory
 * storage: fine locally, but on Vercel counters reset whenever the
 * function instance is recycled.
 */

const BASE = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

export const persistent = Boolean(BASE && TOKEN);

const mem = new Map();     // key -> string value
const memExp = new Map();  // key -> expiry epoch ms

async function redis(...parts) {
  const res = await fetch(`${BASE}/${parts.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function alive(key) {
  const e = memExp.get(key);
  if (e && Date.now() > e) {
    mem.delete(key);
    memExp.delete(key);
    return false;
  }
  return true;
}

export async function incr(key, n = 1) {
  if (persistent) return redis('incrby', key, n);
  const v = (alive(key) && Number(mem.get(key)) || 0) + n;
  mem.set(key, String(v));
  return v;
}

export async function get(key) {
  if (persistent) return redis('get', key);
  return alive(key) && mem.has(key) ? mem.get(key) : null;
}

export async function set(key, value, exSeconds) {
  if (persistent) {
    return exSeconds ? redis('set', key, value, 'EX', exSeconds) : redis('set', key, value);
  }
  mem.set(key, String(value));
  if (exSeconds) memExp.set(key, Date.now() + exSeconds * 1000);
  else memExp.delete(key);
  return 'OK';
}

export async function del(key) {
  if (persistent) return redis('del', key);
  mem.delete(key);
  memExp.delete(key);
}

// Returns { key: numericValue } for every key matching the prefix
export async function readCounters(prefix) {
  if (persistent) {
    const ks = await redis('keys', prefix + '*');
    if (!ks || !ks.length) return {};
    const vals = await redis('mget', ...ks);
    const out = {};
    ks.forEach((k, i) => { out[k] = Number(vals[i]) || 0; });
    return out;
  }
  const out = {};
  for (const k of mem.keys()) {
    if (alive(k) && k.startsWith(prefix)) out[k] = Number(mem.get(k)) || 0;
  }
  return out;
}
