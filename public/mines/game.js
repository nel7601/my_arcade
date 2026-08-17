/*
 * MINES - turn-based minesweeper duel.
 *
 * One shared board on both phones. Players alternate 10-second turns;
 * on your turn you either DIG a cell you think is safe (reveals its
 * number, flood-reveals empty areas) or FLAG a cell you think hides a
 * mine. A correct flag captures the mine and scores a point; flagging
 * a safe cell just reveals it; digging a mine blows it up for nobody.
 * The match ends when the clock runs out or every mine is resolved —
 * most captured mines wins.
 *
 * The host owns the board layout and shares it; moves are exchanged as
 * messages and both phones apply them to their copy.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { PLAY_H, X, Y, S, ctx } = A;

  const COLS = 10, ROWS = 12;
  const CELL = 0.098;
  const X0 = (1 - COLS * CELL) / 2;
  const Y0 = 0.1;                 // header strip above the board
  const TURN_SECONDS = 10;
  const HOLD_MS = 450;            // press-and-hold this long to flag

  // Cell states
  const COVERED = 0, REVEALED = 1, MINE_ME = 2, MINE_RIVAL = 3, EXPLODED = 4;

  let mines = new Set();          // 'c,r'
  let cell = [];                  // cell[r][c] -> state code
  let counts = [];                // adjacent mine counts
  let boardReady = false;
  let minesTotal = 0;
  let resolved = 0;               // captured + exploded mines
  let myTurn = false;
  let turnLeft = TURN_SECONDS;
  let hold = null; // pending press: {c, r, x, y, t0, timer} — becomes a flag if held

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

  function blankBoard() {
    cell = Array.from({ length: ROWS }, () => Array(COLS).fill(COVERED));
    counts = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    resolved = 0;
  }

  function computeCounts() {
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

  function buildFromMines(list) {
    mines = new Set(list.map(([c, r]) => key(c, r)));
    minesTotal = mines.size;
    computeCounts();
    boardReady = true;
  }

  function generateBoard(n) {
    blankBoard();
    const picks = new Set();
    while (picks.size < n) {
      picks.add(key(Math.floor(Math.random() * COLS), Math.floor(Math.random() * ROWS)));
    }
    buildFromMines([...picks].map(s => s.split(',').map(Number)));
  }

  function floodReveal(c0, r0) {
    const stack = [[c0, r0]];
    while (stack.length) {
      const [c, r] = stack.pop();
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
      if (cell[r][c] !== COVERED || mines.has(key(c, r))) continue;
      cell[r][c] = REVEALED;
      if (counts[r][c] === 0) {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (dc || dr) stack.push([c + dc, r + dr]);
          }
        }
      }
    }
  }

  // Applies a move on this phone's copy of the board
  function applyMove(action, c, r, byMe) {
    if (!boardReady || c < 0 || c >= COLS || r < 0 || r >= ROWS) return;
    if (cell[r][c] !== COVERED) return;

    if (mines.has(key(c, r))) {
      if (action === 'flag') {
        cell[r][c] = byMe ? MINE_ME : MINE_RIVAL;
        if (byMe) A.addScore(1); // a captured mine is a point
        A.sndScore();
      } else {
        cell[r][c] = EXPLODED;   // dug into a mine: revealed, nobody scores
        A.beep(120, 0.3);
      }
      resolved += 1;
      // All mines resolved: the host blows the final whistle early
      if (resolved >= minesTotal && A.state.role === 'host' && A.state.phase === 'playing') {
        A.state.timeLeft = 0.01;
      }
    } else {
      if (action === 'dig' && counts[r][c] === 0) {
        floodReveal(c, r);
      } else {
        cell[r][c] = REVEALED;   // a wrong flag just reveals a safe cell
      }
      A.beep(330, 0.04);
    }

    // Single player: it is always your turn (the clock is the rival)
    myTurn = A.state.solo ? true : !byMe;
    turnLeft = TURN_SECONDS;
  }

  // A move made by ME (dig or flag), sent to the rival and applied locally
  function makeMove(action, c, r) {
    A.send({ type: 'move', action, c, r });
    applyMove(action, c, r, true);
    if (action === 'flag') {
      try { navigator.vibrate && navigator.vibrate(30); } catch { /* optional */ }
    }
  }

  function canAct(c, r) {
    return A.state.phase === 'playing' && boardReady && myTurn &&
      c >= 0 && c < COLS && r >= 0 && r < ROWS && cell[r][c] === COVERED;
  }

  function cancelHold() {
    if (hold) clearTimeout(hold.timer);
    hold = null;
  }

  // Compact board serialization for reload recovery
  function packCells() {
    let s = '';
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) s += cell[r][c];
    return s;
  }

  function unpackCells(s) {
    let i = 0, res = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        let v = Number(s[i++]) || 0;
        // MINE_ME/MINE_RIVAL are relative to the SENDER: swap them
        if (v === MINE_ME) v = MINE_RIVAL;
        else if (v === MINE_RIVAL) v = MINE_ME;
        cell[r][c] = v;
        if (v === MINE_ME || v === MINE_RIVAL || v === EXPLODED) res += 1;
      }
    }
    resolved = res;
  }

  A.register({
    game: 'mines',
    title: 'MINES',
    solo: true,

    getOpts() {
      return { mines: optMines };
    },

    onStart(cfg) {
      blankBoard();
      boardReady = false;
      cancelHold();
      turnLeft = TURN_SECONDS;
      myTurn = A.state.role === 'host'; // host moves first
      if (A.state.role === 'host') {
        generateBoard(cfg.opts.mines || 20);
        A.send({ type: 'board', mines: [...mines].map(s => s.split(',').map(Number)) });
        A.flash('YOUR TURN');
      } else {
        A.flash('RIVAL STARTS');
      }
    },

    onResume() {
      // Fresh page mid-match: ask the rival for the full board state
      blankBoard();
      boardReady = false;
      A.send({ type: 'need_board' });
    },

    onMessage(msg) {
      switch (msg.type) {
        case 'board':
          blankBoard();
          buildFromMines(msg.mines);
          break;

        case 'move':
          applyMove(msg.action, msg.c, msg.r, false);
          break;

        case 'pass':
          myTurn = true;
          turnLeft = TURN_SECONDS;
          A.flash('YOUR TURN');
          break;

        case 'need_board':
          if (boardReady) {
            A.send({
              type: 'sync',
              mines: [...mines].map(s => s.split(',').map(Number)),
              cells: packCells(),
              yourTurn: !myTurn,
              turnLeft
            });
          }
          break;

        case 'sync':
          blankBoard();
          buildFromMines(msg.mines);
          unpackCells(msg.cells);
          myTurn = Boolean(msg.yourTurn);
          turnLeft = Math.max(1, Number(msg.turnLeft) || TURN_SECONDS);
          break;
      }
    },

    // Input: tap / left-click = DIG · press-and-hold / right-click = FLAG
    onPointer(phase, x, y, button) {
      const c = Math.floor((x - X0) / CELL);
      const r = Math.floor((y - Y0) / CELL);

      if (phase === 'down') {
        cancelHold();
        if (!canAct(c, r)) return;

        if (button === 'right') {
          makeMove('flag', c, r); // desktop shortcut: right-click flags
          return;
        }

        // Touch or left button: wait to see if it's a tap or a hold
        hold = {
          c, r, x, y,
          t0: performance.now(),
          timer: setTimeout(() => {
            const h = hold;
            hold = null;
            if (h && canAct(h.c, h.r)) makeMove('flag', h.c, h.r);
          }, HOLD_MS)
        };
        return;
      }

      if (phase === 'move') {
        // A drag is neither a tap nor a hold
        if (hold && Math.hypot(x - hold.x, y - hold.y) > 0.035) cancelHold();
        return;
      }

      // phase === 'up': released before the hold fired -> it's a DIG
      if (hold) {
        const h = hold;
        cancelHold();
        if (canAct(h.c, h.r)) makeMove('dig', h.c, h.r);
      }
    },

    step(dt) {
      if (!boardReady) return;
      turnLeft -= dt;
      if (turnLeft <= 0) {
        if (A.state.solo) {
          turnLeft = TURN_SECONDS; // solo: a slow turn is just a wasted turn
          A.beep(200, 0.1);
        } else if (myTurn) {
          // Out of time: the turn passes
          A.send({ type: 'pass' });
          myTurn = false;
          turnLeft = TURN_SECONDS;
          A.beep(200, 0.1);
        } else if (turnLeft < -6 && A.state.role === 'host') {
          // Watchdog: if turn ownership ever got lost, the host reclaims it
          myTurn = true;
          turnLeft = TURN_SECONDS;
        }
      }
    },

    draw(now, color) {
      // ---- Header: turn indicator, mines left and the input legend
      ctx.textAlign = 'left';
      ctx.font = `bold ${Math.round(S(0.038))}px "Courier New", monospace`;
      if (boardReady) {
        const secs = Math.max(0, Math.ceil(turnLeft));
        const blink = myTurn && turnLeft < 3 && Math.floor(now / 250) % 2 === 0;
        if (!blink) {
          ctx.fillText(myTurn ? `YOU ${secs}` : `RIVAL ${secs}`, X(0.02), Y(0.055));
        }
        ctx.font = `${Math.round(S(0.026))}px "Courier New", monospace`;
        ctx.fillText(`${minesTotal - resolved}*`, X(0.32), Y(0.055));
      }
      ctx.textAlign = 'right';
      ctx.font = `${Math.round(S(0.024))}px "Courier New", monospace`;
      ctx.globalAlpha = 0.75;
      ctx.fillText('TAP = DIG', X(0.98), Y(0.032));
      ctx.fillText('HOLD = FLAG', X(0.98), Y(0.068));
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';

      // Hold-to-flag progress: a square growing over the pressed cell
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

          if (st === COVERED) {
            ctx.globalAlpha = 0.28;
            ctx.fillRect(px + 1, py + 1, S(CELL) - 2, S(CELL) - 2);
            ctx.globalAlpha = 1;
          } else if (st === REVEALED) {
            const n = counts[r][c];
            if (n > 0) {
              ctx.font = `bold ${Math.round(S(0.05))}px "Courier New", monospace`;
              ctx.fillText(String(n), cx, cy + S(0.008));
            }
          } else {
            // A resolved mine: filled disc = yours, ring = rival's, X = blown up
            const rad = S(CELL * 0.28);
            ctx.beginPath();
            ctx.arc(cx, cy - S(0.008), rad, 0, Math.PI * 2);
            if (st === MINE_ME) {
              ctx.fill();
            } else if (st === MINE_RIVAL) {
              ctx.lineWidth = Math.max(2, S(0.012));
              ctx.strokeStyle = color;
              ctx.stroke();
            } else {
              ctx.lineWidth = Math.max(2, S(0.012));
              ctx.strokeStyle = color;
              ctx.stroke();
              ctx.beginPath();
              ctx.moveTo(cx - rad, cy - S(0.008) - rad);
              ctx.lineTo(cx + rad, cy - S(0.008) + rad);
              ctx.moveTo(cx + rad, cy - S(0.008) - rad);
              ctx.lineTo(cx - rad, cy - S(0.008) + rad);
              ctx.stroke();
            }
          }
        }
      }
    },

    status() {
      if (!boardReady) return 'WAITING FOR BOARD...';
      return myTurn ? 'TAP TO DIG · HOLD TO FLAG' : null;
    }
  });

  // Exposed for automated tests; not part of the game logic
  A.state.msDebug = () => ({
    boardReady, myTurn, resolved, minesTotal,
    holding: Boolean(hold),
    mines: [...mines],
    turnLeft
  });
})();
