/*
 * BRICKS - Pong meets Breakout.
 *
 * Pong rules (the ball crosses between the two phones), but each court
 * has its own brick wall across the middle. Every brick of YOURS the
 * ball smashes is a point for the rival; missing the ball past your
 * paddle costs 3. When your wall is gone it rebuilds after a few
 * seconds. Guard your wall!
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { PLAY_H, COURT_W, X, Y, S, ctx } = A;

  const PADDLE_W = 0.22;
  const PADDLE_H = 0.035;
  const PADDLE_Y = PLAY_H - PADDLE_H;
  const BALL_SIZE = 0.028;
  const BALL_SPEED0 = 0.8;
  const BALL_SPEEDUP = 1.04;
  const BALL_SPEED_MAX = 2.0;
  const BALL_VX_MAX = 0.9;
  const SERVE_DELAY = 1200;

  const COLS = 8, ROWS = 3;
  const BRICK_W = COURT_W / COLS;
  const BRICK_H = 0.045;
  const WALL_TOP = 0.52;

  let paddleX = 0.5;
  let ball = null;
  let bricks = [];            // bricks[r][c] = true while alive
  let bricksLeft = 0;
  let rebuildAt = 0;          // timestamp to rebuild an empty wall
  let serveTimer = null;
  let pendingServe = false;
  let lastBallEvent = 0;

  function buildWall() {
    bricks = Array.from({ length: ROWS }, () => Array(COLS).fill(true));
    bricksLeft = ROWS * COLS;
  }

  function queueServe() {
    A.flash('YOU SERVE');
    clearTimeout(serveTimer);
    serveTimer = setTimeout(() => {
      serveTimer = null;
      if (A.state.phase !== 'playing') return;
      if (A.state.peerAway) {
        pendingServe = true;
        return;
      }
      ball = {
        x: paddleX - BALL_SIZE / 2,
        y: PADDLE_Y - BALL_SIZE - 0.002,
        vx: (Math.random() * 0.6 - 0.3),
        vy: -BALL_SPEED0
      };
      A.sndPaddle();
      lastBallEvent = performance.now();
    }, SERVE_DELAY);
  }

  A.register({
    game: 'bricks',
    title: 'BRICKS',

    onStart() {
      ball = null;
      buildWall();
      rebuildAt = 0;
      clearTimeout(serveTimer);
      serveTimer = null;
      pendingServe = false;
      paddleX = 0.5;
      lastBallEvent = performance.now();
      if (A.state.role === 'host') queueServe();
      else A.flash('RIVAL SERVES');
    },

    onResume() {
      buildWall(); // fresh wall after a reload; score is what matters
      lastBallEvent = performance.now();
    },

    onEnd() {
      clearTimeout(serveTimer);
      serveTimer = null;
      ball = null;
      pendingServe = false;
    },

    onPeerBack() {
      if (pendingServe && A.state.phase === 'playing') {
        pendingServe = false;
        queueServe();
      }
    },

    onMessage(msg) {
      if (msg.type === 'ball') {
        ball = { x: msg.x, y: -BALL_SIZE, vx: msg.vx, vy: msg.vy };
        lastBallEvent = performance.now();
      }
    },

    onPointer(phase, x) {
      const half = PADDLE_W / 2;
      paddleX = Math.max(half, Math.min(COURT_W - half, x));
    },

    step(dt, now) {
      // Rebuild an empty wall after a short truce
      if (bricksLeft === 0 && rebuildAt && now > rebuildAt) {
        buildWall();
        rebuildAt = 0;
      }

      const b = ball;
      if (b) {
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

        // Brick collisions: each brick of mine smashed = rival point
        const cy = b.y + BALL_SIZE / 2;
        if (cy > WALL_TOP && cy < WALL_TOP + ROWS * BRICK_H && bricksLeft > 0) {
          const r = Math.floor((cy - WALL_TOP) / BRICK_H);
          const c = Math.floor((b.x + BALL_SIZE / 2) / BRICK_W);
          if (r >= 0 && r < ROWS && c >= 0 && c < COLS && bricks[r][c]) {
            bricks[r][c] = false;
            bricksLeft -= 1;
            if (bricksLeft === 0) rebuildAt = now + 4000;
            b.vy = -b.vy;
            A.sndWall();
            A.concede(1);
            lastBallEvent = performance.now();
          }
        }

        if (b.vy > 0 && b.y + BALL_SIZE >= PADDLE_Y && b.y + BALL_SIZE <= PADDLE_Y + PADDLE_H + 0.05) {
          const left = paddleX - PADDLE_W / 2;
          if (b.x + BALL_SIZE >= left && b.x <= left + PADDLE_W) {
            const hit = ((b.x + BALL_SIZE / 2) - paddleX) / (PADDLE_W / 2);
            const speed = Math.min(Math.abs(b.vy) * BALL_SPEEDUP, BALL_SPEED_MAX);
            b.vy = -speed;
            b.vx = hit * BALL_VX_MAX;
            b.y = PADDLE_Y - BALL_SIZE;
            A.sndPaddle();
          }
        }

        if (b.y + BALL_SIZE < 0) {
          A.send({ type: 'ball', x: COURT_W - b.x - BALL_SIZE, vx: -b.vx, vy: -b.vy });
          ball = null;
          lastBallEvent = performance.now();
        } else if (b.y > PLAY_H) {
          ball = null;
          A.concede(3); // missing the ball hurts more than losing a brick
          lastBallEvent = performance.now();
          queueServe();
        }
      }

      // Watchdog: recover a ball lost in a disconnect
      if (!ball && !serveTimer && !pendingServe && now - lastBallEvent > 8000) {
        lastBallEvent = now;
        if (A.state.role === 'host') queueServe();
      }
    },

    draw() {
      ctx.fillRect(X(paddleX - PADDLE_W / 2), Y(PADDLE_Y), S(PADDLE_W), S(PADDLE_H));
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (bricks[r][c]) {
            ctx.fillRect(X(c * BRICK_W) + 1, Y(WALL_TOP + r * BRICK_H) + 1,
              S(BRICK_W) - 2, S(BRICK_H) - 2);
          }
        }
      }
      if (ball) ctx.fillRect(X(ball.x), Y(ball.y), S(BALL_SIZE), S(BALL_SIZE));
    },

    status() {
      if (!ball && !serveTimer) return '· BALL ON RIVAL SIDE ·';
      return null;
    }
  });
})();
