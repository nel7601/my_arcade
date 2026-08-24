/*
 * DOTS & BOXES - the classic pencil-and-paper land grab.
 *
 * A grid of dots; on your turn you draw ONE line between two adjacent
 * dots. Whoever draws the fourth side of a box claims it (+1) and goes
 * AGAIN - chains are the whole game. When every box is claimed, the
 * biggest territory wins. No clock: like PARCHEESI and CHESS, the match
 * ends when the board does.
 *
 * Pick the board size in the menu (5x5, 6x6 or 7x7 boxes). Lines are
 * colored by who drew them, boxes by who claimed them. Every line is
 * replayed on both phones.
 *
 * Solo mode: a CPU that always takes an open box, avoids handing you a
 * third side when it can, and when forced, opens the SHORTEST chain.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { X, Y, S, ctx } = A;

  const BLUE = '#5ad0ff', ORANGE = '#ffb04f';
  const COL = { host: BLUE, guest: ORANGE };

  let B = 5;                 // boxes per side
  let cell = 0.9 / 5;
  const BX0 = 0.05, BY0 = 0.2;

  let H = [], V = [];        // line owners: 'host' | 'guest' | null
  let boxes = [];            // box owners
  let turn = 'host';
  let gameOver = false;
  let doneAt = 0;
  let lastLine = null;       // {t, i, born} freshly drawn line
  let aiAt = 0;
  let nextPoke = Infinity;

  const myRole = () => (A.state.solo ? 'host' : A.state.role);
  const foe = (r) => (r === 'host' ? 'guest' : 'host');
  const hIdx = (c, r) => c + r * B;
  const vIdx = (c, r) => c + r * (B + 1);

  // Menu selector
  let optSize = 5;
  for (const btn of document.querySelectorAll('.opt-btn[data-size]')) {
    btn.addEventListener('click', () => {
      optSize = Number(btn.dataset.size);
      for (const b of document.querySelectorAll('.opt-btn[data-size]')) {
        b.classList.toggle('sel', b === btn);
      }
    });
    if (btn.classList.contains('sel')) optSize = Number(btn.dataset.size);
  }

  function setup(size) {
    B = Math.max(4, Math.min(8, Number(size) || 5));
    cell = 0.9 / B;
    H = Array(B * (B + 1)).fill(null);
    V = Array((B + 1) * B).fill(null);
    boxes = Array(B * B).fill(null);
    turn = 'host';
    gameOver = false;
    lastLine = null;
    aiAt = performance.now() + 1000;
  }

  // The four side-edges of box (bc, br)
  const sidesOf = (bc, br) => [
    ['h', hIdx(bc, br)], ['h', hIdx(bc, br + 1)],
    ['v', vIdx(bc, br)], ['v', vIdx(bc + 1, br)]
  ];

  const edgeArr = (t) => (t === 'h' ? H : V);

  function boxSideCount(bc, br, HH, VV) {
    let n = 0;
    for (const [t, i] of sidesOf(bc, br)) {
      if ((t === 'h' ? HH : VV)[i] !== null) n += 1;
    }
    return n;
  }

  // Boxes touching an edge, as [bc, br]
  function boxesOf(t, i) {
    const out = [];
    if (t === 'h') {
      const c = i % B, r = (i / B) | 0;
      if (r > 0) out.push([c, r - 1]);
      if (r < B) out.push([c, r]);
    } else {
      const c = i % (B + 1), r = (i / (B + 1)) | 0;
      if (c > 0) out.push([c - 1, r]);
      if (c < B) out.push([c, r]);
    }
    return out;
  }

  // ---- Match logic (replayed identically on both phones) ---------------------

  function applyLine(role, t, i) {
    if (gameOver || role !== turn) return false;
    const arr = edgeArr(t);
    if (i < 0 || i >= arr.length || arr[i] !== null) return false;

    arr[i] = role;
    lastLine = { t, i, born: performance.now() };

    let claimed = 0;
    for (const [bc, br] of boxesOf(t, i)) {
      if (boxSideCount(bc, br, H, V) === 4 && boxes[bc + br * B] === null) {
        boxes[bc + br * B] = role;
        claimed += 1;
      }
    }

    if (claimed) {
      if (role === myRole()) {
        A.addScore(claimed);
        A.flash(claimed > 1 ? 'DOUBLE BOX! GO AGAIN' : 'BOX! GO AGAIN');
        A.sndScore();
      } else {
        if (A.state.solo) A.state.score.opp += claimed;
        A.beep(160, 0.12);
      }
      // The box maker goes again - the turn stays
    } else {
      turn = foe(role);
      A.beep(role === myRole() ? 459 : 320, 0.04);
      aiAt = performance.now() + 850;
    }

    if (boxes.every(x => x !== null)) {
      gameOver = true;
      doneAt = performance.now() + 1600;
      const mine = boxes.filter(x => x === myRole()).length;
      const theirs = B * B - mine;
      A.flash(mine > theirs ? 'THE LAND IS YOURS!'
        : mine < theirs ? 'THE RIVAL TOOK THE LAND' : 'ALL SQUARE - DRAW');
    }
    return true;
  }

  function myLine(t, i) {
    if (A.state.phase !== 'playing') return false;
    if (applyLine(myRole(), t, i)) {
      A.send({ type: 'line', t, i });
      return true;
    }
    return false;
  }

  // ---- Solo CPU ---------------------------------------------------------------

  function undrawnEdges(HH, VV) {
    const out = [];
    for (let i = 0; i < HH.length; i++) if (HH[i] === null) out.push(['h', i]);
    for (let i = 0; i < VV.length; i++) if (VV[i] === null) out.push(['v', i]);
    return out;
  }

  // How many boxes the opponent could chain off after this edge is drawn
  function chainCost(t, i) {
    const HH = H.slice(), VV = V.slice();
    (t === 'h' ? HH : VV)[i] = 'x';
    let count = 0;
    for (let guard = 0; guard < B * B + 1; guard++) {
      let found = null;
      for (let br = 0; br < B && !found; br++) {
        for (let bc = 0; bc < B && !found; bc++) {
          if (boxes[bc + br * B] === null && boxSideCount(bc, br, HH, VV) === 3) {
            found = [bc, br];
          }
        }
      }
      if (!found) break;
      for (const [tt, ii] of sidesOf(found[0], found[1])) {
        if ((tt === 'h' ? HH : VV)[ii] === null) { (tt === 'h' ? HH : VV)[ii] = 'x'; break; }
      }
      count += 1;
    }
    return count;
  }

  function aiPick() {
    const open = undrawnEdges(H, V);
    if (!open.length) return null;
    // 1) close any box you can
    for (const [t, i] of open) {
      if (boxesOf(t, i).some(([bc, br]) =>
        boxes[bc + br * B] === null && boxSideCount(bc, br, H, V) === 3)) return [t, i];
    }
    // 2) prefer edges that do not offer a third side
    const safe = open.filter(([t, i]) =>
      !boxesOf(t, i).some(([bc, br]) =>
        boxes[bc + br * B] === null && boxSideCount(bc, br, H, V) === 2));
    if (safe.length) return safe[Math.floor(Math.random() * safe.length)];
    // 3) forced to give: open the SHORTEST chain
    let best = null, bestCost = Infinity;
    for (const [t, i] of open) {
      const cost = chainCost(t, i);
      if (cost < bestCost) { bestCost = cost; best = [t, i]; }
    }
    return best;
  }

  // ---- Registration -------------------------------------------------------------

  A.register({
    game: 'dotsboxes',
    title: 'DOTS & BOXES',
    solo: true,
    soloVersus: true,  // the CPU keeps a real score

    getOpts() {
      return { size: optSize };
    },

    onStart(cfg) {
      setup(cfg.opts.size);
      nextPoke = Infinity;
    },

    onResume(cfg) {
      setup(cfg.opts.size);
      A.send({ type: 'state_req' });
      nextPoke = performance.now() + 3000;
    },

    onMessage(msg) {
      switch (msg.type) {
        case 'line':
          applyLine(foe(myRole()), msg.t === 'v' ? 'v' : 'h', Number(msg.i));
          break;

        case 'state_req':
          A.send({ type: 'state', size: B, H, V, boxes, turn });
          break;

        case 'state': {
          setup(msg.size);
          const clean = (x) => (x === 'host' || x === 'guest' ? x : null);
          H = msg.H.map(clean);
          V = msg.V.map(clean);
          boxes = msg.boxes.map(clean);
          turn = msg.turn === 'guest' ? 'guest' : 'host';
          gameOver = boxes.every(x => x !== null);
          nextPoke = Infinity;
          break;
        }
      }
    },

    onPointer(ph, x, y) {
      if (ph !== 'down' || gameOver || A.state.phase !== 'playing') return;
      if (turn !== myRole()) return;
      // Nearest undrawn edge within a finger's reach
      let best = null, bestD = 0.055;
      for (let r = 0; r <= B; r++) {
        for (let c = 0; c < B; c++) {
          if (H[hIdx(c, r)] !== null) continue;
          const d = Math.hypot(x - (BX0 + (c + 0.5) * cell), y - (BY0 + r * cell));
          if (d < bestD) { bestD = d; best = ['h', hIdx(c, r)]; }
        }
      }
      for (let r = 0; r < B; r++) {
        for (let c = 0; c <= B; c++) {
          if (V[vIdx(c, r)] !== null) continue;
          const d = Math.hypot(x - (BX0 + c * cell), y - (BY0 + (r + 0.5) * cell));
          if (d < bestD) { bestD = d; best = ['v', vIdx(c, r)]; }
        }
      }
      if (best) myLine(best[0], best[1]);
    },

    step(dt, now) {
      if (now > nextPoke) {
        nextPoke = now + 3000;
        A.send({ type: 'state_req' });
      }
      // The whistle: the match ends shortly after the last box
      if (gameOver && now > doneAt && (A.state.solo || A.state.role === 'host') &&
          (A.state.timeLeft === null || A.state.timeLeft > 0.1)) {
        A.state.timeLeft = 0.01;
      }
      if (A.state.solo && !gameOver && turn === 'guest' && now > aiAt) {
        const m = aiPick();
        if (m) applyLine('guest', m[0], m[1]);
        aiAt = now + 850;
      }
    },

    draw(now, color) {
      const me = myRole();

      // Header
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.font = `bold ${Math.round(S(0.036))}px "Courier New", monospace`;
      if (!gameOver) {
        ctx.fillText(turn === me ? 'YOUR TURN: TAP BETWEEN TWO DOTS'
          : (A.state.solo ? 'THE CPU IS DRAWING...' : "RIVAL'S TURN..."), X(0.5), Y(0.1));
      }

      // Claimed boxes
      for (let br = 0; br < B; br++) {
        for (let bc = 0; bc < B; bc++) {
          const o = boxes[bc + br * B];
          if (!o) continue;
          ctx.fillStyle = COL[o];
          ctx.globalAlpha = 0.28;
          ctx.fillRect(X(BX0 + bc * cell) + 2, Y(BY0 + br * cell) + 2,
            S(cell) - 4, S(cell) - 4);
          ctx.globalAlpha = 1;
          ctx.fillRect(X(BX0 + (bc + 0.5) * cell) - S(0.011), Y(BY0 + (br + 0.5) * cell) - S(0.011),
            S(0.022), S(0.022));
        }
      }

      // Drawn lines, colored by their author (the newest blinks white)
      ctx.lineWidth = Math.max(3, S(0.012));
      const fresh = lastLine && now - lastLine.born < 650;
      const drawEdge = (t, i, o) => {
        const isFresh = fresh && lastLine.t === t && lastLine.i === i;
        ctx.strokeStyle = isFresh && Math.floor(now / 150) % 2 === 0 ? '#fff' : COL[o];
        ctx.beginPath();
        if (t === 'h') {
          const c = i % B, r = (i / B) | 0;
          ctx.moveTo(X(BX0 + c * cell) + S(0.01), Y(BY0 + r * cell));
          ctx.lineTo(X(BX0 + (c + 1) * cell) - S(0.01), Y(BY0 + r * cell));
        } else {
          const c = i % (B + 1), r = (i / (B + 1)) | 0;
          ctx.moveTo(X(BX0 + c * cell), Y(BY0 + r * cell) + S(0.01));
          ctx.lineTo(X(BX0 + c * cell), Y(BY0 + (r + 1) * cell) - S(0.01));
        }
        ctx.stroke();
      };
      H.forEach((o, i) => { if (o) drawEdge('h', i, o); });
      V.forEach((o, i) => { if (o) drawEdge('v', i, o); });

      // Dots on top
      ctx.fillStyle = color;
      for (let r = 0; r <= B; r++) {
        for (let c = 0; c <= B; c++) {
          ctx.beginPath();
          ctx.arc(X(BX0 + c * cell), Y(BY0 + r * cell), Math.max(2, S(0.009)), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Box tally under the board
      const mine = boxes.filter(x => x === me).length;
      const theirs = boxes.filter(x => x !== null && x !== me).length;
      ctx.font = `${Math.round(S(0.028))}px "Courier New", monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = COL[me];
      ctx.fillText('■ ' + mine, X(0.3), Y(1.18));
      ctx.fillStyle = COL[foe(me)];
      ctx.fillText('■ ' + theirs, X(0.7), Y(1.18));
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.fillText('OF ' + B * B, X(0.5), Y(1.18));
      ctx.globalAlpha = 1;
    },

    status() {
      if (gameOver) return null;
      return 'YOU PLAY ' + (myRole() === 'host' ? 'BLUE' : 'ORANGE') +
        ' · CLOSE A BOX, GO AGAIN';
    }
  });

  // Exposed for automated tests; not part of the game logic
  A.state.dbDebug = () => ({
    size: B, turn, gameOver,
    timeLeft: A.state.timeLeft,
    H: H.slice(), V: V.slice(), boxes: boxes.slice(),
    drawn: H.filter(Boolean).length + V.filter(Boolean).length,
    counts: {
      host: boxes.filter(x => x === 'host').length,
      guest: boxes.filter(x => x === 'guest').length
    }
  });
  A.state.dbLine = (t, i) => myLine(t, i);
  A.state.dbSet = (h, v, bx, t) => {
    const clean = (x) => (x === 'host' || x === 'guest' ? x : null);
    H = h.map(clean);
    V = v.map(clean);
    boxes = bx.map(clean);
    turn = t === 'guest' ? 'guest' : 'host';
    gameOver = false;
    lastLine = null;
  };
})();
