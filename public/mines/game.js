/*
 * MINES - minesweeper race.
 *
 * Each player sweeps their OWN board (same size, same mine count,
 * different layout, dealt locally) at their own pace. You see nothing
 * of the rival's progress — only the notification that they won.
 * Digging a mine BLOWS UP your board and deals you a fresh one; you
 * keep trying until someone clears their board first.
 *
 * The three classic Minesweeper levels: 9x9 with 10 mines, 16x16 with
 * 40, and 30x16 with 99 (the menu warns that expert cells are tiny on
 * a phone). The board renders into a cached layer so even the expert
 * board stays smooth.
 *
 * Input: tap / left-click = DIG · press-and-hold / right-click = FLAG.
 * The first dig of every board is always safe.
 *
 * Solo mode: clear as many boards as you can before the clock ends.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { PLAY_H, X, Y, S, ctx } = A;

  const Y0 = 0.1;                 // header strip above the board
  const BOARD_H = PLAY_H - Y0;    // vertical space for cells
  const HOLD_MS = 450;
  const BOOM_MS = 900;

  const COVERED = 0, REVEALED = 1, FLAGGED = 2;

  // The three classic Minesweeper levels: beginner / intermediate / expert
  const LEVELS = [
    { cols: 9, rows: 9, mines: 10 },
    { cols: 16, rows: 16, mines: 40 },
    { cols: 30, rows: 16, mines: 99 }
  ];

  // Board geometry (set from the LEVEL option); the board is centered
  // in the play area since the classic shapes don't fill a phone screen
  let COLS = 9, ROWS = 9, CELL = 0.98 / 9, X0 = 0.01, YB = 0.2;

  let mines = null;               // Set('c,r'), dealt on the first dig
  let minesTotal = 20;
  let cell = [];
  let counts = [];
  let revealedCount = 0;
  let safeTotal = 0;
  let flagCount = 0;
  let attempts = 1;
  let boomCell = null;
  let boomUntil = 0;
  let finished = false;
  let hold = null;

  const key = (c, r) => c + ',' + r;

  function setLevel(idx) {
    const lv = LEVELS[Math.min(2, Math.max(0, Math.round(idx) || 0))];
    COLS = lv.cols;
    ROWS = lv.rows;
    minesTotal = lv.mines;
    // Fit the classic shape into the play area and center it
    CELL = Math.min(0.98 / COLS, (BOARD_H - 0.004) / ROWS);
    X0 = (1 - COLS * CELL) / 2;
    YB = Y0 + (BOARD_H - ROWS * CELL) / 2;
  }

  // ---- Menu selector --------------------------------------------------------

  let optLevel = 0;
  for (const btn of document.querySelectorAll('.opt-btn[data-level]')) {
    btn.addEventListener('click', () => {
      optLevel = Number(btn.dataset.level);
      for (const b of document.querySelectorAll('.opt-btn[data-level]')) {
        b.classList.toggle('sel', b === btn);
      }
      // Expert (30 wide) means ~13px cells on a phone: warn
      document.getElementById('size-warning').classList.toggle('hidden', optLevel !== 2);
    });
  }

  // ---- Board ----------------------------------------------------------------

  function newBoard(keepAttempts) {
    mines = null; // dealt on first dig so that dig is always safe
    cell = Array.from({ length: ROWS }, () => Array(COLS).fill(COVERED));
    counts = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    revealedCount = 0;
    flagCount = 0;
    safeTotal = ROWS * COLS - minesTotal;
    boomCell = null;
    boomUntil = 0;
    if (!keepAttempts) attempts = 1;
    layerDirty = true;
  }

  function dealMines(c0, r0) {
    mines = new Set();
    while (mines.size < minesTotal) {
      const c = Math.floor(Math.random() * COLS);
      const r = Math.floor(Math.random() * ROWS);
      if (Math.abs(c - c0) <= 1 && Math.abs(r - r0) <= 1) continue;
      mines.add(key(c, r));
    }
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        let n = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (mines.has(key(c + dc, r + dr))) n++;
          }
        }
        counts[r][c] = n;
      }
    }
  }

  function floodReveal(c0, r0) {
    const stack = [[c0, r0]];
    while (stack.length) {
      const [c, r] = stack.pop();
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
      if (cell[r][c] === REVEALED || mines.has(key(c, r))) continue;
      if (cell[r][c] === FLAGGED) flagCount -= 1;
      cell[r][c] = REVEALED;
      revealedCount += 1;
      if (counts[r][c] === 0) {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dc || dr) stack.push([c + dc, r + dr]);
          }
        }
      }
    }
  }

  function win() {
    finished = A.state.solo ? false : true;
    A.addScore(1);
    A.sndScore();
    if (A.state.solo) {
      A.flash('BOARD CLEARED! NEXT ONE');
      newBoard(false);
      return;
    }
    A.flash('BOARD CLEARED — YOU WIN!');
    A.send({ type: 'win' });
    if (A.state.role === 'host' && A.state.phase === 'playing') {
      A.state.timeLeft = 0.01;
    }
  }

  function dig(c, r) {
    if (!mines) dealMines(c, r);

    if (mines.has(key(c, r))) {
      cell[r][c] = REVEALED;
      boomCell = { c, r };
      boomUntil = performance.now() + BOOM_MS;
      attempts += 1;
      layerDirty = true;
      A.beep(120, 0.35);
      A.flash('BOOM! NEW BOARD');
      try { navigator.vibrate && navigator.vibrate([60, 40, 60]); } catch { /* optional */ }
      return;
    }

    floodReveal(c, r);
    layerDirty = true;
    A.beep(330, 0.04);
    if (revealedCount >= safeTotal) win();
  }

  function toggleFlag(c, r) {
    if (cell[r][c] === COVERED) {
      cell[r][c] = FLAGGED;
      flagCount += 1;
    } else if (cell[r][c] === FLAGGED) {
      cell[r][c] = COVERED;
      flagCount -= 1;
    } else {
      return;
    }
    layerDirty = true;
    A.beep(660, 0.04);
    try { navigator.vibrate && navigator.vibrate(30); } catch { /* optional */ }
  }

  const frozen = () => boomUntil > performance.now();

  function canTouch(c, r) {
    return A.state.phase === 'playing' && !finished && !frozen() &&
      c >= 0 && c < COLS && r >= 0 && r < ROWS;
  }

  function cancelHold() {
    if (hold) clearTimeout(hold.timer);
    hold = null;
  }

  // ---- Cached board layer ---------------------------------------------------
  // Repainted only when the board changes (or the frame color shifts),
  // so huge boards don't redraw thousands of cells every frame.

  const layer = document.createElement('canvas');
  const lctx = layer.getContext('2d');
  let layerDirty = true;
  let layerColor = '';
  let layerColorAt = 0;

  function repaintLayer(color) {
    const cellPx = S(CELL);
    const w = Math.ceil(cellPx * COLS), h = Math.ceil(cellPx * ROWS);
    if (layer.width !== w || layer.height !== h) {
      layer.width = w;
      layer.height = h;
    }
    lctx.clearRect(0, 0, w, h);
    lctx.fillStyle = color;
    lctx.textAlign = 'center';
    const drawNumbers = cellPx >= 9;
    lctx.font = `bold ${Math.round(cellPx * 0.55)}px "Courier New", monospace`;

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const px = c * cellPx, py = r * cellPx;
        const st = cell[r][c];
        if (st === COVERED || st === FLAGGED) {
          lctx.globalAlpha = 0.28;
          lctx.fillRect(px + 1, py + 1, Math.max(1, cellPx - 2), Math.max(1, cellPx - 2));
          lctx.globalAlpha = 1;
          if (st === FLAGGED) {
            const cx = px + cellPx / 2, cy = py + cellPx / 2;
            lctx.fillRect(cx - cellPx * 0.05, cy - cellPx * 0.32, cellPx * 0.1, cellPx * 0.55);
            lctx.fillRect(cx - cellPx * 0.05, cy - cellPx * 0.32, cellPx * 0.3, cellPx * 0.22);
          }
        } else if (drawNumbers) {
          const n = counts[r][c];
          if (n > 0 && !(boomCell && boomCell.c === c && boomCell.r === r)) {
            lctx.fillText(String(n), px + cellPx / 2, py + cellPx * 0.72);
          }
        }
      }
    }
    layerDirty = false;
    layerColor = color;
  }

  // ---- Game definition --------------------------------------------------------

  A.register({
    game: 'mines',
    title: 'MINES',
    solo: true,

    getOpts() {
      return { level: optLevel };
    },

    onStart(cfg) {
      setLevel(cfg.opts.level || 0);
      finished = false;
      cancelHold();
      newBoard(false);
      A.flash(A.state.solo ? 'CLEAR THE BOARD!' : 'FIRST CLEAR WINS!');
    },

    onResume(cfg) {
      setLevel(cfg.opts.level || 0);
      finished = false;
      cancelHold();
      newBoard(false);
    },

    onEnd() {
      cancelHold();
    },

    onMessage(msg) {
      if (msg.type === 'win') {
        finished = true;
        A.flash('RIVAL CLEARED THEIR BOARD!');
        if (A.state.role === 'host' && A.state.phase === 'playing') {
          A.state.timeLeft = 0.01;
        }
      }
    },

    onPointer(phase, x, y, button) {
      const c = Math.floor((x - X0) / CELL);
      const r = Math.floor((y - YB) / CELL);

      if (phase === 'down') {
        cancelHold();
        if (!canTouch(c, r)) return;

        if (button === 'right') {
          toggleFlag(c, r);
          return;
        }
        if (cell[r][c] === REVEALED) return;

        hold = {
          c, r, x, y,
          t0: performance.now(),
          timer: setTimeout(() => {
            const h = hold;
            hold = null;
            if (h && canTouch(h.c, h.r)) toggleFlag(h.c, h.r);
          }, HOLD_MS)
        };
        return;
      }

      if (phase === 'move') {
        if (hold && Math.hypot(x - hold.x, y - hold.y) > 0.035) cancelHold();
        return;
      }

      if (hold) {
        const h = hold;
        cancelHold();
        if (canTouch(h.c, h.r) && cell[h.r][h.c] === COVERED) dig(h.c, h.r);
      }
    },

    step(dt, now) {
      if (boomCell && now >= boomUntil) {
        newBoard(true);
      }
    },

    draw(now, color) {
      // ---- Header
      ctx.textAlign = 'left';
      ctx.font = `bold ${Math.round(S(0.038))}px "Courier New", monospace`;
      ctx.fillText(`${Math.max(0, minesTotal - flagCount)}*`, X(0.02), Y(0.055));
      ctx.font = `${Math.round(S(0.03))}px "Courier New", monospace`;
      ctx.fillText(`TRY ${attempts}`, X(0.24), Y(0.055));
      ctx.textAlign = 'right';
      ctx.font = `${Math.round(S(0.024))}px "Courier New", monospace`;
      ctx.globalAlpha = 0.75;
      ctx.fillText('TAP = DIG', X(0.98), Y(0.032));
      ctx.fillText('HOLD = FLAG', X(0.98), Y(0.068));
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';

      // ---- Board layer (repaint only on change, or color shift every 200ms)
      if (layerDirty || (color !== layerColor && now - layerColorAt > 200)) {
        layerColorAt = now;
        repaintLayer(color);
      }
      ctx.drawImage(layer, X(X0), Y(YB));

      // Hold-to-flag progress square
      if (hold) {
        const progress = Math.min(1, (now - hold.t0) / HOLD_MS);
        const size = CELL * 0.95 * progress;
        const cx0 = X0 + (hold.c + 0.5) * CELL, cy0 = YB + (hold.r + 0.5) * CELL;
        ctx.globalAlpha = 0.7;
        ctx.fillRect(X(cx0 - size / 2), Y(cy0 - size / 2), S(size), S(size));
        ctx.globalAlpha = 1;
      }

      // The mine you stepped on, over the layer during the boom freeze
      if (boomCell) {
        const cx = X(X0 + (boomCell.c + 0.5) * CELL);
        const cy = Y(YB + (boomCell.r + 0.5) * CELL);
        const rad = Math.max(3, S(CELL * 0.3));
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = Math.max(2, S(0.012));
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(cx - rad * 1.4, cy - rad * 1.4);
        ctx.lineTo(cx + rad * 1.4, cy + rad * 1.4);
        ctx.moveTo(cx + rad * 1.4, cy - rad * 1.4);
        ctx.lineTo(cx - rad * 1.4, cy + rad * 1.4);
        ctx.stroke();
      }
    },

    status() {
      if (frozen()) return 'BOOM! DEALING A NEW BOARD...';
      if (A.state.solo) return null;
      return 'FIRST CLEAR WINS';
    }
  });

  // Repaint the cached layer when the window size changes
  window.addEventListener('resize', () => { layerDirty = true; });

  // Exposed for automated tests; not part of the game logic
  A.state.msDebug = () => ({
    cols: COLS,
    rows: ROWS,
    mines: mines ? [...mines] : null,
    minesTotal,
    revealed: revealedCount,
    safeTotal,
    flags: flagCount,
    attempts,
    finished,
    frozen: frozen()
  });
})();
