/*
 * CONNECT 4 - drop discs, line up four, round after round.
 *
 * Classic 7x6 board: tap a column and your disc falls to the lowest
 * free slot. Four in a row (any direction) wins the round and scores a
 * point; a full board is a draw and rolls into the next round. The
 * starter alternates each round and always plays BLUE. Whoever has more
 * rounds when the match clock runs out takes the win.
 *
 * Both phones replay every drop, so the boards stay identical.
 *
 * Solo mode: an AI that takes its wins, blocks yours, and avoids
 * serving you a win on a silver platter - but it can be out-planned.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { X, Y, S, ctx } = A;

  const COLS = 7, ROWS = 6;
  const C = 0.13;                       // cell size
  const BX = (1 - COLS * C) / 2;        // 0.045
  const BY = 0.24;

  const BLUE = '#5ad0ff', ORANGE = '#ffb04f';

  let board = Array(COLS * ROWS).fill(null); // 'B' | 'O' | null (col + row*COLS)
  let round = 1;                             // odd rounds: host starts (and is BLUE)
  let turnRole = 'host';
  let roundOver = false;
  let winCells = null;                       // [i,i,i,i] of the winning four
  let nextAt = 0;
  let aiAt = 0;
  let lastDrop = null;                       // {i, born} falling-disc animation
  let nextPoke = Infinity;

  const myRole = () => A.state.role;
  const foe = (r) => (r === 'host' ? 'guest' : 'host');
  const starterRole = (n) => (n % 2 === 1 ? 'host' : 'guest');
  const markOf = (role) => (role === starterRole(round) ? 'B' : 'O');
  const at = (c, r) => board[c + r * COLS];

  function newRound(n) {
    round = n;
    board = Array(COLS * ROWS).fill(null);
    roundOver = false;
    winCells = null;
    lastDrop = null;
    turnRole = starterRole(n);
    aiAt = performance.now() + 900;
  }

  function dropRow(c) {
    for (let r = ROWS - 1; r >= 0; r--) if (at(c, r) === null) return r;
    return -1;
  }

  function findFour(mark) {
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (at(c, r) !== mark) continue;
        for (const [dc, dr] of dirs) {
          const cells = [];
          for (let k = 0; k < 4; k++) {
            const cc = c + dc * k, rr = r + dr * k;
            if (cc < 0 || cc >= COLS || rr < 0 || rr >= ROWS || at(cc, rr) !== mark) break;
            cells.push(cc + rr * COLS);
          }
          if (cells.length === 4) return cells;
        }
      }
    }
    return null;
  }

  // Both phones replay every drop through here, so the boards match
  function applyMove(role, c) {
    if (roundOver || role !== turnRole || c < 0 || c >= COLS) return false;
    const r = dropRow(c);
    if (r < 0) return false;
    board[c + r * COLS] = markOf(role);
    lastDrop = { i: c + r * COLS, born: performance.now() };
    A.beep(role === myRole() ? 459 : 320, 0.04);

    const four = findFour(markOf(role));
    if (four) {
      roundOver = true;
      winCells = four;
      nextAt = performance.now() + 1900;
      if (role === myRole()) {
        A.addScore(1);
        A.flash('ROUND WON!');
        A.sndScore();
      } else {
        A.flash('ROUND LOST');
        A.beep(120, 0.25);
      }
    } else if (board.every(x => x !== null)) {
      roundOver = true;
      nextAt = performance.now() + 1400;
      A.flash('DRAW - AGAIN');
    } else {
      turnRole = foe(role);
      aiAt = performance.now() + 750;
    }
    return true;
  }

  function myMove(c) {
    if (A.state.phase !== 'playing' || turnRole !== myRole()) return;
    if (applyMove(myRole(), c)) A.send({ type: 'move', c });
  }

  // ---- Solo AI ---------------------------------------------------------------

  function wouldWin(mark, c) {
    const r = dropRow(c);
    if (r < 0) return false;
    board[c + r * COLS] = mark;
    const win = findFour(mark) !== null;
    board[c + r * COLS] = null;
    return win;
  }

  function aiPick() {
    const open = [];
    for (let c = 0; c < COLS; c++) if (dropRow(c) >= 0) open.push(c);
    const me = markOf('guest'), them = markOf('host');
    for (const c of open) if (wouldWin(me, c)) return c;      // take the win
    for (const c of open) if (wouldWin(them, c)) return c;    // block theirs
    // Avoid handing them a win right on top of our disc
    const safe = open.filter(c => {
      const r = dropRow(c);
      board[c + r * COLS] = me;
      const gift = wouldWin(them, c);
      board[c + r * COLS] = null;
      return !gift;
    });
    const pool = safe.length ? safe : open;
    // Prefer the middle columns, like every schoolyard shark
    pool.sort((a, b) => Math.abs(a - 3) - Math.abs(b - 3));
    const top = pool.filter(c => Math.abs(c - 3) === Math.abs(pool[0] - 3));
    return top[Math.floor(Math.random() * top.length)];
  }

  // ---- Registration ----------------------------------------------------------

  A.register({
    game: 'connect4',
    title: 'CONNECT 4',
    solo: true,

    onStart() {
      newRound(1);
      nextPoke = Infinity;
    },

    onResume() {
      // A reload lost the board: ask the rival for it
      newRound(1);
      A.send({ type: 'state_req' });
      nextPoke = performance.now() + 3000;
    },

    onMessage(msg) {
      switch (msg.type) {
        case 'move':
          applyMove(foe(myRole()), Number(msg.c));
          break;

        case 'state_req':
          A.send({ type: 'state', board, round, turnRole, roundOver });
          break;

        case 'state':
          round = Number(msg.round) || 1;
          board = msg.board.map(x => (x === 'B' || x === 'O' ? x : null));
          turnRole = msg.turnRole === 'guest' ? 'guest' : 'host';
          roundOver = !!msg.roundOver;
          winCells = roundOver ? (findFour('B') || findFour('O')) : null;
          nextAt = performance.now() + 1200;
          lastDrop = null;
          nextPoke = Infinity;
          break;
      }
    },

    onPointer(ph, x, y) {
      if (ph !== 'down' || roundOver) return;
      if (y < 0.08 || y > BY + ROWS * C + 0.05) return;
      const c = Math.floor((x - BX) / C);
      if (c >= 0 && c < COLS) myMove(c);
    },

    step(dt, now) {
      if (now > nextPoke) {
        nextPoke = now + 3000;
        A.send({ type: 'state_req' });
      }
      if (roundOver && now > nextAt) {
        newRound(round + 1);
        return;
      }
      if (A.state.solo && !roundOver && turnRole === 'guest' && now > aiAt) {
        applyMove('guest', aiPick());
      }
    },

    draw(now, color) {
      const me = A.state.solo ? 'host' : myRole();

      // Header: round number and my color, with a sample disc
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.font = `bold ${Math.round(S(0.04))}px "Courier New", monospace`;
      ctx.fillText('ROUND ' + round + ' · YOU PLAY', X(0.44), Y(0.1));
      ctx.fillStyle = markOf(me) === 'B' ? BLUE : ORANGE;
      ctx.beginPath();
      ctx.arc(X(0.72), Y(0.088), S(0.028), 0, Math.PI * 2);
      ctx.fill();

      // Board: faint sockets, filled discs
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const i = c + r * COLS;
          const cx = BX + (c + 0.5) * C, cy = BY + (r + 0.5) * C;
          ctx.strokeStyle = color;
          ctx.globalAlpha = 0.3;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(X(cx), Y(cy), S(C * 0.4), 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
          if (!board[i]) continue;

          // The freshest disc falls into place
          let drawY = cy;
          if (lastDrop && lastDrop.i === i) {
            const t = Math.min(1, (now - lastDrop.born) / 240);
            drawY = (BY - C / 2) + (cy - (BY - C / 2)) * t * t;
            if (t >= 1) lastDrop = null;
          }
          ctx.fillStyle = board[i] === 'B' ? BLUE : ORANGE;
          ctx.beginPath();
          ctx.arc(X(cx), Y(drawY), S(C * 0.38), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // The winning four blink with a ring
      if (winCells && Math.floor(now / 220) % 2 === 0) {
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(3, S(0.012));
        for (const i of winCells) {
          const cx = BX + ((i % COLS) + 0.5) * C, cy = BY + (Math.floor(i / COLS) + 0.5) * C;
          ctx.beginPath();
          ctx.arc(X(cx), Y(cy), S(C * 0.46), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    },

    status() {
      if (roundOver) return null;
      const me = A.state.solo ? 'host' : myRole();
      if (turnRole === me) return 'YOUR TURN: TAP A COLUMN';
      return A.state.solo ? 'THE MACHINE IS THINKING...' : "RIVAL'S TURN...";
    }
  });

  // Exposed for automated tests; not part of the game logic
  A.state.c4Debug = () => ({
    board: board.slice(), round, turnRole, roundOver,
    winCells: winCells ? winCells.slice() : null,
    myMark: markOf(A.state.solo ? 'host' : myRole())
  });
})();
