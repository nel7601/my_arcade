/*
 * Back-office client: login, stats table, credential change.
 * Talks to /api/admin; the session token lives in localStorage.
 */

'use strict';

(() => {
  const GAMES = ['pong', 'bricks', 'snake', 'breakout', 'invaders', 'missiles', 'frogger', 'tetris'];
  const el = (id) => document.getElementById(id);
  const TOKEN_KEY = 'arcade_admin_token';

  let token = localStorage.getItem(TOKEN_KEY) || null;

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
    let totalCreated = 0, totalPlayed = 0, totalGameVisits = 0;

    let html = '<tr><th>GAME</th><th>VISITS</th><th>CREATED</th><th>PLAYED</th></tr>';
    for (const g of GAMES) {
      const visits = v('stat:visit:' + g);
      const created = v('stat:created:' + g);
      const played = v('stat:played:' + g);
      totalGameVisits += visits;
      totalCreated += created;
      totalPlayed += played;
      html += `<tr><td>${g.toUpperCase()}</td><td>${visits}</td><td>${created}</td><td>${played}</td></tr>`;
    }
    html += `<tr class="total"><td>ALL GAMES</td><td>${totalGameVisits}</td><td>${totalCreated}</td><td>${totalPlayed}</td></tr>`;
    html += `<tr><td>PORTAL</td><td>${v('stat:visit:portal')}</td><td>-</td><td>-</td></tr>`;
    html += `<tr class="total"><td>TOTAL PAGE VIEWS</td><td>${v('stat:visit:total')}</td><td>-</td><td>-</td></tr>`;
    el('stats-table').innerHTML = html;
  }

  async function loadStats() {
    const r = await api('stats');
    if (!r.ok) {
      if (r.status === 401) {
        // Session expired (or the in-memory store recycled): back to login
        token = null;
        localStorage.removeItem(TOKEN_KEY);
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
    localStorage.setItem(TOKEN_KEY, token);
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
    localStorage.removeItem(TOKEN_KEY);
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
