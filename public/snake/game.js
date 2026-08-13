/*
 * SNAKE (1976) - eat & sabotage.
 *
 * Each phone has its own arena. Every apple you eat is a point AND
 * drops a wall block into your rival's arena. Crashing (wall, yourself,
 * a block) resets your snake but keeps your score. Swipe to steer.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { PLAY_H, COURT_W, X, Y, S, ctx } = A;

  const COLS = 15;
  const CELL = COURT_W / COLS;
  const ROWS = Math.floor(PLAY_H / CELL); // 19 rows
  const MAX_OBSTACLES = 25;

  let snake = [];             // [{c,r}] head first
  let dir = { x: 0, y: -1 };
  let nextDir = null;
  let grow = 0;
  let apple = null;
  let obstacles = [];         // [{c,r}]
  let acc = 0;
  let speed = 7;              // cells per second
  let swipeAnchor = null;

  const key = (c, r) => c + ',' + r;

  function freeCell() {
    const used = new Set(snake.map(s => key(s.c, s.r)));
    if (apple) used.add(key(apple.c, apple.r));
    for (const o of obstacles) used.add(key(o.c, o.r));
    for (let tries = 0; tries < 200; tries++) {
      const c = Math.floor(Math.random() * COLS);
      const r = Math.floor(Math.random() * ROWS);
      if (!used.has(key(c, r))) return { c, r };
    }
    return null;
  }

  function resetSnake() {
    const c = Math.floor(COLS / 2);
    const r = Math.floor(ROWS / 2);
    snake = [{ c, r }, { c, r: r + 1 }, { c, r: r + 2 }];
    dir = { x: 0, y: -1 };
    nextDir = null;
    grow = 0;
  }

  A.register({
    game: 'snake',
    title: 'SNAKE',

    getOpts() {
      const sel = document.querySelector('.opt-btn.sel[data-speed]');
      return { speed: sel ? Number(sel.dataset.speed) : 2 };
    },

    onStart(cfg) {
      speed = 5 + (cfg.opts.speed || 2) * 2; // 7 / 9 / 11 cells per second
      obstacles = [];
      resetSnake();
      apple = freeCell();
      acc = 0;
    },

    onResume(cfg) {
      speed = 5 + (cfg.opts.speed || 2) * 2;
      obstacles = [];
      resetSnake();
      apple = freeCell();
    },

    onMessage(msg) {
      // The rival ate an apple: a wall block lands in MY arena
      if (msg.type === 'attack') {
        const cell = freeCell();
        if (cell && obstacles.length < MAX_OBSTACLES) {
          obstacles.push(cell);
          A.sndWall();
        }
      }
    },

    onPointer(phase, x, y) {
      if (phase === 'down') {
        swipeAnchor = { x, y };
        return;
      }
      if (!swipeAnchor) return;
      const dx = x - swipeAnchor.x;
      const dy = y - swipeAnchor.y;
      if (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) return;
      let d;
      if (Math.abs(dx) > Math.abs(dy)) d = { x: Math.sign(dx), y: 0 };
      else d = { x: 0, y: Math.sign(dy) };
      // No 180-degree turns
      if (d.x !== -dir.x || d.y !== -dir.y) nextDir = d;
      swipeAnchor = { x, y };
    },

    step(dt) {
      acc += dt;
      const tick = 1 / speed;
      while (acc >= tick) {
        acc -= tick;
        if (nextDir) {
          dir = nextDir;
          nextDir = null;
        }
        const head = { c: snake[0].c + dir.x, r: snake[0].r + dir.y };

        const hitWall = head.c < 0 || head.c >= COLS || head.r < 0 || head.r >= ROWS;
        const hitSelf = snake.some(s => s.c === head.c && s.r === head.r);
        const hitBlock = obstacles.some(o => o.c === head.c && o.r === head.r);
        if (hitWall || hitSelf || hitBlock) {
          A.sndScore();
          resetSnake();
          continue;
        }

        snake.unshift(head);
        if (apple && head.c === apple.c && head.r === apple.r) {
          grow += 2;
          apple = freeCell();
          A.sndPaddle();
          A.addScore(1);              // my point...
          A.send({ type: 'attack' }); // ...and a block for the rival
        }
        if (grow > 0) grow -= 1;
        else snake.pop();
      }
    },

    draw(now) {
      const px = S(CELL);
      for (const s of snake) {
        ctx.fillRect(X(s.c * CELL) + 1, Y(s.r * CELL) + 1, px - 2, px - 2);
      }
      if (apple && Math.floor(now / 250) % 2 === 0) {
        ctx.fillRect(X(apple.c * CELL) + S(CELL * 0.2), Y(apple.r * CELL) + S(CELL * 0.2),
          S(CELL * 0.6), S(CELL * 0.6));
      }
      ctx.globalAlpha = 0.55;
      for (const o of obstacles) {
        ctx.fillRect(X(o.c * CELL) + 1, Y(o.r * CELL) + 1, px - 2, px - 2);
      }
      ctx.globalAlpha = 1;
    }
  });
})();
