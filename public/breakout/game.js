/*
 * BREAKOUT (1976) - brick race.
 *
 * Both phones get the same wall. Every brick is a point; whoever has
 * smashed more when the clock runs out wins. Clearing the wall builds
 * a fresh one and speeds the ball up. Losing the ball just costs time.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { PLAY_H, COURT_W, X, Y, S, ctx } = A;

  const PADDLE_W = 0.24;
  const PADDLE_H = 0.035;
  const PADDLE_Y = PLAY_H - PADDLE_H;
  const BALL_SIZE = 0.026;
  const BALL_VX_MAX = 0.85;
  const COLS = 8, ROWS = 6;
  const BRICK_W = COURT_W / COLS;
  const BRICK_H = 0.05;
  const WALL_TOP = 0.1;

  let paddleX = 0.5;
  let ball = null;
  let bricks = [];
  let bricksLeft = 0;
  let ballSpeed = 0.8;
  let serveAt = 0; // timestamp for the next auto-serve

  function buildWall() {
    bricks = Array.from({ length: ROWS }, () => Array(COLS).fill(true));
    bricksLeft = ROWS * COLS;
  }

  A.register({
    game: 'breakout',
    title: 'BREAKOUT',
    solo: true,

    onStart() {
      paddleX = 0.5;
      ball = null;
      ballSpeed = 0.8;
      buildWall();
      serveAt = performance.now() + 1000;
      A.flash('GO!');
    },

    onResume() {
      buildWall();
      ball = null;
      serveAt = performance.now() + 1000;
    },

    onEnd() {
      ball = null;
    },

    onPointer(phase, x) {
      const half = PADDLE_W / 2;
      paddleX = Math.max(half, Math.min(COURT_W - half, x));
    },

    step(dt, now) {
      if (!ball && now > serveAt) {
        ball = {
          x: paddleX - BALL_SIZE / 2,
          y: PADDLE_Y - BALL_SIZE - 0.002,
          vx: (Math.random() * 0.5 - 0.25),
          vy: -ballSpeed
        };
        A.sndPaddle();
      }
      const b = ball;
      if (!b) return;

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      if (b.x < 0) { b.x = -b.x; b.vx = Math.abs(b.vx); A.sndWall(); }
      else if (b.x + BALL_SIZE > COURT_W) {
        b.x = 2 * (COURT_W - BALL_SIZE) - b.x;
        b.vx = -Math.abs(b.vx);
        A.sndWall();
      }
      if (b.y < 0) { b.y = -b.y; b.vy = Math.abs(b.vy); A.sndWall(); }

      // Bricks
      const cy = b.y + BALL_SIZE / 2;
      if (cy > WALL_TOP && cy < WALL_TOP + ROWS * BRICK_H && bricksLeft > 0) {
        const r = Math.floor((cy - WALL_TOP) / BRICK_H);
        const c = Math.floor((b.x + BALL_SIZE / 2) / BRICK_W);
        if (r >= 0 && r < ROWS && c >= 0 && c < COLS && bricks[r][c]) {
          bricks[r][c] = false;
          bricksLeft -= 1;
          b.vy = -b.vy;
          A.sndWall();
          A.addScore(1);
          if (bricksLeft === 0) {
            buildWall();               // fresh wall, faster ball
            ballSpeed = Math.min(1.6, ballSpeed * 1.12);
            A.flash('NEW WALL');
          }
        }
      }

      // Paddle
      if (b.vy > 0 && b.y + BALL_SIZE >= PADDLE_Y && b.y + BALL_SIZE <= PADDLE_Y + PADDLE_H + 0.05) {
        const left = paddleX - PADDLE_W / 2;
        if (b.x + BALL_SIZE >= left && b.x <= left + PADDLE_W) {
          const hit = ((b.x + BALL_SIZE / 2) - paddleX) / (PADDLE_W / 2);
          b.vy = -Math.max(Math.abs(b.vy), ballSpeed);
          b.vx = hit * BALL_VX_MAX;
          b.y = PADDLE_Y - BALL_SIZE;
          A.sndPaddle();
        }
      }

      // Lost below: just re-serve after a second
      if (b.y > PLAY_H) {
        ball = null;
        serveAt = now + 1000;
        A.sndScore();
      }
    },

    draw() {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (bricks[r][c]) {
            ctx.fillRect(X(c * BRICK_W) + 1, Y(WALL_TOP + r * BRICK_H) + 1,
              S(BRICK_W) - 2, S(BRICK_H) - 2);
          }
        }
      }
      ctx.fillRect(X(paddleX - PADDLE_W / 2), Y(PADDLE_Y), S(PADDLE_W), S(PADDLE_H));
      if (ball) ctx.fillRect(X(ball.x), Y(ball.y), S(BALL_SIZE), S(BALL_SIZE));
    }
  });
})();
