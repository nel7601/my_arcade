/*
 * CHECKERS - English draughts, captures on the clock.
 *
 * The full classic: 8x8 board, 12 men each, diagonal moves on the dark
 * squares, FORCED captures, mandatory multi-jumps, and kings crowned on
 * the far row (crowning ends a jump chain). Each phone sees its own
 * pieces at the bottom - the board is the same, just rotated.
 *
 * Scoring fits the arcade clock: every captured piece is a point.
 * Leaving the rival without moves (or pieces) pays a 2-point bonus and
 * ends the match early; otherwise the clock decides by captures.
 *
 * Tap a piece to see its moves, tap a dot to play. Both phones replay
 * every move, so the boards stay identical.
 *
 * Solo mode: an AI that never hangs a piece one move deep.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { X, Y, S, ctx } = A;

  const N = 8;
  const C = 0.115;
  const BX = (1 - N * C) / 2;   // 0.04
  const BY = 0.18;

  const BLUE = '#5ad0ff', ORANGE = '#ffb04f';
  const DIAG4 = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const UP2 = [[-1, -1], [-1, 1]];      // host men move up the board
  const DOWN2 = [[1, -1], [1, 1]];      // guest men move down

  let board = [];                // 64 cells: 'h','H','g','G' or null
  let turnRole = 'host';
  let chain = -1;                // piece mid multi-jump (abs index) or -1
  let sel = null;                // my selected piece (abs index)
  let gameOver = false;
  let doneAt = 0;
  let aiAt = 0;
  let nextPoke = Infinity;
  let anim = null;               // {to, from, born, dur} sliding piece
  let fading = null;             // {i, v, born} captured piece fading out

  const myRole = () => A.state.role;
  const foe = (r) => (r === 'host' ? 'guest' : 'host');
  const ownerOf = (v) => (v === 'h' || v === 'H' ? 'host' : 'guest');
  const rowOf = (i) => Math.floor(i / N);
  const colOf = (i) => i % N;

  function initBoard() {
    board = Array(N * N).fill(null);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < N; c++) if ((c + r) % 2 === 1) board[c + r * N] = 'g';
    }
    for (let r = 5; r < N; r++) {
      for (let c = 0; c < N; c++) if ((c + r) % 2 === 1) board[c + r * N] = 'h';
    }
  }

  // ---- Move generation (pure, so the AI can look ahead on copies) -----------

  const dirsOf = (v) => (v === 'H' || v === 'G') ? DIAG4 : (v === 'h' ? UP2 : DOWN2);

  function jumpsFrom(bd, i) {
    const v = bd[i];
    if (!v) return [];
    const out = [];
    for (const [dr, dc] of dirsOf(v)) {
      const mr = rowOf(i) + dr, mc = colOf(i) + dc;
      const tr = rowOf(i) + 2 * dr, tc = colOf(i) + 2 * dc;
      if (tr < 0 || tr >= N || tc < 0 || tc >= N) continue;
      const over = mc + mr * N, to = tc + tr * N;
      if (bd[over] && ownerOf(bd[over]) !== ownerOf(v) && bd[to] === null) {
        out.push({ from: i, to, over });
      }
    }
    return out;
  }

  function stepsFrom(bd, i) {
    const v = bd[i];
    if (!v) return [];
    const out = [];
    for (const [dr, dc] of dirsOf(v)) {
      const tr = rowOf(i) + dr, tc = colOf(i) + dc;
      if (tr < 0 || tr >= N || tc < 0 || tc >= N) continue;
      const to = tc + tr * N;
      if (bd[to] === null) out.push({ from: i, to, over: null });
    }
    return out;
  }

  // Forced captures: if any jump exists, only jumps are legal.
  // Mid multi-jump, only the chained piece may (and must) keep jumping.
  function legalMoves(bd, role, chainAt) {
    if (chainAt >= 0) return jumpsFrom(bd, chainAt);
    const caps = [], steps = [];
    for (let i = 0; i < bd.length; i++) {
      if (!bd[i] || ownerOf(bd[i]) !== role) continue;
      caps.push(...jumpsFrom(bd, i));
      if (!caps.length) steps.push(...stepsFrom(bd, i));
    }
    return caps.length ? caps : steps;
  }

  // Mutates bd; crowning ends a jump chain (English rule)
  function execMove(bd, m) {
    const v = bd[m.from];
    bd[m.from] = null;
    const promoted = (v === 'h' && rowOf(m.to) === 0) || (v === 'g' && rowOf(m.to) === N - 1);
    bd[m.to] = promoted ? v.toUpperCase() : v;
    if (m.over !== null) bd[m.over] = null;
    const chained = m.over !== null && !promoted && jumpsFrom(bd, m.to).length > 0;
    return { captured: m.over !== null, chained };
  }

  // ---- Match logic (replayed identically on both phones) --------------------

  function applyMove(role, from, to) {
    if (gameOver || role !== turnRole) return false;
    const m = legalMoves(board, role, chain).find(x => x.from === from && x.to === to);
    if (!m) return false;

    // Remember what to animate before the move mutates the board
    const overV = m.over !== null ? board[m.over] : null;
    const fx = execMove(board, m);
    anim = {
      to: m.to, from: m.from, born: performance.now(),
      dur: m.over !== null ? 260 : 180
    };
    if (m.over !== null) fading = { i: m.over, v: overV, born: performance.now() };
    A.beep(role === myRole() ? 459 : 320, 0.04);
    if (fx.captured && role === myRole()) {
      A.addScore(1);
      A.sndScore();
    }

    if (fx.chained) {
      chain = m.to;               // same player, same piece, keep jumping
      if (role === myRole()) sel = m.to;
    } else {
      chain = -1;
      turnRole = foe(role);
      if (role === myRole()) sel = null;
      aiAt = performance.now() + 850;
      // No moves (or no pieces) left for the next player: mover wins
      if (!legalMoves(board, turnRole, -1).length) {
        gameOver = true;
        doneAt = performance.now() + 1500;
        if (role === myRole()) {
          A.addScore(2);
          A.flash('RIVAL HAS NO MOVES: +2!');
          A.sndScore();
        } else {
          A.flash('NO MOVES LEFT - YOU LOSE');
          A.beep(120, 0.3);
        }
      }
    }
    return true;
  }

  function myMove(from, to) {
    if (A.state.phase !== 'playing') return;
    if (applyMove(myRole(), from, to)) A.send({ type: 'move', from, to });
  }

  // ---- Solo AI: forced captures first, then never hang a piece --------------

  function aiPick() {
    const moves = legalMoves(board, 'guest', chain);
    if (!moves.length) return null;
    let best = [], bestRisk = Infinity;
    for (const m of moves) {
      const bd = board.slice();
      const fx = execMove(bd, m);
      // Risk: pieces the host could take right after (chains count double)
      let risk = 0;
      if (!fx.chained) {
        for (const hm of legalMoves(bd, 'host', -1)) {
          if (hm.over !== null) risk += bd[hm.over] === 'G' ? 3 : 2;
        }
      }
      const gain = (m.over !== null ? 2 : 0) + (fx.chained ? 2 : 0);
      const score = risk - gain;
      if (score < bestRisk) { bestRisk = score; best = [m]; }
      else if (score === bestRisk) best.push(m);
    }
    return best[Math.floor(Math.random() * best.length)];
  }

  // ---- Registration ----------------------------------------------------------

  A.register({
    game: 'checkers',
    title: 'CHECKERS',
    solo: true,

    onStart() {
      initBoard();
      turnRole = 'host';
      chain = -1;
      sel = null;
      anim = null;
      fading = null;
      gameOver = false;
      aiAt = performance.now() + 1000;
      nextPoke = Infinity;
    },

    onResume() {
      // A reload lost the board: ask the rival for it
      initBoard();
      turnRole = 'host';
      chain = -1;
      sel = null;
      gameOver = false;
      A.send({ type: 'state_req' });
      nextPoke = performance.now() + 3000;
    },

    onMessage(msg) {
      switch (msg.type) {
        case 'move':
          applyMove(foe(myRole()), Number(msg.from), Number(msg.to));
          break;

        case 'state_req':
          A.send({ type: 'state', board, turnRole, chain });
          break;

        case 'state':
          board = msg.board.map(v => (['h', 'H', 'g', 'G'].includes(v) ? v : null));
          turnRole = msg.turnRole === 'guest' ? 'guest' : 'host';
          chain = Number.isInteger(msg.chain) ? msg.chain : -1;
          sel = null;
          anim = null;
          fading = null;
          gameOver = !legalMoves(board, turnRole, chain).length;
          nextPoke = Infinity;
          break;
      }
    },

    onPointer(ph, x, y) {
      if (ph !== 'down' || gameOver || A.state.phase !== 'playing') return;
      const flip = !A.state.solo && myRole() === 'guest';
      let c = Math.floor((x - BX) / C);
      let r = Math.floor((y - BY) / C);
      if (c < 0 || c >= N || r < 0 || r >= N) return;
      if (flip) { c = N - 1 - c; r = N - 1 - r; }
      const i = c + r * N;

      const me = A.state.solo ? 'host' : myRole();
      if (turnRole !== me) return;
      const moves = legalMoves(board, me, chain);
      if (sel !== null && moves.some(m => m.from === sel && m.to === i)) {
        myMove(sel, i);
        return;
      }
      // Select a piece that actually has a legal move right now
      if (board[i] && ownerOf(board[i]) === me && moves.some(m => m.from === i)) {
        sel = i;
        A.beep(500, 0.03);
      } else if (chain < 0) {
        sel = null;
      }
    },

    step(dt, now) {
      if (now > nextPoke) {
        nextPoke = now + 3000;
        A.send({ type: 'state_req' });
      }
      // The referee blows the early whistle once someone is out of moves
      if (gameOver && now > doneAt && (A.state.solo || A.state.role === 'host') &&
          (A.state.timeLeft === null || A.state.timeLeft > 0.1)) {
        A.state.timeLeft = 0.01;
      }
      if (A.state.solo && !gameOver && turnRole === 'guest' && now > aiAt) {
        const m = aiPick();
        if (m) applyMove('guest', m.from, m.to);
        aiAt = now + 850;
      }
    },

    draw(now, color) {
      const me = A.state.solo ? 'host' : myRole();
      const flip = !A.state.solo && myRole() === 'guest';
      const V = (i) => { // absolute index -> view cell [c,r]
        const c = colOf(i), r = rowOf(i);
        return flip ? [N - 1 - c, N - 1 - r] : [c, r];
      };

      // Header: whose turn it is (your color lives in the status line below)
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.font = `bold ${Math.round(S(0.036))}px "Courier New", monospace`;
      if (!gameOver) {
        let head;
        if (turnRole !== me) {
          head = A.state.solo ? 'THE MACHINE IS THINKING...' : "RIVAL'S TURN...";
        } else if (chain >= 0) {
          head = 'KEEP JUMPING!';
        } else if (legalMoves(board, me, -1).some(m => m.over !== null)) {
          head = 'CAPTURE IS FORCED: TAP THE BIG DOT';
        } else {
          head = 'YOUR TURN: TAP A PIECE, THEN A DOT';
        }
        ctx.fillText(head, X(0.5), Y(0.1));
      }

      // Board squares: dark squares get a faint fill
      for (let i = 0; i < N * N; i++) {
        const [vc, vr] = V(i);
        const dark = (colOf(i) + rowOf(i)) % 2 === 1;
        if (dark) {
          ctx.fillStyle = '#1a2430';
          ctx.fillRect(X(BX + vc * C), Y(BY + vr * C), S(C), S(C));
        }
      }
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 1;
      ctx.strokeRect(X(BX), Y(BY), S(N * C), S(N * C));
      ctx.globalAlpha = 1;

      // Legal-move dots for my selected piece
      const moves = (!gameOver && turnRole === me) ? legalMoves(board, me, chain) : [];
      if (sel !== null) {
        for (const m of moves) {
          if (m.from !== sel) continue;
          const [vc, vr] = V(m.to);
          ctx.fillStyle = color;
          ctx.globalAlpha = Math.floor(now / 300) % 2 === 0 ? 0.9 : 0.4;
          ctx.beginPath();
          ctx.arc(X(BX + (vc + 0.5) * C), Y(BY + (vr + 0.5) * C),
            S(m.over !== null ? 0.024 : 0.015), 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      // One piece, at any position (cx,cy in court units)
      const drawPiece = (v, cx, cy) => {
        ctx.fillStyle = ownerOf(v) === 'host' ? BLUE : ORANGE;
        ctx.beginPath();
        ctx.arc(X(cx), Y(cy), S(C * 0.36), 0, Math.PI * 2);
        ctx.fill();
        if (v === 'H' || v === 'G') {
          ctx.strokeStyle = '#000';
          ctx.lineWidth = Math.max(2, S(0.008));
          ctx.beginPath();
          ctx.arc(X(cx), Y(cy), S(C * 0.2), 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = '#000';
          ctx.beginPath();
          ctx.arc(X(cx), Y(cy), S(C * 0.07), 0, Math.PI * 2);
          ctx.fill();
        }
      };
      const center = (i) => {
        const [vc, vr] = V(i);
        return [BX + (vc + 0.5) * C, BY + (vr + 0.5) * C];
      };

      // A captured piece fades away where it stood
      if (fading) {
        const t = (now - fading.born) / 320;
        if (t >= 1) {
          fading = null;
        } else {
          ctx.globalAlpha = 1 - t;
          drawPiece(fading.v, ...center(fading.i));
          ctx.globalAlpha = 1;
        }
      }

      // Pieces (the freshest one slides from its old square)
      for (let i = 0; i < N * N; i++) {
        if (!board[i]) continue;
        let [cx, cy] = center(i);
        if (anim && anim.to === i) {
          const t = Math.min(1, (now - anim.born) / anim.dur);
          if (t >= 1) {
            anim = null;
          } else {
            const e = 1 - (1 - t) * (1 - t); // ease-out
            const [fx0, fy0] = center(anim.from);
            cx = fx0 + (cx - fx0) * e;
            cy = fy0 + (cy - fy0) * e;
          }
        }
        drawPiece(board[i], cx, cy);
        // Selected piece / chained piece: blinking ring
        if ((sel === i || (chain === i && turnRole === me)) &&
            !(anim && anim.to === i) && Math.floor(now / 250) % 2 === 0) {
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(2, S(0.01));
          ctx.beginPath();
          ctx.arc(X(cx), Y(cy), S(C * 0.44), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    },

    status() {
      if (gameOver) return null;
      const me = A.state.solo ? 'host' : myRole();
      return 'YOU PLAY ' + (me === 'host' ? 'BLUE' : 'ORANGE');
    }
  });

  // Exposed for automated tests; not part of the game logic
  const count = (role) => board.filter(v => v && ownerOf(v) === role).length;
  A.state.ckDebug = () => ({
    board: board.slice(), turnRole, chain, gameOver,
    counts: { host: count('host'), guest: count('guest') },
    moves: gameOver ? [] : legalMoves(board, turnRole, chain),
    myColor: (A.state.solo ? 'host' : myRole())
  });
  A.state.ckSet = (bd, t, ch) => {
    board = bd.map(v => (['h', 'H', 'g', 'G'].includes(v) ? v : null));
    turnRole = t === 'guest' ? 'guest' : 'host';
    chain = Number.isInteger(ch) ? ch : -1;
    sel = null;
    anim = null;
    fading = null;
    gameOver = false;
  };
})();
