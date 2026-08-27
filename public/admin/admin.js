/*
 * Back-office client: login, stats table, credential change.
 * Talks to /api/admin; the session token lives in localStorage.
 */

'use strict';

// Any load-time error must be visible on screen, never a dead button
window.addEventListener('error', (e) => {
  const box = document.getElementById('login-error');
  if (box) box.textContent = 'PAGE ERROR: ' + (e.message || 'unknown');
});
window.addEventListener('unhandledrejection', (e) => {
  const box = document.getElementById('login-error');
  if (box) box.textContent = 'PAGE ERROR: ' + String(e.reason).slice(0, 150);
});

(() => {
  // Alphabetical, like the portal cards
  const GAMES = ['archer', 'battleship', 'breakout', 'bricks', 'checkers', 'chess', 'connect4', 'dotsboxes', 'flappy', 'frogger', 'invaders', 'mines', 'missiles', 'parcheesi', 'pong', 'snake', 'soccer', 'tanks', 'tetris', 'tictactoe'];
  const el = (id) => document.getElementById(id);
  const TOKEN_KEY = 'arcade_admin_token';

  // Storage can be blocked by privacy settings (strict incognito, Brave,
  // "block all cookies"...): never let that kill the page — the session
  // just won't survive a reload.
  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
  };

  let token = storage.get(TOKEN_KEY) || null;

  async function api(action, extra = {}) {
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, token, ...extra }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined
      });
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, body };
    } catch (err) {
      // Network failure or timeout: surface it instead of doing nothing
      return { ok: false, status: 0, body: { error: 'network', detail: String(err).slice(0, 120) } };
    }
  }

  function describeError(r) {
    if (r.status === 0) return 'NO RESPONSE FROM SERVER: ' + (r.body.detail || 'timeout');
    if (r.body && r.body.detail) return 'SERVER ERROR: ' + r.body.detail;
    return 'SERVER ERROR (' + r.status + ')';
  }

  function show(panel) {
    el('login').classList.toggle('hidden', panel);
    el('panel').classList.toggle('hidden', !panel);
  }

  function renderStats(stats, persistent, backend) {
    el('storage-note').textContent =
      backend === 'postgres' ? 'STORAGE: PERSISTENT (POSTGRES / NEON)'
      : backend === 'redis' ? 'STORAGE: PERSISTENT (REDIS)'
      : 'STORAGE: IN-MEMORY — COUNTERS RESET WHEN THE SERVER RECYCLES';

    const v = (k) => stats[k] || 0;

    // 'stat:lastplay:<game>' holds epoch millis of the last match/solo start
    const fmtWhen = (ms) => {
      if (!ms) return '-';
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
        `${p(d.getHours())}:${p(d.getMinutes())}`;
    };

    let totalCreated = 0, totalPlayed = 0, totalGameVisits = 0;
    let totalSolo = 0, lastAny = 0;
    let html = '<tr><th>GAME</th><th>VISITS</th><th>CREATED</th><th>PLAYED</th><th>SOLO</th><th>LAST PLAYED</th></tr>';
    for (const g of GAMES) {
      const visits = v('stat:visit:' + g);
      const created = v('stat:created:' + g);
      const played = v('stat:played:' + g);
      const solo = v('stat:visit:solo-' + g);
      const last = v('stat:lastplay:' + g);
      totalGameVisits += visits;
      totalCreated += created;
      totalPlayed += played;
      totalSolo += solo;
      lastAny = Math.max(lastAny, last);
      html += `<tr><td>${g.toUpperCase()}</td><td>${visits}</td><td>${created}</td><td>${played}</td><td>${solo}</td><td>${fmtWhen(last)}</td></tr>`;
    }
    html += `<tr class="total"><td>ALL GAMES</td><td>${totalGameVisits}</td><td>${totalCreated}</td><td>${totalPlayed}</td><td>${totalSolo}</td><td>${fmtWhen(lastAny)}</td></tr>`;
    html += `<tr><td>PORTAL</td><td>${v('stat:visit:portal')}</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>`;
    html += `<tr class="total"><td>TOTAL PAGE VIEWS</td><td>${v('stat:visit:total')}</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>`;
    el('stats-table').innerHTML = html;
  }

  async function loadStats() {
    const r = await api('stats');
    if (!r.ok) {
      if (r.status === 401) {
        // Session expired (or the in-memory store recycled): back to login
        token = null;
        storage.del(TOKEN_KEY);
      } else {
        el('login-error').textContent = describeError(r);
      }
      show(false);
      return;
    }
    renderStats(r.body.stats, r.body.persistent, r.body.backend);
    show(true);
  }

  el('btn-login').addEventListener('click', async () => {
    const btn = el('btn-login');
    btn.disabled = true;
    btn.textContent = 'CHECKING...';
    el('login-error').textContent = '';
    const r = await api('login', {
      user: el('login-user').value.trim(),
      pass: el('login-pass').value
    });
    btn.disabled = false;
    btn.textContent = 'ENTER';
    if (!r.ok) {
      el('login-error').textContent =
        r.status === 401 ? 'WRONG USER OR PASSWORD' : describeError(r);
      return;
    }
    token = r.body.token;
    storage.set(TOKEN_KEY, token);
    el('default-warning').textContent = r.body.defaultCreds
      ? 'YOU ARE USING THE DEFAULT admin/admin — CHANGE IT BELOW'
      : '';
    await loadStats();
  });

  el('login-pass').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') el('btn-login').click();
  });

  el('btn-refresh').addEventListener('click', loadStats);

  el('btn-logout').addEventListener('click', async () => {
    await api('logout').catch(() => {});
    token = null;
    storage.del(TOKEN_KEY);
    show(false);
  });

  el('btn-save-creds').addEventListener('click', async () => {
    el('cred-msg').textContent = '';
    const r = await api('change_creds', {
      current: el('cred-current').value,
      newUser: el('cred-user').value.trim(),
      newPass: el('cred-pass').value
    });
    if (!r.ok) {
      el('cred-msg').textContent =
        r.body.error === 'bad_current_password' ? 'CURRENT PASSWORD IS WRONG'
        : r.body.error === 'password_too_short' ? 'NEW PASSWORD: 4+ CHARACTERS'
        : 'COULD NOT SAVE';
      return;
    }
    el('cred-msg').textContent = 'SAVED. USER: ' + r.body.user;
    el('default-warning').textContent = '';
    el('cred-current').value = el('cred-user').value = el('cred-pass').value = '';
  });

  // Auto-login with a stored session
  if (token) loadStats();
  else show(false);
})();
