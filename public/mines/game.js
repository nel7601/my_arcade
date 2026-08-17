/*
 * MINES - minesweeper race.
 *
 * Each player sweeps their OWN board (same size, same mine count,
 * different layout) at their own pace. You see nothing of the rival's
 * progress — only the notification that they won. Digging a mine
 * BLOWS UP your board and deals you a fresh one; you keep trying
 * until someone clears their board first.
 *
 * Input: tap / left-click = DIG · press-and-hold / right-click = FLAG
 * (flags are markers only; hold again to remove). The first dig of
 * every board is always safe.
 *
 * Solo mode: clear as many boards as you can before the clock ends.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { X, Y, S, ctx } = A;

  const COLS = 10, ROWS = 12;
  const CELL = 0.098;
  const X0 = (1 - COLS * CELL) / 2;
  const Y0 = 0.1;                 // header strip above the board
  const HOLD_MS = 450;            // press-and-hold this long to flag
  const BOOM_MS = 900;            // frozen boom display before the reset

  const COVERED = 0, REVEALED = 1, FLAGGED = 2;

  let mines = null;               // Set('c,r'), dealt on the first dig
  let minesTotal = 20;
  let cell = [];
  let counts = [];
  let revealedCount = 0;
  let safeTotal = 0;
  let flagCount = 0;
  let attempts = 1;               // boards tried since the last clear
  let boomCell = null;            // {c, r} while the boom freeze is on
  let boomUntil = 0;
  let finished = false;           // someone already won this match
  let hold = null;

  const key = (c, r) => c + ',' + r;

  // Menu selector
  let optMines = 20;
  for (const btn of document.querySelectorAll('.opt-btn[data-mines]')) {
    btn.addEventListener('click', () => {
      optMines = Number(btn.dataset.mines);
      for (const b of document.querySelectorAll('.opt-btn[data-mines]')) {
        b.classList.toggle('sel', b === btn);
      }
    });
  }

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
  }

  // Deal the mines, keeping the 3x3 around the first dig safe
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
    // The host blows the final whistle for both phones
    if (A.state.role === 'host' && A.state.phase === 'playing') {
      A.state.timeLeft = 0.01;
    }
  }

  function dig(c, r) {
    if (!mines) dealMines(c, r); // first dig of this board: always safe

    if (mines.has(key(c, r))) {
      // BOOM: show it, then a fresh board — until the rival wins
      cell[r][c] = REVEALED;
      boomCell = { c, r };
      boomUntil = performance.now() + BOOM_MS;
      attempts += 1;
      A.beep(120, 0.35);
      A.flash('BOOM! NEW BOARD');
      try { navigator.vibrate && navigator.vibrate([60, 40, 60]); } catch { /* optional */ }
      return;
    }

    floodReveal(c, r);
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
    A.beep(660, 0.04);
    try { navigator.vibrate && navigator.vibrate(30); } catch { /* optional */ }
  }

  function frozen() {
    return boomUntil > performance.now();
  }

  function canTouch(c, r) {
    return A.state.phase === 'playing' && !finished && !frozen() &&
      c >= 0 && c < COLS && r >= 0 && r < ROWS;
  }

  function cancelHold() {
    if (hold) clearTimeout(hold.timer);
    hold = null;
  }

  A.register({
    game: 'mines',
    title: 'MINES',
    solo: true,

    getOpts() {
      return { mines: optMines };
    },

    onStart(cfg) {
      minesTotal = cfg.opts.mines || 20;
      finished = false;
      cancelHold();
      newBoard(false);
      A.flash(A.state.solo ? 'CLEAR THE BOARD!' : 'FIRST CLEAR WINS!');
    },

    onResume(cfg) {
      // Fresh page mid-match: your board is yours alone — deal a new one
      minesTotal = cfg.opts.mines || 20;
      finished = false;
      cancelHold();
      newBoard(false);
    },

    onEnd() {
      cancelHold();
    },

    onMessage(msg) {
      if (msg.type === 'win') {
        // The only thing you ever learn about the rival: they won
        finished = true;
        A.flash('RIVAL CLEARED THEIR BOARD!');
        if (A.state.role === 'host' && A.state.phase === 'playing') {
          A.state.timeLeft = 0.01;
        }
      }
    },

    // Input: tap / left-click = DIG · press-and-hold / right-click = FLAG
    onPointer(phase, x, y, button) {
      const c = Math.floor((x - X0) / CELL);
      const r = Math.floor((y - Y0) / CELL);

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

      // phase === 'up': released before the hold fired -> DIG
      if (hold) {
        const h = hold;
        cancelHold();
        if (canTouch(h.c, h.r) && cell[h.r][h.c] === COVERED) dig(h.c, h.r);
      }
    },

    step(dt, now) {
      // The boom freeze elapsed: deal the fresh board
      if (boomCell && now >= boomUntil) {
        newBoard(true);
      }
    },

    draw(now, color) {
      // ---- Header: mines left, attempt number, input legend
      ctx.textAlign = 'left';
      ctx.font = `bold ${Math.round(S(0.038))}px "Courier New", monospace`;
      ctx.fillText(`${Math.max(0, minesTotal - flagCount)}*`, X(0.02), Y(0.055));
      ctx.font = `${Math.round(S(0.03))}px "Courier New", monospace`;
      ctx.fillText(`TRY ${attempts}`, X(0.2), Y(0.055));
      ctx.textAlign = 'right';
      ctx.font = `${Math.round(S(0.024))}px "Courier New", monospace`;
      ctx.globalAlpha = 0.75;
      ctx.fillText('TAP = DIG', X(0.98), Y(0.032));
      ctx.fillText('HOLD = FLAG', X(0.98), Y(0.068));
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';

      // Hold-to-flag progress square
      if (hold) {
        const progress = Math.min(1, (now - hold.t0) / HOLD_MS);
        const size = CELL * 0.95 * progress;
        const cx0 = X0 + (hold.c + 0.5) * CELL, cy0 = Y0 + (hold.r + 0.5) * CELL;
        ctx.globalAlpha = 0.7;
        ctx.fillRect(X(cx0 - size / 2), Y(cy0 - size / 2), S(size), S(size));
        ctx.globalAlpha = 1;
      }

      // ---- Board
      ctx.textAlign = 'center';
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const px = X(X0 + c * CELL), py = Y(Y0 + r * CELL);
          const cx = X(X0 + (c + 0.5) * CELL), cy = Y(Y0 + (r + 0.55) * CELL);
          const st = cell[r][c];

          if (st === COVERED || st === FLAGGED) {
            ctx.globalAlpha = 0.28;
            ctx.fillRect(px + 1, py + 1, S(CELL) - 2, S(CELL) - 2);
            ctx.globalAlpha = 1;
            if (st === FLAGGED) {
              // Pennant: pole + little flag
              ctx.fillRect(cx - S(0.004), cy - S(0.032), S(0.008), S(0.05));
              ctx.fillRect(cx - S(0.004), cy - S(0.032), S(0.026), S(0.018));
            }
          } else if (boomCell && boomCell.c === c && boomCell.r === r) {
            // The mine you stepped on
            const rad = S(CELL * 0.3);
            ctx.beginPath();
            ctx.arc(cx, cy - S(0.008), rad, 0, Math.PI * 2);
            ctx.fill();
            ctx.lineWidth = Math.max(2, S(0.012));
            ctx.strokeStyle = color;
            ctx.beginPath();
            ctx.moveTo(cx - rad * 1.4, cy - S(0.008) - rad * 1.4);
            ctx.lineTo(cx + rad * 1.4, cy - S(0.008) + rad * 1.4);
            ctx.moveTo(cx + rad * 1.4, cy - S(0.008) - rad * 1.4);
            ctx.lineTo(cx - rad * 1.4, cy - S(0.008) + rad * 1.4);
            ctx.stroke();
          } else {
            const n = counts[r][c];
            if (n > 0) {
              ctx.font = `bold ${Math.round(S(0.05))}px "Courier New", monospace`;
              ctx.fillText(String(n), cx, cy + S(0.008));
            }
          }
        }
      }
    },

    status() {
      if (frozen()) return 'BOOM! DEALING A NEW BOARD...';
      if (A.state.solo) return null;
      return 'FIRST CLEAR WINS';
    }
  });

  // Exposed for automated tests; not part of the game logic
  A.state.msDebug = () => ({
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
