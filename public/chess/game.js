/*
 * CHESS - the royal game, one phone per side.
 *
 * Full legal chess: every piece move is checked against the rules
 * (you can never leave your own king in check), with castling on both
 * wings, en passant, and pawns promoting straight to queens. Checkmate
 * wins the match on the spot; stalemate is a draw. There is NO clock -
 * like PARCHEESI, the game takes as long as it takes.
 *
 * BLUE (host) plays the white side and moves first; ORANGE (guest)
 * plays black. Each phone sees its own pieces at the bottom. Tap a
 * piece to see its legal moves, tap a dot to play; every move is
 * replayed on both phones. Captured pieces line up under the board.
 *
 * Solo mode: a CPU that looks one exchange ahead - it takes material,
 * avoids hanging pieces and goes for mate when it sees it.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { X, Y, S, ctx } = A;

  const N = 8;
  const C = 0.115;
  const BX = (1 - N * C) / 2;
  const BY = 0.16;

  const BLUE = '#5ad0ff', ORANGE = '#ffb04f';
  const GLYPH = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
  const VAL = { p: 1, n: 3, b: 3.2, r: 5, q: 9, k: 100 };

  // Pieces are two-char strings: type + owner ('qh' = host queen)
  let board = [];
  let turn = 'host';
  let st = { cr: { hk: true, hq: true, gk: true, gq: true }, ep: null };
  let captured = { host: [], guest: [] }; // piece types captured BY each role
  let sel = null;
  let gameOver = false;
  let winner = null;      // role | 'draw'
  let doneAt = 0;
  let anim = null;        // {to, from, born, dur}
  let fading = null;      // {i, v, born}
  let aiAt = 0;
  let nextPoke = Infinity;

  const myRole = () => (A.state.solo ? 'host' : A.state.role);
  const foe = (r) => (r === 'host' ? 'guest' : 'host');
  const ownerOf = (v) => (v[1] === 'h' ? 'host' : 'guest');
  const colOf = (i) => i % 8;
  const rowOf = (i) => (i / 8) | 0;

  function initBoard() {
    board = Array(64).fill(null);
    const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
    for (let c = 0; c < 8; c++) {
      board[c] = back[c] + 'g';
      board[c + 8] = 'pg';
      board[c + 48] = 'ph';
      board[c + 56] = back[c] + 'h';
    }
    st = { cr: { hk: true, hq: true, gk: true, gq: true }, ep: null };
  }

  // ---- Move generation (pure, on any board copy) -----------------------------

  const KN = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KK = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function pseudoFrom(bd, i, epSq) {
    const v = bd[i];
    if (!v) return [];
    const role = ownerOf(v), t = v[0];
    const c = colOf(i), r = rowOf(i);
    const out = [];
    const step = (dirs, slide) => {
      for (const [dc, dr] of dirs) {
        let cc = c + dc, rr = r + dr;
        while (cc >= 0 && cc < 8 && rr >= 0 && rr < 8) {
          const j = cc + rr * 8;
          if (!bd[j]) out.push({ from: i, to: j });
          else { if (ownerOf(bd[j]) !== role) out.push({ from: i, to: j }); break; }
          if (!slide) break;
          cc += dc; rr += dr;
        }
      }
    };
    if (t === 'p') {
      const dr = role === 'host' ? -1 : 1;
      const start = role === 'host' ? 6 : 1;
      if (r + dr >= 0 && r + dr < 8 && !bd[c + (r + dr) * 8]) {
        out.push({ from: i, to: c + (r + dr) * 8 });
        if (r === start && !bd[c + (r + 2 * dr) * 8]) {
          out.push({ from: i, to: c + (r + 2 * dr) * 8 });
        }
      }
      for (const dc of [-1, 1]) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || cc > 7 || rr < 0 || rr > 7) continue;
        const j = cc + rr * 8;
        if ((bd[j] && ownerOf(bd[j]) !== role) || j === epSq) out.push({ from: i, to: j });
      }
    } else if (t === 'n') step(KN, false);
    else if (t === 'k') step(KK, false);
    else if (t === 'b') step(DIAG, true);
    else if (t === 'r') step(ORTH, true);
    else step(DIAG.concat(ORTH), true);
    return out;
  }

  function attacksSq(bd, sq, by) {
    const tc = colOf(sq), tr = rowOf(sq);
    for (let i = 0; i < 64; i++) {
      const v = bd[i];
      if (!v || ownerOf(v) !== by) continue;
      const t = v[0];
      const dc = tc - colOf(i), dr = tr - rowOf(i);
      if (t === 'p') {
        if (dr === (by === 'host' ? -1 : 1) && Math.abs(dc) === 1) return true;
        continue;
      }
      if (t === 'n') {
        if ((Math.abs(dc) === 1 && Math.abs(dr) === 2) ||
            (Math.abs(dc) === 2 && Math.abs(dr) === 1)) return true;
        continue;
      }
      if (t === 'k') {
        if (Math.max(Math.abs(dc), Math.abs(dr)) === 1) return true;
        continue;
      }
      const diag = Math.abs(dc) === Math.abs(dr) && dc !== 0;
      const orth = (dc === 0) !== (dr === 0);
      if (t === 'b' && !diag) continue;
      if (t === 'r' && !orth) continue;
      if (t === 'q' && !diag && !orth) continue;
      const sc = Math.sign(dc), sr = Math.sign(dr);
      let cc = colOf(i) + sc, rr = rowOf(i) + sr, clear = true;
      while (cc !== tc || rr !== tr) {
        if (bd[cc + rr * 8]) { clear = false; break; }
        cc += sc; rr += sr;
      }
      if (clear) return true;
    }
    return false;
  }

  function kingSq(bd, role) {
    const k = 'k' + role[0];
    for (let i = 0; i < 64; i++) if (bd[i] === k) return i;
    return -1;
  }

  const inCheckOn = (bd, role) => attacksSq(bd, kingSq(bd, role), foe(role));

  // Executes m on bd, updating rights/ep in stt; returns the captured piece
  function execOn(bd, stt, m) {
    const v = bd[m.from];
    const role = ownerOf(v), t = v[0];
    const fc = colOf(m.from), fr = rowOf(m.from);
    const tc = colOf(m.to), tr = rowOf(m.to);
    let cap = bd[m.to];
    if (t === 'p' && tc !== fc && !cap) { // en passant
      cap = bd[tc + fr * 8];
      bd[tc + fr * 8] = null;
    }
    bd[m.to] = v;
    bd[m.from] = null;
    if (t === 'p' && (tr === 0 || tr === 7)) bd[m.to] = 'q' + v[1]; // auto-queen
    if (t === 'k' && Math.abs(tc - fc) === 2) { // castling moves the rook too
      const h = fr * 8;
      if (tc === 6) { bd[h + 5] = bd[h + 7]; bd[h + 7] = null; }
      else { bd[h + 3] = bd[h]; bd[h] = null; }
    }
    if (t === 'k') {
      if (role === 'host') { stt.cr.hk = false; stt.cr.hq = false; }
      else { stt.cr.gk = false; stt.cr.gq = false; }
    }
    for (const [sq, key] of [[63, 'hk'], [56, 'hq'], [7, 'gk'], [0, 'gq']]) {
      if (m.from === sq || m.to === sq) stt.cr[key] = false;
    }
    stt.ep = (t === 'p' && Math.abs(tr - fr) === 2) ? (fc + ((fr + tr) / 2) * 8) : null;
    return cap;
  }

  function castleCands(bd, role, stt) {
    const out = [];
    const home = role === 'host' ? 7 : 0;
    const K = 4 + home * 8;
    if (bd[K] !== 'k' + role[0] || attacksSq(bd, K, foe(role))) return out;
    const kf = role === 'host' ? stt.cr.hk : stt.cr.gk;
    const qf = role === 'host' ? stt.cr.hq : stt.cr.gq;
    if (kf && !bd[K + 1] && !bd[K + 2] && bd[home * 8 + 7] === 'r' + role[0] &&
        !attacksSq(bd, K + 1, foe(role)) && !attacksSq(bd, K + 2, foe(role))) {
      out.push({ from: K, to: K + 2 });
    }
    if (qf && !bd[K - 1] && !bd[K - 2] && !bd[K - 3] && bd[home * 8] === 'r' + role[0] &&
        !attacksSq(bd, K - 1, foe(role)) && !attacksSq(bd, K - 2, foe(role))) {
      out.push({ from: K, to: K - 2 });
    }
    return out;
  }

  // Every move that does not leave your own king in check
  function allLegal(bd, role, stt) {
    const cands = [];
    for (let i = 0; i < 64; i++) {
      if (bd[i] && ownerOf(bd[i]) === role) cands.push(...pseudoFrom(bd, i, stt.ep));
    }
    cands.push(...castleCands(bd, role, stt));
    return cands.filter(m => {
      const b2 = bd.slice();
      const s2 = { cr: { ...stt.cr }, ep: stt.ep };
      execOn(b2, s2, m);
      return !inCheckOn(b2, role);
    });
  }

  // ---- Match logic (replayed identically on both phones) ---------------------

  function applyMove(role, from, to) {
    if (gameOver || role !== turn) return false;
    const m = allLegal(board, role, st).find(x => x.from === from && x.to === to);
    if (!m) return false;

    const capV = board[m.to] ||
      (board[m.from][0] === 'p' && colOf(to) !== colOf(from) ? board[colOf(to) + rowOf(from) * 8] : null);
    const cap = execOn(board, st, m);
    anim = { to: m.to, from: m.from, born: performance.now(), dur: 200 };
    if (cap) {
      captured[role].push(cap[0]);
      fading = { i: m.to === from ? to : m.to, v: capV || cap, born: performance.now() };
      // Captures score material points, so a TIMED match has a leader
      const pts = Math.floor(VAL[cap[0]]) || 1;
      if (role === myRole()) A.addScore(pts);
      else if (A.state.solo) A.state.score.opp += pts;
      A.beep(160, 0.12);
    } else {
      A.beep(role === myRole() ? 459 : 320, 0.04);
    }
    if (role === myRole()) sel = null;

    const opp = foe(role);
    const oppMoves = allLegal(board, opp, st);
    if (!oppMoves.length) {
      gameOver = true;
      doneAt = performance.now() + 1800;
      if (inCheckOn(board, opp)) {
        winner = role;
        if (role === myRole()) {
          A.addScore(50); // mate outweighs any material count
          A.flash('CHECKMATE - YOU WIN!');
          A.sndScore();
        } else {
          if (A.state.solo) A.state.score.opp += 50;
          A.flash('CHECKMATE - YOU LOSE');
          A.beep(120, 0.35);
        }
      } else {
        winner = 'draw';
        // A stalemate is a DRAW whatever the material says: even out
        // the scoreboard (both phones run this same line)
        const mx = Math.max(A.state.score.me, A.state.score.opp);
        A.state.score.me = mx;
        A.state.score.opp = mx;
        A.flash('STALEMATE - DRAW');
      }
    } else {
      turn = opp;
      if (inCheckOn(board, opp)) {
        A.flash('CHECK!');
        A.beep(700, 0.08);
      }
      aiAt = performance.now() + 1000;
    }
    return true;
  }

  function myMove(from, to) {
    if (A.state.phase !== 'playing') return false;
    if (applyMove(myRole(), from, to)) {
      A.send({ type: 'move', from, to });
      return true;
    }
    return false;
  }

  // ---- Solo CPU: material with a one-exchange lookahead -----------------------

  function material(bd, role) {
    let m = 0;
    for (const v of bd) {
      if (!v) continue;
      m += (ownerOf(v) === role ? 1 : -1) * VAL[v[0]];
    }
    return m;
  }

  function aiPick() {
    const moves = allLegal(board, 'guest', st);
    if (!moves.length) return null;
    let best = null, bestScore = -Infinity;
    for (const m of moves) {
      const b2 = board.slice();
      const s2 = { cr: { ...st.cr }, ep: st.ep };
      execOn(b2, s2, m);
      const replies = allLegal(b2, 'host', s2);
      let score;
      if (!replies.length) {
        score = inCheckOn(b2, 'host') ? 9999 : -5; // mate or stalemate
      } else {
        // Assume the rival makes its best material reply
        let worst = Infinity;
        for (const r of replies) {
          const b3 = b2.slice();
          const s3 = { cr: { ...s2.cr }, ep: s2.ep };
          execOn(b3, s3, r);
          const mat = material(b3, 'guest');
          if (mat < worst) worst = mat;
        }
        score = worst;
        const tc = colOf(m.to), tr = rowOf(m.to);
        score += (3.5 - Math.abs(tc - 3.5)) * 0.03 + (3.5 - Math.abs(tr - 3.5)) * 0.03;
      }
      score += Math.random() * 0.05;
      if (score > bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  // ---- Registration ------------------------------------------------------------

  A.register({
    game: 'chess',
    title: 'CHESS',
    solo: true,
    soloVersus: true,  // the CPU is a real rival on the scoreboard

    onStart() {
      initBoard();
      turn = 'host';
      captured = { host: [], guest: [] };
      sel = null;
      gameOver = false;
      winner = null;
      anim = null;
      fading = null;
      aiAt = performance.now() + 1200;
      nextPoke = Infinity;
    },

    onResume() {
      initBoard();
      turn = 'host';
      captured = { host: [], guest: [] };
      sel = null;
      gameOver = false;
      winner = null;
      A.send({ type: 'state_req' });
      nextPoke = performance.now() + 3000;
    },

    onMessage(msg) {
      switch (msg.type) {
        case 'move':
          applyMove(foe(myRole()), Number(msg.from), Number(msg.to));
          break;

        case 'state_req':
          A.send({
            type: 'state', board, turn,
            cr: st.cr, ep: st.ep, captured
          });
          break;

        case 'state':
          board = msg.board.map(v => (typeof v === 'string' && v.length === 2 ? v : null));
          turn = msg.turn === 'guest' ? 'guest' : 'host';
          st = {
            cr: {
              hk: !!msg.cr.hk, hq: !!msg.cr.hq,
              gk: !!msg.cr.gk, gq: !!msg.cr.gq
            },
            ep: Number.isInteger(msg.ep) ? msg.ep : null
          };
          captured = {
            host: (msg.captured.host || []).filter(t => VAL[t]),
            guest: (msg.captured.guest || []).filter(t => VAL[t])
          };
          sel = null;
          anim = null;
          fading = null;
          gameOver = !allLegal(board, turn, st).length;
          winner = gameOver ? (inCheckOn(board, turn) ? foe(turn) : 'draw') : null;
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

      const me = myRole();
      if (turn !== me) return;
      const moves = allLegal(board, me, st);
      if (sel !== null && moves.some(m => m.from === sel && m.to === i)) {
        myMove(sel, i);
        return;
      }
      if (board[i] && ownerOf(board[i]) === me && moves.some(m => m.from === i)) {
        sel = i;
        A.beep(500, 0.03);
      } else {
        sel = null;
      }
    },

    step(dt, now) {
      if (now > nextPoke) {
        nextPoke = now + 3000;
        A.send({ type: 'state_req' });
      }
      // The whistle: untimed match ends shortly after mate or stalemate
      if (gameOver && now > doneAt && (A.state.solo || A.state.role === 'host') &&
          (A.state.timeLeft === null || A.state.timeLeft > 0.1)) {
        A.state.timeLeft = 0.01;
      }
      if (A.state.solo && !gameOver && turn === 'guest' && now > aiAt) {
        const m = aiPick();
        if (m) applyMove('guest', m.from, m.to);
        aiAt = now + 1000;
      }
    },

    draw(now, color) {
      const me = myRole();
      const flip = !A.state.solo && me === 'guest';
      const V = (i) => {
        const c = colOf(i), r = rowOf(i);
        return flip ? [N - 1 - c, N - 1 - r] : [c, r];
      };
      const center = (i) => {
        const [vc, vr] = V(i);
        return [BX + (vc + 0.5) * C, BY + (vr + 0.5) * C];
      };

      // Header: whose turn / check state
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.font = `bold ${Math.round(S(0.036))}px "Courier New", monospace`;
      if (!gameOver) {
        const inChk = inCheckOn(board, turn);
        let head;
        if (turn === me) head = inChk ? 'CHECK ON YOU - GET OUT!' : 'YOUR TURN';
        else head = (A.state.solo ? 'THE CPU IS THINKING...' : "RIVAL'S TURN...") + (inChk ? ' (IN CHECK)' : '');
        ctx.fillText(head, X(0.5), Y(0.1));
      }

      // Board squares
      for (let i = 0; i < 64; i++) {
        const [vc, vr] = V(i);
        if ((colOf(i) + rowOf(i)) % 2 === 1) {
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
      const moves = (!gameOver && turn === me) ? allLegal(board, me, st) : [];
      if (sel !== null) {
        for (const m of moves) {
          if (m.from !== sel) continue;
          const [cx, cy] = center(m.to);
          ctx.fillStyle = color;
          ctx.globalAlpha = Math.floor(now / 300) % 2 === 0 ? 0.9 : 0.4;
          ctx.beginPath();
          ctx.arc(X(cx), Y(cy), S(board[m.to] ? 0.026 : 0.015), 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      // A captured piece fades away
      const glyphFont = `${Math.round(S(0.095))}px serif`;
      if (fading) {
        const t = (now - fading.born) / 300;
        if (t >= 1) fading = null;
        else {
          const [cx, cy] = center(fading.i);
          ctx.globalAlpha = 1 - t;
          ctx.fillStyle = ownerOf(fading.v) === 'host' ? BLUE : ORANGE;
          ctx.font = glyphFont;
          ctx.textAlign = 'center';
          ctx.fillText(GLYPH[fading.v[0]], X(cx), Y(cy + 0.034));
          ctx.globalAlpha = 1;
        }
      }

      // Pieces (the freshest one slides from its old square)
      ctx.font = glyphFont;
      ctx.textAlign = 'center';
      for (let i = 0; i < 64; i++) {
        if (!board[i]) continue;
        let [cx, cy] = center(i);
        if (anim && anim.to === i) {
          const t = Math.min(1, (now - anim.born) / anim.dur);
          if (t >= 1) anim = null;
          else {
            const e = 1 - (1 - t) * (1 - t);
            const [fx0, fy0] = center(anim.from);
            cx = fx0 + (cx - fx0) * e;
            cy = fy0 + (cy - fy0) * e;
          }
        }
        ctx.fillStyle = ownerOf(board[i]) === 'host' ? BLUE : ORANGE;
        ctx.fillText(GLYPH[board[i][0]], X(cx), Y(cy + 0.034));
        if (sel === i && Math.floor(now / 250) % 2 === 0) {
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(2, S(0.008));
          ctx.strokeRect(X(cx - C / 2) + 1, Y(cy - C / 2) + 1, S(C) - 2, S(C) - 2);
        }
      }

      // Captured pieces line up under the board
      ctx.font = `${Math.round(S(0.045))}px serif`;
      const rows = [[me, 1.14], [foe(me), 1.2]];
      for (const [role, yy] of rows) {
        ctx.fillStyle = color;
        ctx.textAlign = 'left';
        ctx.font = `${Math.round(S(0.022))}px "Courier New", monospace`;
        ctx.globalAlpha = 0.7;
        ctx.fillText(role === me ? 'YOU TOOK' : 'RIVAL TOOK', X(0.04), Y(yy));
        ctx.globalAlpha = 1;
        ctx.font = `${Math.round(S(0.045))}px serif`;
        captured[role].forEach((t, k) => {
          ctx.fillStyle = role === 'host' ? ORANGE : BLUE; // victims' color
          ctx.fillText(GLYPH[t], X(0.26 + k * 0.045), Y(yy + 0.012));
        });
      }
      ctx.textAlign = 'center';
    },

    status() {
      if (gameOver) return null;
      return 'YOU PLAY ' + (myRole() === 'host' ? 'BLUE (WHITE)' : 'ORANGE (BLACK)');
    }
  });

  // Exposed for automated tests; not part of the game logic
  A.state.csDebug = () => ({
    turn, gameOver, winner,
    timeLeft: A.state.timeLeft,
    board: board.slice(),
    cr: { ...st.cr }, ep: st.ep,
    captured: { host: captured.host.slice(), guest: captured.guest.slice() },
    legal: gameOver ? [] : allLegal(board, turn, st),
    check: gameOver ? false : inCheckOn(board, turn)
  });
  A.state.csSet = (bd, t, cr, ep) => {
    board = bd.map(v => (typeof v === 'string' && v.length === 2 ? v : null));
    turn = t === 'guest' ? 'guest' : 'host';
    st = {
      cr: cr ? { hk: !!cr.hk, hq: !!cr.hq, gk: !!cr.gk, gq: !!cr.gq }
        : { hk: false, hq: false, gk: false, gq: false },
      ep: Number.isInteger(ep) ? ep : null
    };
    sel = null;
    gameOver = false;
    winner = null;
    anim = null;
    fading = null;
  };
  A.state.csMove = (from, to) => myMove(from, to);
})();
