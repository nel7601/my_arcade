/*
 * TETRIS (1984) - line duel.
 *
 * Every cleared line is a point. Clear 2+ lines at once and the extra
 * ones land as garbage rows (with one hole) at the bottom of your
 * rival's well. Topping out clears your well but keeps your score.
 *
 * Touch: drag sideways to move, tap to rotate, swipe down to drop.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { PLAY_H, X, Y, S, ctx } = A;

  const COLS = 10, ROWS = 16;
  const CELL = PLAY_H / ROWS;         // 0.08
  const X0 = (1 - COLS * CELL) / 2;   // center the well

  // Each shape lives in a size*size box; rotation is (x,y) -> (size-1-y, x)
  const SHAPES = [
    { size: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] }, // I
    { size: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] }, // O
    { size: 3, cells: [[0, 1], [1, 1], [2, 1], [1, 0]] }, // T
    { size: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] }, // S
    { size: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] }, // Z
    { size: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] }, // J
    { size: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] }  // L
  ];

  let board = [];        // board[r][c] = true when filled
  let cur = null;        // {shape, rot, col, row}
  let dropTimer = 0;
  let dropEvery = 0.8;
  let linesTotal = 0;
  let pendingGarbage = 0;
  let touch = null;

  const emptyBoard = () => Array.from({ length: ROWS }, () => Array(COLS).fill(false));

  function cellsOf(piece) {
    const { shape, rot } = piece;
    let cells = SHAPES[shape].cells;
    const n = SHAPES[shape].size;
    for (let i = 0; i < rot; i++) {
      cells = cells.map(([x, y]) => [n - 1 - y, x]);
    }
    return cells.map(([x, y]) => [x + piece.col, y + piece.row]);
  }

  function collides(piece) {
    for (const [c, r] of cellsOf(piece)) {
      if (c < 0 || c >= COLS || r >= ROWS) return true;
      if (r >= 0 && board[r][c]) return true;
    }
    return false;
  }

  function spawn() {
    cur = { shape: Math.floor(Math.random() * SHAPES.length), rot: 0, col: 3, row: -1 };
    if (collides(cur)) {
      board = emptyBoard(); // topped out: mercy clear, score stays
      A.flash('TOPPED OUT');
      A.sndScore();
    }
  }

  function addGarbage(n) {
    for (let i = 0; i < n; i++) {
      board.shift();
      const row = Array(COLS).fill(true);
      row[Math.floor(Math.random() * COLS)] = false;
      board.push(row);
    }
    A.sndWall();
  }

  function lock() {
    for (const [c, r] of cellsOf(cur)) {
      if (r >= 0) board[r][c] = true;
    }
    // Clear full lines
    let cleared = 0;
    board = board.filter(row => {
      if (row.every(Boolean)) { cleared += 1; return false; }
      return true;
    });
    while (board.length < ROWS) board.unshift(Array(COLS).fill(false));

    if (cleared > 0) {
      linesTotal += cleared;
      dropEvery = Math.max(0.3, 0.8 - linesTotal * 0.015);
      A.sndPaddle();
      A.addScore(cleared);
      if (cleared > 1) {
        A.send({ type: 'attack', n: cleared - 1 });
        A.flash('GARBAGE SENT!');
      }
    }
    if (pendingGarbage > 0) {
      addGarbage(pendingGarbage);
      pendingGarbage = 0;
    }
    spawn();
  }

  function tryMove(dc, dr) {
    const test = { ...cur, col: cur.col + dc, row: cur.row + dr };
    if (!collides(test)) {
      cur = test;
      return true;
    }
    return false;
  }

  function rotate() {
    const test = { ...cur, rot: (cur.rot + 1) % 4 };
    for (const kick of [0, -1, 1, -2, 2]) {
      const t2 = { ...test, col: test.col + kick };
      if (!collides(t2)) {
        cur = t2;
        A.beep(660, 0.03);
        return;
      }
    }
  }

  A.register({
    game: 'tetris',
    title: 'TETRIS',
    solo: true,

    onStart() {
      board = emptyBoard();
      linesTotal = 0;
      dropEvery = 0.8;
      pendingGarbage = 0;
      spawn();
    },

    onResume() {
      board = emptyBoard();
      pendingGarbage = 0;
      spawn();
    },

    onMessage(msg) {
      if (msg.type === 'attack') {
        // Garbage waits politely until the current piece locks
        pendingGarbage = Math.min(6, pendingGarbage + (Number(msg.n) || 1));
        A.flash('GARBAGE INCOMING!');
      }
    },

    onPointer(phase, x, y) {
      if (!cur) return;
      if (phase === 'down') {
        touch = { x, y, col0: cur.col, moved: false, t: performance.now() };
        return;
      }
      if (!touch) return;
      if (phase === 'move') {
        const dcol = Math.round((x - touch.x) / CELL);
        if (dcol !== cur.col - touch.col0) {
          const step = Math.sign(dcol - (cur.col - touch.col0));
          if (tryMove(step, 0)) touch.moved = true;
        }
        return;
      }
      // up
      const dy = y - touch.y;
      const dtms = performance.now() - touch.t;
      if (dy > 0.15 && dtms < 500) {
        while (tryMove(0, 1)) { /* hard drop */ }
        lock();
        A.beep(330, 0.05);
      } else if (!touch.moved && Math.abs(dy) < 0.05 && dtms < 350) {
        rotate();
      }
      touch = null;
    },

    step(dt) {
      if (!cur) return;
      dropTimer += dt;
      if (dropTimer >= dropEvery) {
        dropTimer = 0;
        if (!tryMove(0, 1)) lock();
      }
    },

    draw() {
      // Well borders
      ctx.globalAlpha = 0.4;
      ctx.fillRect(X(X0) - 2, Y(0), 2, S(PLAY_H));
      ctx.fillRect(X(X0 + COLS * CELL), Y(0), 2, S(PLAY_H));
      ctx.globalAlpha = 1;

      const px = S(CELL);
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (board[r][c]) {
            ctx.fillRect(X(X0 + c * CELL) + 1, Y(r * CELL) + 1, px - 2, px - 2);
          }
        }
      }
      if (cur) {
        for (const [c, r] of cellsOf(cur)) {
          if (r >= 0) {
            ctx.fillRect(X(X0 + c * CELL) + 1, Y(r * CELL) + 1, px - 2, px - 2);
          }
        }
      }
    }
  });
})();
