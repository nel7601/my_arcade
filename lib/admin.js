/*
 * Back-office core: login, sessions, stats and credential changes.
 * Shared by api/admin.js (Vercel) and server.js (local/VPS).
 *
 * Default credentials are admin/admin until they are changed from the
 * back office itself. Credentials are stored salted+hashed; sessions
 * are random tokens with a 24h TTL.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as store from './store.js';

const CRED_KEY = 'admin:creds';
const SESS_PREFIX = 'admin:sess:';
const SESSION_TTL = 24 * 3600;

const hashPass = (salt, pass) =>
  createHash('sha256').update(salt + ':' + pass).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

async function getCreds() {
  try {
    const raw = await store.get(CRED_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* fall through to defaults */ }
  return null; // defaults apply: admin/admin
}

async function verify(user, pass) {
  const creds = await getCreds();
  if (!creds) {
    return safeEqual(user, 'admin') && safeEqual(pass, 'admin');
  }
  return safeEqual(user, creds.user) && safeEqual(hashPass(creds.salt, pass), creds.hash);
}

async function requireSession(token) {
  if (!token || typeof token !== 'string' || token.length > 64) return false;
  return Boolean(await store.get(SESS_PREFIX + token));
}

export async function handleAdmin(body) {
  const action = body && body.action;

  if (action === 'login') {
    if (await verify(String(body.user || ''), String(body.pass || ''))) {
      const token = randomBytes(24).toString('hex');
      await store.set(SESS_PREFIX + token, '1', SESSION_TTL);
      const creds = await getCreds();
      return {
        status: 200,
        body: { token, persistent: store.persistent, backend: store.backend, defaultCreds: !creds }
      };
    }
    return { status: 401, body: { error: 'bad_credentials' } };
  }

  // Everything else needs a valid session
  if (!(await requireSession(body && body.token))) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  switch (action) {
    case 'stats': {
      const counters = await store.readCounters('stat:');
      return {
        status: 200,
        body: { stats: counters, persistent: store.persistent, backend: store.backend }
      };
    }

    case 'change_creds': {
      const current = String(body.current || '');
      const creds = await getCreds();
      const currentUser = creds ? creds.user : 'admin';
      if (!(await verify(currentUser, current))) {
        return { status: 401, body: { error: 'bad_current_password' } };
      }
      const newUser = String(body.newUser || currentUser).trim() || currentUser;
      const newPass = String(body.newPass || '');
      if (newPass.length < 4) {
        return { status: 400, body: { error: 'password_too_short' } };
      }
      const salt = randomBytes(8).toString('hex');
      await store.set(CRED_KEY, JSON.stringify({
        user: newUser,
        salt,
        hash: hashPass(salt, newPass)
      }));
      return { status: 200, body: { ok: true, user: newUser } };
    }

    case 'logout': {
      await store.del(SESS_PREFIX + body.token);
      return { status: 200, body: { ok: true } };
    }

    default:
      return { status: 400, body: { error: 'unknown_action' } };
  }
}

// Shared by api/track.js and server.js: count a page view
export async function trackVisit(page) {
  const p = /^[a-z0-9_-]{1,20}$/.test(String(page)) ? String(page) : 'other';
  await Promise.all([
    store.incr('stat:visit:total'),
    store.incr('stat:visit:' + p)
  ]);
}
