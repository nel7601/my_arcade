/*
 * TIC-TAC-TOE - the eternal duel, round after round.
 *
 * One round of tic-tac-toe is over in seconds, so a match is a SERIES:
 * every round won is a point, and whoever has more rounds when the
 * match clock runs out takes the win. The starter alternates each round
 * (the starter always plays X, in blue; O is orange), a draw just rolls
 * into the next round, and both phones replay every move so the board
 * stays identical on each side.
 *
 * Solo mode: an AI that wins when it can and blocks when it must - but
 * it can be forked. Beat it.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { X, Y, S, ctx } = A;

  // Board layout: 3x3 in the middle of the play area
  const C = 0.28;                 // cell size
  const BX = (1 - 3 * C) / 2;     // 0.08
  const BY = 0.18;

  const LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];

  let board = Array(9).fill(null); // 'X' | 'O' | null
  let round = 1;                   // 1-based; odd rounds: host starts
  let turnRole = 'host';
  let roundOver = false;
  let winLine = null;              // [a,b,c] of the winning line
  let nextAt = 0;                  // when the next round begins
  let aiAt = 0;
  let nextPoke = Infinity;

  const myRole = () => A.state.role;
  const foe = (r) => (r === 'host' ? 'guest' : 'host');
  const starterRole = (n) => (n % 2 === 1 ? 'host' : 'guest');
  const markOf = (role) => (role === starterRole(round) ? 'X' : 'O');

  function newRound(n) {
    round = n;
    board = Array(9).fill(null);
    roundOver = false;
    winLine = null;
    turnRole = starterRole(n);
    aiAt = performance.now() + 900;
  }

  function lineWonBy(mark) {
    return LINES.find(l => l.every(i => board[i] === mark)) || null;
  }

  // Both phones replay every move through here, so the boards match
  function applyMove(role, i) {
    if (roundOver || board[i] !== null || role !== turnRole) return false;
    board[i] = markOf(role);
    A.beep(role === myRole() ? 459 : 320, 0.04);

    const line = lineWonBy(board[i]);
    if (line) {
      roundOver = true;
      winLine = line;
      nextAt = performance.now() + 1700;
      if (role === myRole()) {
        A.addScore(1);
        A.flash('ROUND WON!');
        A.sndScore();
      } else {
        A.flash('ROUND LOST');
        A.beep(120, 0.25);
      }
    } else if (board.every(c => c !== null)) {
      roundOver = true;
      nextAt = performance.now() + 1400;
      A.flash('DRAW - AGAIN');
    } else {
      turnRole = foe(role);
      aiAt = performance.now() + 700;
    }
    return true;
  }

  function myMove(i) {
    if (A.state.phase !== 'playing' || turnRole !== myRole()) return;
    if (applyMove(myRole(), i)) A.send({ type: 'move', i });
  }

  // ---- Solo AI: win if possible, block if needed, grab the center -----------

  function aiPick() {
    const empty = [];
    for (let i = 0; i < 9; i++) if (board[i] === null) empty.push(i);
    for (const mark of [markOf('guest'), markOf('host')]) {
      for (const i of empty) {
        board[i] = mark;
        const wins = lineWonBy(mark) !== null;
        board[i] = null;
        if (wins) return i;
      }
    }
    if (board[4] === null) return 4;
    return empty[Math.floor(Math.random() * empty.length)];
  }

  // ---- Registration ----------------------------------------------------------

  A.register({
    game: 'tictactoe',
    title: 'TIC-TAC-TOE',
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
          applyMove(foe(myRole()), Number(msg.i));
          break;

        case 'state_req':
          A.send({ type: 'state', board, round, turnRole, roundOver });
          break;

        case 'state':
          round = Number(msg.round) || 1;
          board = msg.board.map(c => (c === 'X' || c === 'O' ? c : null));
          turnRole = msg.turnRole === 'guest' ? 'guest' : 'host';
          roundOver = !!msg.roundOver;
          winLine = roundOver ? (lineWonBy('X') || lineWonBy('O')) : null;
          nextAt = performance.now() + 1200;
          nextPoke = Infinity;
          break;
      }
    },

    onPointer(ph, x, y) {
      if (ph !== 'down' || roundOver) return;
      const cx = Math.floor((x - BX) / C);
      const cy = Math.floor((y - BY) / C);
      if (cx >= 0 && cx < 3 && cy >= 0 && cy < 3) myMove(cy * 3 + cx);
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
      // The AI ponders for a beat, then plays
      if (A.state.solo && !roundOver && turnRole === 'guest' && now > aiAt) {
        applyMove('guest', aiPick());
      }
    },

    draw(now, color) {
      const me = A.state.solo ? 'host' : myRole();

      // Header: round number and my mark
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.font = `bold ${Math.round(S(0.04))}px "Courier New", monospace`;
      ctx.fillText('ROUND ' + round + ' · YOU ARE ' + markOf(me), X(0.5), Y(0.1));

      // Grid
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, S(0.008));
      for (let i = 1; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(X(BX + i * C), Y(BY + 0.015));
        ctx.lineTo(X(BX + i * C), Y(BY + 3 * C - 0.015));
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(X(BX + 0.015), Y(BY + i * C));
        ctx.lineTo(X(BX + 3 * C - 0.015), Y(BY + i * C));
        ctx.stroke();
      }

      // Marks: X in blue, O in orange
      ctx.lineWidth = Math.max(3, S(0.022));
      for (let i = 0; i < 9; i++) {
        if (!board[i]) continue;
        const cx = BX + (i % 3) * C + C / 2;
        const cy = BY + Math.floor(i / 3) * C + C / 2;
        const r = C * 0.28;
        if (board[i] === 'X') {
          ctx.strokeStyle = '#5ad0ff';
          ctx.beginPath();
          ctx.moveTo(X(cx - r), Y(cy - r)); ctx.lineTo(X(cx + r), Y(cy + r));
          ctx.moveTo(X(cx + r), Y(cy - r)); ctx.lineTo(X(cx - r), Y(cy + r));
          ctx.stroke();
        } else {
          ctx.strokeStyle = '#ffb04f';
          ctx.beginPath();
          ctx.arc(X(cx), Y(cy), S(r), 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Strike through the winning line
      if (winLine) {
        const c0 = winLine[0], c2 = winLine[2];
        const p0 = [BX + (c0 % 3) * C + C / 2, BY + Math.floor(c0 / 3) * C + C / 2];
        const p2 = [BX + (c2 % 3) * C + C / 2, BY + Math.floor(c2 / 3) * C + C / 2];
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(3, S(0.014));
        const blinkOn = Math.floor(now / 200) % 2 === 0;
        if (blinkOn) {
          ctx.beginPath();
          ctx.moveTo(X(p0[0]), Y(p0[1]));
          ctx.lineTo(X(p2[0]), Y(p2[1]));
          ctx.stroke();
        }
      }
    },

    status() {
      if (roundOver) return null;
      const me = A.state.solo ? 'host' : myRole();
      if (turnRole === me) return 'YOUR TURN: TAP A SQUARE';
      return A.state.solo ? 'THE MACHINE IS THINKING...' : "RIVAL'S TURN...";
    }
  });

  // Exposed for automated tests; not part of the game logic
  A.state.tttDebug = () => ({
    board: board.slice(), round, turnRole, roundOver,
    myMark: markOf(A.state.solo ? 'host' : myRole())
  });
})();
