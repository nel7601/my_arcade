/*
 * PONG (1972) - two phones, one table.
 *
 * Each phone shows its half of the table. Balls are simulated only by
 * the phone they are on; leaving through the top they enter the rival's
 * screen mirrored. Modes: CLASSIC, SHRINK (your paddle shrinks with
 * every hit until you serve again) and GHOST (the ball turns invisible
 * through the middle of your court).
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { PLAY_H, COURT_W, X, Y, S, ctx } = A;

  const PADDLE_W0 = 0.22;
  const PADDLE_H = 0.035;
  const PADDLE_Y = PLAY_H - PADDLE_H;
  const BALL_SIZE = 0.028;
  const BALL_SPEED0 = 0.85;
  const BALL_SPEEDUP = 1.05;
  const BALL_SPEED_MAX = 2.2;
  const BALL_VX_MAX = 0.9;
  const SERVE_DELAY = 1200;
  const MULTIBALL_GAP = 1000;

  let paddleX = 0.5;
  let paddleW = PADDLE_W0;
  let balls = [];
  let servesPending = 0;
  let serveTimer = null;
  let pendingServe = false;
  let lastBallEvent = 0;
  let mode = 0; // 0 classic, 1 shrink, 2 ghost
  let totalBalls = 1;

  // Menu selectors for balls and mode
  let optBalls = 1, optMode = 0;
  for (const attr of ['balls', 'mode']) {
    for (const btn of document.querySelectorAll(`.opt-btn[data-${attr}]`)) {
      btn.addEventListener('click', () => {
        if (attr === 'balls') optBalls = Number(btn.dataset.balls);
        else optMode = Number(btn.dataset.mode);
        for (const b of document.querySelectorAll(`.opt-btn[data-${attr}]`)) {
          b.classList.toggle('sel', b === btn);
        }
      });
    }
  }

  // Exposed on the engine state for the automated tests
  function sync() {
    A.state.balls = balls;
    A.state.servesPending = servesPending;
  }

  function queueServes(count) {
    servesPending += count;
    if (!serveTimer) scheduleNextServe(SERVE_DELAY);
    sync();
  }

  function scheduleNextServe(delay) {
    A.flash('YOU SERVE');
    clearTimeout(serveTimer);
    serveTimer = setTimeout(() => {
      serveTimer = null;
      if (A.state.phase !== 'playing' || servesPending <= 0) return;
      if (A.state.peerAway) {
        pendingServe = true; // wait for the rival to come back
        return;
      }
      paddleW = PADDLE_W0; // SHRINK mode: a serve restores your paddle
      balls.push({
        x: paddleX - BALL_SIZE / 2,
        y: PADDLE_Y - BALL_SIZE - 0.002,
        vx: (Math.random() * 0.6 - 0.3),
        vy: -BALL_SPEED0
      });
      A.sndPaddle();
      lastBallEvent = performance.now();
      servesPending -= 1;
      sync();
      if (servesPending > 0) scheduleNextServe(MULTIBALL_GAP);
    }, delay);
  }

  A.register({
    game: 'pong',
    title: 'PONG',

    getOpts() {
      return { balls: optBalls, mode: optMode };
    },

    onStart(cfg) {
      mode = cfg.opts.mode || 0;
      totalBalls = cfg.opts.balls || 1;
      balls = [];
      servesPending = 0;
      clearTimeout(serveTimer);
      serveTimer = null;
      pendingServe = false;
      paddleX = 0.5;
      paddleW = PADDLE_W0;
      lastBallEvent = performance.now();
      sync();
      if (A.state.role === 'host') {
        queueServes(totalBalls);
      } else {
        A.flash('RIVAL SERVES');
      }
    },

    onResume(cfg) {
      mode = cfg.opts.mode || 0;
      totalBalls = cfg.opts.balls || 1;
      lastBallEvent = performance.now();
      sync();
    },

    onEnd() {
      clearTimeout(serveTimer);
      serveTimer = null;
      balls = [];
      servesPending = 0;
      pendingServe = false;
      sync();
    },

    onPeerBack() {
      if (pendingServe && A.state.phase === 'playing') {
        pendingServe = false;
        scheduleNextServe(SERVE_DELAY);
      }
    },

    onMessage(msg) {
      if (msg.type === 'ball') {
        balls.push({ x: msg.x, y: -BALL_SIZE, vx: msg.vx, vy: msg.vy });
        lastBallEvent = performance.now();
        sync();
      }
    },

    onPointer(phase, x) {
      const half = paddleW / 2;
      paddleX = Math.max(half, Math.min(COURT_W - half, x));
    },

    step(dt, now) {
      const survivors = [];
      for (const b of balls) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;

        if (b.x < 0) {
          b.x = -b.x;
          b.vx = Math.abs(b.vx);
          A.sndWall();
        } else if (b.x + BALL_SIZE > COURT_W) {
          b.x = 2 * (COURT_W - BALL_SIZE) - b.x;
          b.vx = -Math.abs(b.vx);
          A.sndWall();
        }

        if (b.vy > 0 && b.y + BALL_SIZE >= PADDLE_Y && b.y + BALL_SIZE <= PADDLE_Y + PADDLE_H + 0.05) {
          const left = paddleX - paddleW / 2;
          if (b.x + BALL_SIZE >= left && b.x <= left + paddleW) {
            const hit = ((b.x + BALL_SIZE / 2) - paddleX) / (paddleW / 2);
            const speed = Math.min(Math.abs(b.vy) * BALL_SPEEDUP, BALL_SPEED_MAX);
            b.vy = -speed;
            b.vx = hit * BALL_VX_MAX;
            b.y = PADDLE_Y - BALL_SIZE;
            A.sndPaddle();
            if (mode === 1) paddleW = Math.max(0.09, paddleW * 0.88); // SHRINK
          }
        }

        if (b.y + BALL_SIZE < 0) {
          A.send({ type: 'ball', x: COURT_W - b.x - BALL_SIZE, vx: -b.vx, vy: -b.vy });
          lastBallEvent = performance.now();
          continue;
        }

        if (b.y > PLAY_H) {
          A.concede(1);
          lastBallEvent = performance.now();
          queueServes(1); // whoever misses serves that ball again
          continue;
        }

        survivors.push(b);
      }
      balls = survivors;
      sync();

      // Watchdog: if every ball vanished in a disconnect, the host
      // serves a fresh one so the match never stalls forever.
      if (balls.length === 0 && servesPending === 0 && !pendingServe &&
          now - lastBallEvent > 8000) {
        lastBallEvent = now;
        if (A.state.role === 'host') queueServes(1);
      }
    },

    draw() {
      ctx.fillRect(X(paddleX - paddleW / 2), Y(PADDLE_Y), S(paddleW), S(PADDLE_H));
      for (const b of balls) {
        // GHOST mode: the ball is invisible through the middle of the court
        if (mode === 2 && b.y > PLAY_H * 0.3 && b.y < PLAY_H * 0.72) continue;
        ctx.fillRect(X(b.x), Y(b.y), S(BALL_SIZE), S(BALL_SIZE));
      }
    },

    status() {
      if (balls.length === 0 && servesPending === 0) {
        return totalBalls > 1 ? '· BALLS ON RIVAL SIDE ·' : '· BALL ON RIVAL SIDE ·';
      }
      return null;
    }
  });
})();
