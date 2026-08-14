/*
 * MY ARCADE - shared client engine
 *
 * Everything every game needs: rooms over WebSocket (create / join by
 * link / resume after any disconnect), the shared match clock with the
 * host as referee, pause while a player is away, score sync, the retro
 * frame (walls, dashed line, info zone), red urgency mode, and the
 * end-of-match scenes (confetti / pixel sad face).
 *
 * A game registers itself with Arcade.register({...hooks}) and only
 * implements its own physics, drawing, input and messages.
 *
 * Court coordinates: x in [0,1], y in [0,1.6]. The top 4/5 is the play
 * area; the bottom fifth is the info zone behind the dashed line.
 */

'use strict';

window.Arcade = (() => {

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  const COURT_W = 1;
  const COURT_H = 1.6;
  const PLAY_H = COURT_H * 4 / 5;

  // ?t=SECONDS overrides the match length — handy for testing
  const TEST_SECONDS = Number(new URLSearchParams(location.search).get('t')) || 0;
  const URGENT_AT = 30;
  const URGENT_COLOR = '#ff2222';
  const CONFETTI_COLORS = ['#ff4040', '#ffd700', '#40c4ff', '#7cfc00', '#ff80ff', '#ffa500'];

  let GAME = null; // the registered game definition

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const state = {
    phase: 'menu',            // menu | joining | waiting | playing | over
    role: null,               // host | guest
    ws: null,

    code: null,
    token: null,
    shareUrl: null,
    resuming: false,
    reconnectTries: 0,
    reconnectTimer: null,
    peerAway: false,
    quitTimer: null,
    serveMsg: null,           // {text, until} flash message in the info zone

    config: { seconds: 240, game: '', opts: {} },
    optMinutes: 4,

    score: { me: 0, opp: 0 },
    myRematch: false,
    theirRematch: false,

    timeLeft: null,
    timeUpSent: false,
    lastClockSent: 0,
    result: null              // {won, tie, confetti[], lastNow}
  };

  // ---- Session persistence (survive reloads / killed browser) -------------

  const sessionKey = () => 'arcade_resume_' + (GAME ? GAME.game : '');

  function saveSession() {
    try {
      localStorage.setItem(sessionKey(),
        JSON.stringify({ code: state.code, token: state.token, ts: Date.now() }));
    } catch { /* private mode */ }
  }

  function clearSession() {
    try { localStorage.removeItem(sessionKey()); } catch { /* ignore */ }
  }

  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(sessionKey()));
      if (s && s.code && s.token && Date.now() - s.ts < 12 * 60 * 1000) return s;
    } catch { /* ignore */ }
    return null;
  }

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const el = (id) => document.getElementById(id);
  const screens = {};

  function showScreen(name) {
    for (const key of Object.keys(screens)) {
      screens[key].classList.toggle('hidden', key !== name);
    }
    if (!name) {
      for (const key of Object.keys(screens)) screens[key].classList.add('hidden');
    }
  }

  function setQuitVisible(visible) {
    const btn = el('btn-quit');
    btn.classList.toggle('hidden', !visible);
    btn.classList.remove('confirm');
    btn.textContent = 'QUIT';
    clearTimeout(state.quitTimer);
  }

  // -------------------------------------------------------------------------
  // Sound (original Pong frequencies)
  // -------------------------------------------------------------------------

  let audioCtx = null;

  function beep(freq, duration) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration);
    } catch { /* no audio is fine */ }
  }

  const sndWall = () => beep(226, 0.04);
  const sndPaddle = () => beep(459, 0.05);
  const sndScore = () => beep(490, 0.25);

  // -------------------------------------------------------------------------
  // Networking
  // -------------------------------------------------------------------------

  function connect(onOpen) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    state.ws = ws;

    ws.onopen = onOpen;
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    };
    ws.onclose = () => {
      state.ws = null;
      if (state.phase === 'menu') return;

      if (!state.token) {
        backToMenu();
        el('menu-error').textContent = 'NO CONNECTION. TRY AGAIN';
        return;
      }

      // Phones drop the socket whenever the app goes to the background:
      // keep trying to resume for as long as the server holds the seat.
      state.reconnectTries += 1;
      if (state.reconnectTries > 240) {
        clearSession();
        backToMenu();
        el('menu-error').textContent = 'NO CONNECTION. TRY AGAIN';
        return;
      }
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(tryResume, state.reconnectTries === 1 ? 150 : 2500);
    };
  }

  function tryResume() {
    if (state.phase === 'menu' || !state.token || !state.code) return;
    if (state.ws && state.ws.readyState <= WebSocket.OPEN) return;
    state.resuming = true;
    connect(() => sendMsg({ type: 'resume', code: state.code, token: state.token }));
  }

  function sendMsg(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg));
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'created': {
        state.code = msg.code;
        state.token = msg.token;
        saveSession();
        const url = `${location.origin}${location.pathname}?j=${msg.code}`;
        state.shareUrl = url;
        el('share-url').textContent = url;
        el('copy-done').textContent = '';
        el('btn-share').classList.toggle('hidden', !navigator.share);
        state.phase = 'waiting';
        showScreen('waiting');
        break;
      }

      case 'error': {
        const wasResuming = state.resuming;
        clearSession();
        backToMenu();
        el('menu-error').textContent =
          wasResuming ? 'THE GAME WAS LOST. CREATE A NEW ONE'
          : msg.reason === 'full' ? 'THAT GAME IS ALREADY FULL'
          : 'GAME NOT FOUND. ASK FOR A NEW LINK';
        break;
      }

      case 'start':
        state.role = msg.role;
        if (msg.code) state.code = msg.code;
        if (msg.token) state.token = msg.token;
        if (msg.config) state.config = msg.config;
        saveSession();
        startMatch();
        break;

      case 'resumed':
        state.resuming = false;
        state.reconnectTries = 0;
        state.role = msg.role;
        if (msg.config) state.config = msg.config;
        saveSession();
        if (state.phase === 'over') break;
        if (msg.started) {
          if (msg.score) {
            state.score.me = msg.score.you;
            state.score.opp = msg.score.rival;
          }
          const wasPlaying = state.phase === 'playing';
          state.phase = 'playing';
          el('btn-rematch').classList.remove('hidden');
          showScreen(null);
          setQuitVisible(true);
          keepAwake();
          if (!wasPlaying && GAME.onResume) GAME.onResume(state.config);
          // A 'start' queued while we were away arrives right after this
          // and re-runs onStart by itself.
        } else if (state.phase === 'waiting' || state.phase === 'joining') {
          state.shareUrl = `${location.origin}${location.pathname}?j=${state.code}`;
          el('share-url').textContent = state.shareUrl;
          el('btn-share').classList.toggle('hidden', !navigator.share);
          state.phase = 'waiting';
          showScreen('waiting');
        }
        break;

      case 'peer_away':
        state.peerAway = true;
        break;

      case 'peer_back':
        state.peerAway = false;
        if (state.phase === 'playing' && state.timeLeft !== null) {
          sendMsg({ type: 'clock', t: state.timeLeft });
        }
        if (GAME.onPeerBack) GAME.onPeerBack();
        break;

      case 'clock':
        if (typeof msg.t === 'number' &&
            (state.timeLeft === null || Math.abs(state.timeLeft - msg.t) > 2)) {
          state.timeLeft = msg.t;
        }
        break;

      case 'score':
        // Self-scoring games: the sender reports its OWN new score
        state.score.opp = Number(msg.mine) || 0;
        break;

      case 'goal':
        // Concede-style games (pong): the sender conceded, we scored
        state.score.me = msg.scorer;
        state.score.opp = msg.conceder;
        sndScore();
        break;

      case 'time_up':
        state.score.me = msg.theirs;
        state.score.opp = msg.mine;
        endByTime();
        break;

      case 'rematch':
        state.theirRematch = true;
        tryRematch();
        break;

      case 'peer_left':
        clearSession();
        if (state.phase === 'playing' || state.phase === 'over') {
          endGame('RIVAL DISCONNECTED', 'Your rival left the game.');
          el('btn-rematch').classList.add('hidden');
        } else if (state.phase === 'waiting' || state.phase === 'joining') {
          backToMenu();
        }
        break;

      default:
        if (GAME.onMessage) GAME.onMessage(msg);
    }
  }

  // -------------------------------------------------------------------------
  // Match flow
  // -------------------------------------------------------------------------

  function startMatch() {
    state.phase = 'playing';
    state.score = { me: 0, opp: 0 };
    state.myRematch = false;
    state.theirRematch = false;
    state.timeLeft = state.config.seconds;
    state.timeUpSent = false;
    state.result = null;
    state.serveMsg = null;
    el('over').classList.remove('result');
    saveSession();
    el('btn-rematch').classList.remove('hidden');
    showScreen(null);
    setQuitVisible(true);
    keepAwake();
    GAME.onStart(state.config);
  }

  function flash(text) {
    state.serveMsg = { text, until: performance.now() + 1100 };
  }

  // Self-scoring games (races, duels): report my own new total
  function addScore(n) {
    state.score.me += n;
    sendMsg({ type: 'score', mine: state.score.me });
  }

  // Concede-style games (pong): my mistake gives the rival points
  function concede(n) {
    state.score.opp += n;
    sndScore();
    sendMsg({ type: 'goal', scorer: state.score.opp, conceder: state.score.me });
  }

  function endByTime() {
    setQuitVisible(false);
    clearSession();
    state.phase = 'over';
    state.timeLeft = 0;
    const tie = state.score.me === state.score.opp;
    const won = state.score.me > state.score.opp;
    state.result = {
      won,
      tie,
      lastNow: performance.now(),
      confetti: won ? Array.from({ length: 90 }, () => ({
        x: Math.random(),
        y: -Math.random() * PLAY_H,
        vx: (Math.random() - 0.5) * 0.25,
        vy: 0.25 + Math.random() * 0.55,
        size: 0.01 + Math.random() * 0.012,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        wobble: Math.random() * Math.PI * 2
      })) : null
    };
    sndScore();
    if (GAME.onEnd) GAME.onEnd();
    el('over-title').textContent = '';
    el('over-detail').textContent = '';
    el('btn-rematch').textContent = 'REMATCH';
    el('over').classList.add('result');
    showScreen('over');
  }

  function endGame(title, detail) {
    setQuitVisible(false);
    clearSession();
    state.phase = 'over';
    state.result = null;
    if (GAME.onEnd) GAME.onEnd();
    el('over').classList.remove('result');
    el('over-title').textContent = title;
    el('over-detail').textContent = detail;
    el('btn-rematch').textContent = 'REMATCH';
    showScreen('over');
  }

  function tryRematch() {
    if (state.myRematch && state.theirRematch) {
      startMatch();
    } else if (state.myRematch) {
      el('btn-rematch').textContent = 'WAITING...';
    }
  }

  function backToMenu() {
    clearTimeout(state.reconnectTimer);
    setQuitVisible(false);
    clearSession();
    if (state.ws) {
      state.ws.onclose = null;
      sendMsg({ type: 'leave' });
      state.ws.close();
      state.ws = null;
    }
    state.phase = 'menu';
    state.code = null;
    state.token = null;
    state.resuming = false;
    state.reconnectTries = 0;
    state.peerAway = false;
    state.result = null;
    state.timeLeft = null;
    if (GAME.onEnd) GAME.onEnd();
    el('over').classList.remove('result');
    el('menu-error').textContent = '';
    showScreen('menu');
  }

  // -------------------------------------------------------------------------
  // Retro drawing helpers
  // -------------------------------------------------------------------------

  const DIGITS = {
    0: ['111', '101', '101', '101', '111'],
    1: ['010', '110', '010', '010', '111'],
    2: ['111', '001', '111', '100', '111'],
    3: ['111', '001', '111', '001', '111'],
    4: ['101', '101', '111', '001', '001'],
    5: ['111', '100', '111', '001', '111'],
    6: ['111', '100', '111', '101', '111'],
    7: ['111', '001', '001', '001', '001'],
    8: ['111', '101', '111', '101', '111'],
    9: ['111', '101', '111', '001', '111']
  };

  function drawNumber(n, cx, top, px) {
    const digits = String(n).split('');
    const digitW = 3 * px, gap = px;
    const totalW = digits.length * digitW + (digits.length - 1) * gap;
    let x = cx - totalW / 2;
    for (const d of digits) {
      const rows = DIGITS[d];
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 3; c++) {
          if (rows[r][c] === '1') {
            ctx.fillRect(Math.round(x + c * px), Math.round(top + r * px), Math.ceil(px), Math.ceil(px));
          }
        }
      }
      x += digitW + gap;
    }
  }

  function drawTimer(seconds, cx, top, px) {
    const s = Math.max(0, Math.ceil(seconds));
    const mm = Math.floor(s / 60);
    const ss = String(s % 60).padStart(2, '0');
    const totalW = (3 + 1 + 1 + 1 + 3 + 1 + 3) * px;
    let x = cx - totalW / 2;
    drawNumber(mm, x + 1.5 * px, top, px);
    x += 4 * px;
    ctx.fillRect(Math.round(x), Math.round(top + px), Math.ceil(px), Math.ceil(px));
    ctx.fillRect(Math.round(x), Math.round(top + 3 * px), Math.ceil(px), Math.ceil(px));
    x += 2 * px;
    drawNumber(Number(ss[0]), x + 1.5 * px, top, px);
    x += 4 * px;
    drawNumber(Number(ss[1]), x + 1.5 * px, top, px);
  }

  const SAD_FACE = [
    '...#####...',
    '..#.....#..',
    '.#.......#.',
    '#..#...#..#',
    '#..#...#..#',
    '#.........#',
    '#...###...#',
    '#..#...#..#',
    '.#.......#.',
    '..#.....#..',
    '...#####...'
  ];

  function drawBitmap(rows, cx, top, px) {
    const w = rows[0].length * px;
    const x0 = cx - w / 2;
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        if (rows[r][c] === '#') {
          ctx.fillRect(Math.round(x0 + c * px), Math.round(top + r * px), Math.ceil(px), Math.ceil(px));
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // View / render
  // -------------------------------------------------------------------------

  let view = { scale: 1, ox: 0, oy: 0 };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    const scale = Math.min(canvas.width / COURT_W, canvas.height / COURT_H);
    view = {
      scale,
      ox: (canvas.width - COURT_W * scale) / 2,
      oy: (canvas.height - COURT_H * scale) / 2
    };
  }

  const X = (u) => view.ox + u * view.scale;
  const Y = (u) => view.oy + u * view.scale;
  const S = (u) => u * view.scale;

  function drawResult(now) {
    const res = state.result;
    const dt = Math.min((now - res.lastNow) / 1000, 0.05);
    res.lastNow = now;

    ctx.textAlign = 'center';
    if (res.tie) {
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(S(0.1))}px "Courier New", monospace`;
      ctx.fillText('DRAW', X(0.5), Y(PLAY_H / 2));
    } else if (res.won) {
      for (const p of res.confetti) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.wobble += dt * 6;
        if (p.y > PLAY_H) {
          p.y = -0.05;
          p.x = Math.random();
        }
        if (p.y < 0) continue;
        ctx.fillStyle = p.color;
        const w = p.size * (0.6 + 0.4 * Math.abs(Math.sin(p.wobble)));
        ctx.fillRect(X(p.x), Y(p.y), S(w), S(p.size));
      }
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(S(0.11))}px "Courier New", monospace`;
      ctx.fillText('WINNER', X(0.5), Y(PLAY_H / 2));
    } else {
      ctx.fillStyle = '#fff';
      drawBitmap(SAD_FACE, X(0.5), Y(0.28), S(0.032));
      ctx.font = `bold ${Math.round(S(0.09))}px "Courier New", monospace`;
      ctx.fillText('YOU LOST', X(0.5), Y(0.95));
    }
  }

  function render(now) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const active = state.phase === 'playing';
    const ended = state.phase === 'over' && state.result;
    if (!active && !ended) return;

    const urgent = active && state.timeLeft !== null && state.timeLeft < URGENT_AT;
    const color = urgent ? URGENT_COLOR : '#fff';
    ctx.fillStyle = color;

    // Side walls + the dashed boundary of the info zone
    ctx.fillRect(X(0) - S(0.008), Y(0), S(0.008), S(PLAY_H));
    ctx.fillRect(X(COURT_W), Y(0), S(0.008), S(PLAY_H));
    const dashW = S(0.03);
    for (let x = 0; x < COURT_W; x += 0.06) {
      ctx.fillRect(X(x), Y(PLAY_H), dashW, S(0.008));
    }

    if (active) {
      GAME.draw(now, color);
      ctx.fillStyle = color; // the game may have changed it
    }

    // Info zone: score in the corners, clock in the middle
    ctx.font = `${Math.round(S(0.028))}px "Courier New", monospace`;
    ctx.textAlign = 'center';
    ctx.globalAlpha = 0.7;
    ctx.fillText('YOU', X(0.12), Y(PLAY_H + 0.06));
    ctx.fillText('TIME', X(0.5), Y(PLAY_H + 0.06));
    ctx.fillText('RIVAL', X(0.88), Y(PLAY_H + 0.06));
    ctx.globalAlpha = 1;
    drawNumber(state.score.me, X(0.12), Y(PLAY_H + 0.09), S(0.02));
    drawNumber(state.score.opp, X(0.88), Y(PLAY_H + 0.09), S(0.02));
    if (state.timeLeft !== null) {
      drawTimer(state.timeLeft, X(0.5), Y(PLAY_H + 0.09), S(0.02));
    }

    if (ended) {
      drawResult(now);
      return;
    }

    // Status line
    const blinkOn = Math.floor(now / 500) % 2 === 0;
    const statusY = Y(PLAY_H + 0.27);
    if (state.serveMsg && now > state.serveMsg.until) state.serveMsg = null;
    ctx.font = `${Math.round(S(0.033))}px "Courier New", monospace`;
    if (state.resuming || !state.ws) {
      if (blinkOn) ctx.fillText('RECONNECTING...', X(0.5), statusY);
    } else if (state.peerAway) {
      if (blinkOn) ctx.fillText('HOLD ON: YOUR RIVAL IS COMING BACK', X(0.5), statusY);
    } else if (state.serveMsg) {
      ctx.font = `bold ${Math.round(S(0.04))}px "Courier New", monospace`;
      ctx.fillText(state.serveMsg.text, X(0.5), statusY);
    } else {
      const txt = GAME.status ? GAME.status() : null;
      if (txt && blinkOn) ctx.fillText(txt, X(0.5), statusY);
    }
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------

  let lastTime = 0;

  function loop(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    const running = state.phase === 'playing' && !state.peerAway && !state.resuming;

    if (running) {
      GAME.step(dt, now);

      if (state.timeLeft !== null) {
        state.timeLeft = Math.max(0, state.timeLeft - dt);
        // The host is the referee: shares its clock and blows the whistle
        if (state.role === 'host') {
          if (now - state.lastClockSent > 5000) {
            state.lastClockSent = now;
            sendMsg({ type: 'clock', t: state.timeLeft });
          }
          if (state.timeLeft <= 0 && !state.timeUpSent) {
            state.timeUpSent = true;
            sendMsg({ type: 'time_up', mine: state.score.me, theirs: state.score.opp });
            endByTime();
          }
        }
      }
    }

    render(now);
    requestAnimationFrame(loop);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  function toCourt(clientX, clientY) {
    const dpr = window.devicePixelRatio || 1;
    return [
      (clientX * dpr - view.ox) / view.scale,
      (clientY * dpr - view.oy) / view.scale
    ];
  }

  function firePointer(phase, clientX, clientY) {
    // Unlock audio on the first gesture (needed when arriving via link)
    if (!audioCtx) beep(0.01, 0.01);
    else if (audioCtx.state === 'suspended') audioCtx.resume();
    if (GAME.onPointer) {
      const [u, v] = toCourt(clientX, clientY);
      GAME.onPointer(phase, u, v);
    }
  }

  canvas.addEventListener('touchstart', (ev) => {
    ev.preventDefault();
    firePointer('down', ev.touches[0].clientX, ev.touches[0].clientY);
  }, { passive: false });
  canvas.addEventListener('touchmove', (ev) => {
    ev.preventDefault();
    firePointer('move', ev.touches[0].clientX, ev.touches[0].clientY);
  }, { passive: false });
  canvas.addEventListener('touchend', (ev) => {
    ev.preventDefault();
    const t = ev.changedTouches[0];
    firePointer('up', t.clientX, t.clientY);
  }, { passive: false });
  canvas.addEventListener('mousedown', (ev) => firePointer('down', ev.clientX, ev.clientY));
  canvas.addEventListener('mousemove', (ev) => { if (ev.buttons) firePointer('move', ev.clientX, ev.clientY); });
  canvas.addEventListener('mouseup', (ev) => firePointer('up', ev.clientX, ev.clientY));

  async function keepAwake() {
    try {
      if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
    } catch { /* optional */ }
  }

  // -------------------------------------------------------------------------
  // UI wiring + startup (runs when a game registers)
  // -------------------------------------------------------------------------

  function bindUI() {
    screens.menu = el('menu');
    screens.waiting = el('waiting');
    screens.joining = el('joining');
    screens.over = el('over');

    for (const btn of document.querySelectorAll('.opt-btn[data-min]')) {
      btn.addEventListener('click', () => {
        state.optMinutes = Number(btn.dataset.min);
        for (const b of document.querySelectorAll('.opt-btn[data-min]')) {
          b.classList.toggle('sel', b === btn);
        }
      });
      if (btn.classList.contains('sel')) state.optMinutes = Number(btn.dataset.min);
    }

    el('btn-create').addEventListener('click', () => {
      beep(459, 0.03);
      el('menu-error').textContent = '';
      connect(() => sendMsg({
        type: 'create',
        game: GAME.game,
        seconds: TEST_SECONDS || state.optMinutes * 60,
        opts: GAME.getOpts ? GAME.getOpts() : {}
      }));
    });

    el('btn-share').addEventListener('click', async () => {
      try {
        await navigator.share({ title: GAME.title || 'MY ARCADE', text: 'Play with me:', url: state.shareUrl });
      } catch { /* share sheet closed */ }
    });

    el('btn-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.shareUrl);
        el('copy-done').textContent = 'COPIED';
      } catch {
        el('copy-done').textContent = 'COPY FAILED, DO IT BY HAND';
      }
      setTimeout(() => { el('copy-done').textContent = ''; }, 2000);
    });

    el('btn-cancel').addEventListener('click', backToMenu);
    el('btn-exit').addEventListener('click', backToMenu);

    el('btn-rematch').addEventListener('click', () => {
      state.myRematch = true;
      sendMsg({ type: 'rematch' });
      tryRematch();
    });

    el('btn-quit').addEventListener('click', () => {
      const btn = el('btn-quit');
      if (!btn.classList.contains('confirm')) {
        btn.classList.add('confirm');
        btn.textContent = 'SURE?';
        clearTimeout(state.quitTimer);
        state.quitTimer = setTimeout(() => {
          btn.classList.remove('confirm');
          btn.textContent = 'QUIT';
        }, 2000);
        return;
      }
      backToMenu();
    });
  }

  function startup() {
    window.addEventListener('resize', resize);
    resize();

    // Count the page view for the back-office stats (fire-and-forget)
    fetch('/api/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: GAME.game })
    }).catch(() => {});

    const joinCode = new URLSearchParams(location.search).get('j');
    const savedSession = loadSession();
    if (joinCode) {
      history.replaceState(null, '', location.pathname);
      clearSession();
      state.phase = 'joining';
      showScreen('joining');
      connect(() => sendMsg({ type: 'join', code: joinCode, game: GAME.game }));
    } else if (savedSession) {
      state.code = savedSession.code;
      state.token = savedSession.token;
      state.phase = 'joining';
      showScreen('joining');
      state.resuming = true;
      connect(() => sendMsg({ type: 'resume', code: state.code, token: state.token }));
    }

    function reconnectIfNeeded() {
      if (state.token && state.phase !== 'menu' &&
          (!state.ws || state.ws.readyState > WebSocket.OPEN)) {
        clearTimeout(state.reconnectTimer);
        tryResume();
      }
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reconnectIfNeeded();
    });
    window.addEventListener('pageshow', reconnectIfNeeded);

    setInterval(() => {
      if (state.token && (state.phase === 'playing' || state.phase === 'waiting')) {
        saveSession();
      }
    }, 20000);

    requestAnimationFrame((t) => { lastTime = t; requestAnimationFrame(loop); });
  }

  function register(def) {
    GAME = def;
    bindUI();
    startup();
    // Exposed for automated tests; not part of the game logic
    window.__arcade = state;
    window.__pong = state;
  }

  return {
    register,
    state,
    send: sendMsg,
    addScore,
    concede,
    flash,
    beep, sndWall, sndPaddle, sndScore,
    drawNumber, drawTimer, drawBitmap, SAD_FACE,
    COURT_W, COURT_H, PLAY_H,
    X, Y, S,
    ctx
  };
})();
