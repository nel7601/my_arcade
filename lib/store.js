/*
 * Tiny storage layer for stats, admin credentials and sessions.
 *
 * Backends, picked automatically by environment:
 *  1. Postgres (Neon) — when DATABASE_URL / POSTGRES_URL is set.
 *     Uses Neon's serverless HTTP driver, ideal for Vercel functions.
 *     Everything lives in one key-value table (arcade_kv), created
 *     automatically on first use.
 *  2. Upstash Redis over REST — when KV_REST_API_URL/TOKEN is set.
 *  3. In-memory — fallback: fine locally, but on Vercel counters reset
 *     whenever the function instance is recycled.
 */

const PG_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL || '';
const REDIS_BASE = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';

export const backend = PG_URL ? 'postgres' : (REDIS_BASE && REDIS_TOKEN) ? 'redis' : 'memory';
export const persistent = backend !== 'memory';

// ---- Postgres (Neon) -------------------------------------------------------

let sqlPromise = null;

function getSql() {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      // Test hook: lets the test suite run the exact same statements
      // against an embedded Postgres instead of a real Neon endpoint
      const sql = globalThis.__ARCADE_TEST_SQL ||
        (await import('@neondatabase/serverless')).neon(PG_URL);
      await sql`CREATE TABLE IF NOT EXISTS arcade_kv (
        k   text PRIMARY KEY,
        v   text NOT NULL,
        exp timestamptz
      )`;
      return sql;
    })();
  }
  return sqlPromise;
}

// ---- Upstash Redis over REST ----------------------------------------------

async function redis(...parts) {
  const res = await fetch(`${REDIS_BASE}/${parts.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

// ---- In-memory fallback ----------------------------------------------------

const mem = new Map();     // key -> string value
const memExp = new Map();  // key -> expiry epoch ms

function alive(key) {
  const e = memExp.get(key);
  if (e && Date.now() > e) {
    mem.delete(key);
    memExp.delete(key);
    return false;
  }
  return true;
}

// ---- Public API -------------------------------------------------------------

export async function incr(key, n = 1) {
  if (backend === 'postgres') {
    const sql = await getSql();
    const rows = await sql`
      INSERT INTO arcade_kv (k, v) VALUES (${key}, ${String(n)})
      ON CONFLICT (k) DO UPDATE SET v = ((arcade_kv.v)::bigint + ${n})::text
      RETURNING v`;
    return Number(rows[0].v);
  }
  if (backend === 'redis') return redis('incrby', key, n);
  const v = (alive(key) && Number(mem.get(key)) || 0) + n;
  mem.set(key, String(v));
  return v;
}

export async function get(key) {
  if (backend === 'postgres') {
    const sql = await getSql();
    const rows = await sql`
      SELECT v FROM arcade_kv
      WHERE k = ${key} AND (exp IS NULL OR exp > now())`;
    return rows.length ? rows[0].v : null;
  }
  if (backend === 'redis') return redis('get', key);
  return alive(key) && mem.has(key) ? mem.get(key) : null;
}

export async function set(key, value, exSeconds) {
  if (backend === 'postgres') {
    const sql = await getSql();
    const exp = exSeconds ? new Date(Date.now() + exSeconds * 1000).toISOString() : null;
    await sql`
      INSERT INTO arcade_kv (k, v, exp) VALUES (${key}, ${String(value)}, ${exp})
      ON CONFLICT (k) DO UPDATE SET v = excluded.v, exp = excluded.exp`;
    return 'OK';
  }
  if (backend === 'redis') {
    return exSeconds ? redis('set', key, value, 'EX', exSeconds) : redis('set', key, value);
  }
  mem.set(key, String(value));
  if (exSeconds) memExp.set(key, Date.now() + exSeconds * 1000);
  else memExp.delete(key);
  return 'OK';
}

export async function del(key) {
  if (backend === 'postgres') {
    const sql = await getSql();
    await sql`DELETE FROM arcade_kv WHERE k = ${key}`;
    return;
  }
  if (backend === 'redis') return redis('del', key);
  mem.delete(key);
  memExp.delete(key);
}

// Returns { key: numericValue } for every key matching the prefix
export async function readCounters(prefix) {
  if (backend === 'postgres') {
    const sql = await getSql();
    const rows = await sql`
      SELECT k, v FROM arcade_kv
      WHERE k LIKE ${prefix + '%'} AND (exp IS NULL OR exp > now())`;
    const out = {};
    for (const r of rows) out[r.k] = Number(r.v) || 0;
    return out;
  }
  if (backend === 'redis') {
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
