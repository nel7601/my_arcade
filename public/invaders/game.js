/*
 * INVADERS (1978) - clear rows, send them over.
 *
 * Each phone defends its own screen; the cannon fires by itself, you
 * just steer it. Every invader is a point. Wipe out a whole row and a
 * brand-new row lands on top of your rival's formation. If they reach
 * your cannon line, your formation resets.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { PLAY_H, COURT_W, X, Y, S, ctx } = A;

  const COLS = 8;
  const ALIEN_W = 0.07, ALIEN_H = 0.05;
  const GAP_X = (COURT_W - COLS * ALIEN_W) / (COLS + 1);
  const CANNON_W = 0.08, CANNON_H = 0.04;
  const CANNON_Y = PLAY_H - CANNON_H;
  const FIRE_EVERY = 0.45;
  const MAX_ROWS = 7;

  let aliens = [];        // [{c, row, alive}] with formation offset
  let formX = 0;          // horizontal offset of the formation
  let formY = 0;
  let formDir = 1;
  let stepTimer = 0;
  let cannonX = 0.5;
  let bullets = [];
  let fireTimer = 0;
  let rowsSpawned = 0;

  function spawnFormation(rows) {
    aliens = [];
    rowsSpawned = rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < COLS; c++) {
        aliens.push({ c, r, alive: true });
      }
    }
    formX = 0;
    formY = 0.06;
    formDir = 1;
  }

  function addRowOnTop() {
    if (rowCount() >= MAX_ROWS) return;
    // Shift every row down one slot and add a fresh row at r=0
    for (const a of aliens) a.r += 1;
    for (let c = 0; c < COLS; c++) aliens.push({ c, r: 0, alive: true });
  }

  function rowCount() {
    let max = -1;
    for (const a of aliens) if (a.alive && a.r > max) max = a.r;
    return max + 1;
  }

  const alienPos = (a) => ({
    x: GAP_X + a.c * (ALIEN_W + GAP_X) + formX,
    y: formY + a.r * (ALIEN_H + 0.025)
  });

  A.register({
    game: 'invaders',
    title: 'INVADERS',

    onStart() {
      spawnFormation(4);
      bullets = [];
      cannonX = 0.5;
      fireTimer = 0;
      stepTimer = 0;
    },

    onResume() {
      spawnFormation(4);
      bullets = [];
    },

    onMessage(msg) {
      if (msg.type === 'attack') {
        addRowOnTop();
        A.sndWall();
      }
    },

    onPointer(phase, x) {
      const half = CANNON_W / 2;
      cannonX = Math.max(half, Math.min(COURT_W - half, x));
    },

    step(dt) {
      // March: the fewer they are, the faster they get
      const alive = aliens.filter(a => a.alive);
      const interval = Math.max(0.12, 0.05 + alive.length * 0.014);
      stepTimer += dt;
      if (stepTimer >= interval && alive.length) {
        stepTimer = 0;
        let minX = 1, maxX = 0;
        for (const a of alive) {
          const p = alienPos(a);
          minX = Math.min(minX, p.x);
          maxX = Math.max(maxX, p.x + ALIEN_W);
        }
        if ((formDir > 0 && maxX + 0.02 >= COURT_W) || (formDir < 0 && minX - 0.02 <= 0)) {
          formDir = -formDir;
          formY += 0.035;
          A.sndWall();
        } else {
          formX += formDir * 0.02;
        }
        // Reached the cannon line: mercy reset (score untouched)
        let lowest = 0;
        for (const a of alive) lowest = Math.max(lowest, alienPos(a).y + ALIEN_H);
        if (lowest >= CANNON_Y - 0.02) {
          spawnFormation(4);
          A.flash('INVADED!');
          A.sndScore();
        }
      }

      // Autofire
      fireTimer += dt;
      if (fireTimer >= FIRE_EVERY) {
        fireTimer = 0;
        bullets.push({ x: cannonX, y: CANNON_Y - 0.01 });
        A.beep(880, 0.03);
      }

      // Bullets
      for (const bl of bullets) bl.y -= 1.5 * dt;
      bullets = bullets.filter(bl => bl.y > -0.05);
      for (const bl of bullets) {
        for (const a of aliens) {
          if (!a.alive) continue;
          const p = alienPos(a);
          if (bl.x >= p.x && bl.x <= p.x + ALIEN_W && bl.y >= p.y && bl.y <= p.y + ALIEN_H) {
            a.alive = false;
            bl.y = -1; // consume the bullet
            A.sndPaddle();
            A.addScore(1);
            // Whole row cleared -> new row lands on the rival
            if (!aliens.some(o => o.alive && o.r === a.r)) {
              A.send({ type: 'attack' });
              A.flash('ROW SENT!');
            }
            break;
          }
        }
      }

      // Formation fully cleared: a bigger one arrives
      if (!aliens.some(a => a.alive)) {
        spawnFormation(Math.min(MAX_ROWS, rowsSpawned + 1));
      }
    },

    draw(now) {
      // Aliens: chunky two-frame sprites made of squares
      const frame = Math.floor(now / 400) % 2;
      for (const a of aliens) {
        if (!a.alive) continue;
        const p = alienPos(a);
        ctx.fillRect(X(p.x), Y(p.y), S(ALIEN_W), S(ALIEN_H * 0.6));
        const legY = Y(p.y + ALIEN_H * 0.65);
        if (frame === 0) {
          ctx.fillRect(X(p.x), legY, S(ALIEN_W * 0.25), S(ALIEN_H * 0.35));
          ctx.fillRect(X(p.x + ALIEN_W * 0.75), legY, S(ALIEN_W * 0.25), S(ALIEN_H * 0.35));
        } else {
          ctx.fillRect(X(p.x + ALIEN_W * 0.25), legY, S(ALIEN_W * 0.2), S(ALIEN_H * 0.35));
          ctx.fillRect(X(p.x + ALIEN_W * 0.55), legY, S(ALIEN_W * 0.2), S(ALIEN_H * 0.35));
        }
      }
      // Cannon
      ctx.fillRect(X(cannonX - CANNON_W / 2), Y(CANNON_Y), S(CANNON_W), S(CANNON_H));
      ctx.fillRect(X(cannonX - 0.008), Y(CANNON_Y - 0.02), S(0.016), S(0.02));
      // Bullets
      for (const bl of bullets) {
        ctx.fillRect(X(bl.x - 0.004), Y(bl.y), S(0.008), S(0.025));
      }
    }
  });
})();
