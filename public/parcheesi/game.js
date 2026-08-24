/*
 * PARCHEESI - the classic race around the cross, streamlined.
 *
 * Two players, four pawns each, on the classic 68-square ring with the
 * traditional numbering: BLUE starts at square 5 and comes home through
 * the bottom corridor; ORANGE starts at 39 and comes home through the
 * top one. Streamlined Spanish rules:
 *   - roll a 5 to bring a pawn out of the yard (it CAPTURES any rival
 *     sitting on your start square)
 *   - a 6 rolls again; THREE sixes in a row send your last-moved pawn
 *     back to the yard
 *   - landing on a lone rival outside a safe square captures it
 *   - safe squares (marked) shelter pawns; two pawns of one color form
 *     a barrier nobody can pass or land on
 *   - the final corridor and the goal need EXACT counts
 *
 * There is NO clock in this one: the first player to walk all four
 * pawns into the center wins, whatever it takes. The dice live on the
 * roller's phone and travel with each roll; every move is replayed on
 * both phones, so the boards stay identical.
 *
 * Solo mode: a proper CPU rival with its own score on the scoreboard.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { X, Y, S, ctx } = A;

  const RING = 68;
  const SAFE = new Set([5, 12, 17, 22, 29, 34, 39, 46, 51, 56, 63, 68]);
  const START = { host: 5, guest: 39 };   // classic yellow / red doors
  const EXIT = { host: 68, guest: 34 };   // last ring square before the corridor

  // Board: 19x19 grid (arms 3 wide and 8 long, like the real board).
  // The three middle lanes are WIDER than the arm steps, so the tracks
  // the pawns ride are roomier while the board still fits the phone.
  const CL = 0.047;               // step length along the arms
  const CM = 0.064;               // width of the three middle lanes
  const SIZE = (i) => (i >= 8 && i <= 10 ? CM : CL);
  const OFF = (() => {
    const o = [];
    let a = 0;
    for (let i = 0; i < 19; i++) { o.push(a); a += SIZE(i); }
    o.push(a);
    return o;
  })();
  const BTOT = OFF[19];
  const BX = (1 - BTOT) / 2;
  const BY = 0.155;
  const DIE = { x: 0.5, y: 1.185, s: 0.1 }; // die box below the board

  const BLUE = '#5ad0ff', ORANGE = '#ffb04f';
  const COL = { host: BLUE, guest: ORANGE };

  // Ring squares 1..68 as [col,row] on the grid, counterclockwise,
  // matching the classic numbering (blue exit 68, orange exit 34)
  const RXY = (() => {
    const p = [];
    for (let r = 18; r >= 11; r--) p.push([10, r]);   // 1-8
    for (let c = 11; c <= 18; c++) p.push([c, 10]);   // 9-16
    p.push([18, 9]);                                  // 17
    for (let c = 18; c >= 11; c--) p.push([c, 8]);    // 18-25
    for (let r = 7; r >= 0; r--) p.push([10, r]);     // 26-33
    p.push([9, 0]);                                   // 34
    for (let r = 0; r <= 7; r++) p.push([8, r]);      // 35-42
    for (let c = 7; c >= 0; c--) p.push([c, 8]);      // 43-50
    p.push([0, 9]);                                   // 51
    for (let c = 0; c <= 7; c++) p.push([c, 10]);     // 52-59
    for (let r = 11; r <= 18; r++) p.push([8, r]);    // 60-67
    p.push([9, 18]);                                  // 68
    return p;
  })();
  // Final corridors, 7 cells from the door toward the center
  const CXY = {
    host: [[9, 17], [9, 16], [9, 15], [9, 14], [9, 13], [9, 12], [9, 11]],
    guest: [[9, 1], [9, 2], [9, 3], [9, 4], [9, 5], [9, 6], [9, 7]]
  };
  const cellXY = (c, r) => [BX + OFF[c] + SIZE(c) / 2, BY + OFF[r] + SIZE(r) / 2];
  const cellRect = (c, r) => [BX + OFF[c], BY + OFF[r], SIZE(c), SIZE(r)];

  // Yards: a compact box centered in each corner region (smaller than
  // the corner itself), with the four waiting slots inside
  const YS = 0.26; // yard box side
  function yardBox(role) {
    const reg = 8 * CL;                        // corner region side
    const x0 = role === 'host' ? BX + OFF[11] : BX;
    const y0 = role === 'host' ? BY + OFF[11] : BY;
    return { x: x0 + (reg - YS) / 2, y: y0 + (reg - YS) / 2, s: YS };
  }
  function yardSlot(role, i) {
    const b = yardBox(role);
    const fx = i % 2 ? 0.7 : 0.3;
    const fy = i < 2 ? 0.32 : 0.72;
    return [b.x + b.s * fx, b.y + b.s * fy];
  }

  let pawns = { host: [], guest: [] };  // 4x {st:'home'|'ring'|'corr'|'goal', pos}
  let turn = 'host';
  let stage = 'roll';                   // roll | move | pause
  let die = 0;
  let sixStreak = 0;
  let lastMoved = { host: -1, guest: -1 };
  let pauseUntil = 0;
  let pauseMsg = '';
  let diceAnim = null;           // {start, until, final} tumbling-die animation
  const ROLL_MS = 750;
  const rolling = () => diceAnim !== null && performance.now() < diceAnim.until;
  let gameOver = false;
  let doneAt = 0;
  let aiAt = 0;
  let nextPoke = Infinity;

  const myRole = () => (A.state.solo ? 'host' : A.state.role);
  const foe = (r) => (r === 'host' ? 'guest' : 'host');

  function reset() {
    pawns = {
      host: [0, 1, 2, 3].map(() => ({ st: 'home', pos: 0 })),
      guest: [0, 1, 2, 3].map(() => ({ st: 'home', pos: 0 }))
    };
    turn = 'host';
    stage = 'roll';
    die = 0;
    sixStreak = 0;
    lastMoved = { host: -1, guest: -1 };
    gameOver = false;
    pauseMsg = '';
    diceAnim = null;
    aiAt = performance.now() + 1200;
  }

  // ---- Rules (identical on both phones) --------------------------------------

  const ringSq = (s, k) => ((s - 1 + k) % RING) + 1;

  function ringOcc(sq) {
    const occ = { host: 0, guest: 0, total: 0 };
    for (const role of ['host', 'guest']) {
      for (const p of pawns[role]) {
        if (p.st === 'ring' && p.pos === sq) { occ[role] += 1; occ.total += 1; }
      }
    }
    return occ;
  }

  const barrierAt = (sq) => {
    const o = ringOcc(sq);
    return o.host >= 2 || o.guest >= 2;
  };

  const corrCount = (role, cell) =>
    pawns[role].filter(p => p.st === 'corr' && p.pos === cell).length;

  const goalCount = (role) => pawns[role].filter(p => p.st === 'goal').length;

  function legalMoves(role, v) {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const p = pawns[role][i];
      if (p.st === 'goal') continue;

      if (p.st === 'home') {
        if (v !== 5) continue;
        const s = START[role];
        const occ = ringOcc(s);
        if (occ.total >= 2) continue; // any pair (barrier) blocks the door
        // Coming out CAPTURES a lone rival on your own start square
        out.push({ i, st: 'ring', pos: s, capture: occ[foe(role)] === 1 });
        continue;
      }

      if (p.st === 'corr') {
        const m = p.pos + v;
        if (m > 8) continue; // the goal needs an exact count
        let blocked = false;
        for (let c = p.pos + 1; c < Math.min(m, 8); c++) {
          if (corrCount(role, c) >= 2) { blocked = true; break; }
        }
        if (blocked) continue;
        if (m === 8) out.push({ i, st: 'goal', pos: 0 });
        else if (corrCount(role, m) < 2) out.push({ i, st: 'corr', pos: m });
        continue;
      }

      // On the ring
      const dist = (EXIT[role] - p.pos + RING) % RING; // squares to my door
      if (v <= dist) {
        let blocked = false;
        for (let k = 1; k < v; k++) {
          if (barrierAt(ringSq(p.pos, k))) { blocked = true; break; }
        }
        if (blocked) continue;
        const d = ringSq(p.pos, v);
        const occ = ringOcc(d);
        if (occ.total >= 2) continue;
        out.push({ i, st: 'ring', pos: d, capture: occ[foe(role)] === 1 && !SAFE.has(d) });
      } else {
        const m = v - dist; // 1..7 corridor, 8 = goal
        if (m > 8) continue;
        let blocked = false;
        for (let k = 1; k <= dist; k++) {
          if (barrierAt(ringSq(p.pos, k))) { blocked = true; break; }
        }
        for (let c = 1; c < Math.min(m, 8); c++) {
          if (corrCount(role, c) >= 2) { blocked = true; break; }
        }
        if (blocked) continue;
        if (m === 8) out.push({ i, st: 'goal', pos: 0 });
        else if (corrCount(role, m) < 2) out.push({ i, st: 'corr', pos: m });
      }
    }
    return out;
  }

  function pass() {
    turn = foe(turn);
    sixStreak = 0;
    stage = 'roll';
    aiAt = performance.now() + 900;
  }

  function beginPause(msg, ms) {
    stage = 'pause';
    pauseMsg = msg;
    pauseUntil = performance.now() + ms;
  }

  function resolvePause() {
    if (stage !== 'pause') return;
    pauseMsg = '';
    if (!gameOver) pass();
    else stage = 'roll'; // frozen; the whistle is coming
  }

  // Both phones replay every roll through here
  function processRoll(role, v) {
    if (gameOver || stage !== 'roll' || role !== turn) return false;
    die = v;
    const t0 = performance.now();
    diceAnim = { start: t0, until: t0 + ROLL_MS, final: v };
    A.beep(role === myRole() ? 459 : 320, 0.04);
    if (v === 6) {
      sixStreak += 1;
      if (sixStreak >= 3) {
        // Third six: the last pawn you moved walks all the way back
        const lm = lastMoved[role];
        if (lm >= 0 && pawns[role][lm].st === 'ring') {
          pawns[role][lm] = { st: 'home', pos: 0 };
        }
        if (role === myRole()) A.flash('THREE SIXES! BACK HOME');
        A.beep(120, 0.3);
        beginPause('THREE SIXES!', 1500);
        return true;
      }
    } else {
      sixStreak = 0;
    }
    if (!legalMoves(role, v).length) {
      beginPause('NO MOVE', 1300);
    } else {
      stage = 'move';
      aiAt = performance.now() + 800;
    }
    return true;
  }

  // ...and every pawn move through here
  function applyMove(role, i) {
    if (gameOver || stage !== 'move' || role !== turn) return false;
    const mv = legalMoves(role, die).find(m => m.i === i);
    if (!mv) return false;

    if (mv.capture) {
      const victim = pawns[foe(role)].find(p => p.st === 'ring' && p.pos === mv.pos);
      if (victim) { victim.st = 'home'; victim.pos = 0; }
      A.flash(role === myRole() ? 'CAPTURED!' : 'YOUR PAWN WAS CAPTURED!');
      A.beep(160, 0.2);
    }
    pawns[role][i] = { st: mv.st, pos: mv.pos };
    lastMoved[role] = i;
    A.beep(500, 0.04);

    if (mv.st === 'goal') {
      if (role === myRole()) {
        A.addScore(1);
        A.flash('PAWN HOME!');
        A.sndScore();
      } else if (A.state.solo) {
        A.state.score.opp += 1; // the CPU keeps its own score locally
      }
      if (goalCount(role) === 4) {
        gameOver = true;
        doneAt = performance.now() + 1600;
        A.flash(role === myRole() ? 'ALL FOUR HOME - YOU WIN!' : 'RIVAL GOT ALL FOUR HOME');
        stage = 'pause';
        pauseUntil = Infinity;
        pauseMsg = '';
        return true;
      }
    }

    if (die === 6) {
      stage = 'roll'; // a six rolls again
      aiAt = performance.now() + 900;
    } else {
      pass();
    }
    return true;
  }

  function myRoll() {
    if (turn !== myRole() || stage !== 'roll' || gameOver) return false;
    const v = 1 + Math.floor(Math.random() * 6);
    A.send({ type: 'roll', v });
    return processRoll(myRole(), v);
  }

  // ---- Solo CPU ---------------------------------------------------------------

  function aiStep(now) {
    if (!A.state.solo || gameOver || turn !== 'guest' || now < aiAt) return;
    if (stage === 'roll') {
      processRoll('guest', 1 + Math.floor(Math.random() * 6));
      return;
    }
    if (stage !== 'move') return;
    const moves = legalMoves('guest', die);
    if (!moves.length) { beginPause('NO MOVE', 1000); return; }
    let best = null, bestScore = -Infinity;
    for (const m of moves) {
      let sc = 0;
      if (m.capture) sc += 100;
      if (m.st === 'goal') sc += 80;
      if (m.st === 'corr') sc += 40 + m.pos;
      if (pawns.guest[m.i].st === 'home') sc += 60;
      if (m.st === 'ring' && SAFE.has(m.pos)) sc += 25;
      if (m.st === 'ring') sc += ((EXIT.guest - m.pos + RING) % RING) * -0.1;
      sc += Math.random() * 5;
      if (sc > bestScore) { bestScore = sc; best = m; }
    }
    applyMove('guest', best.i);
  }

  // ---- Registration -------------------------------------------------------------

  A.register({
    game: 'parcheesi',
    title: 'PARCHEESI',
    solo: true,
    soloVersus: true,  // the CPU is a real rival with its own score

    onStart() {
      reset();
      nextPoke = Infinity;
    },

    onResume() {
      reset();
      A.send({ type: 'state_req' });
      nextPoke = performance.now() + 3000;
    },

    onMessage(msg) {
      switch (msg.type) {
        case 'roll':
          if (stage === 'pause') resolvePause(); // their turn already began
          processRoll(foe(myRole()), Math.max(1, Math.min(6, Number(msg.v) || 1)));
          break;

        case 'mv':
          applyMove(foe(myRole()), Math.max(0, Math.min(3, Number(msg.i) || 0)));
          break;

        case 'state_req':
          if (stage === 'pause' && !gameOver) resolvePause(); // snapshot a settled state
          A.send({ type: 'state', pawns, turn, stage, die, sixStreak, lastMoved });
          break;

        case 'state':
          for (const role of ['host', 'guest']) {
            pawns[role] = msg.pawns[role].map(p => ({
              st: ['home', 'ring', 'corr', 'goal'].includes(p.st) ? p.st : 'home',
              pos: Number(p.pos) || 0
            }));
          }
          turn = msg.turn === 'guest' ? 'guest' : 'host';
          stage = msg.stage === 'move' ? 'move' : 'roll';
          die = Number(msg.die) || 0;
          sixStreak = Number(msg.sixStreak) || 0;
          if (msg.lastMoved) lastMoved = { host: Number(msg.lastMoved.host), guest: Number(msg.lastMoved.guest) };
          gameOver = goalCount('host') === 4 || goalCount('guest') === 4;
          nextPoke = Infinity;
          break;
      }
    },

    onPointer(ph, x, y) {
      if (ph !== 'down' || A.state.phase !== 'playing' || gameOver) return;
      if (turn !== myRole()) return;

      // Tap the die to roll
      if (stage === 'roll' &&
          Math.abs(x - DIE.x) < 0.16 && Math.abs(y - DIE.y) < 0.09) {
        myRoll();
        return;
      }
      if (stage !== 'move' || rolling()) return;

      // Tap a pawn (nearest movable pawn wins; generous radius)
      const moves = legalMoves(myRole(), die);
      let best = null, bestD = 0.085;
      for (const m of moves) {
        const [px, py] = pawnXY(myRole(), m.i);
        const d = Math.hypot(x - px, y - py);
        if (d < bestD) { bestD = d; best = m; }
      }
      if (best) {
        if (applyMove(myRole(), best.i)) A.send({ type: 'mv', i: best.i });
      }
    },

    step(dt, now) {
      if (now > nextPoke) {
        nextPoke = now + 3000;
        A.send({ type: 'state_req' });
      }
      if (stage === 'pause' && now > pauseUntil) resolvePause();
      aiStep(now);
      // The whistle: untimed match ends the moment someone has all four in
      if (gameOver && now > doneAt && (A.state.solo || A.state.role === 'host') &&
          (A.state.timeLeft === null || A.state.timeLeft > 0.1)) {
        A.state.timeLeft = 0.01;
      }
    },

    draw(now, color) {
      drawBoard(now, color);
      drawPawns(now, color);
      drawDie(now, color);
      drawHeader(now, color);
    },

    status() {
      return 'YOU PLAY ' + (myRole() === 'host' ? 'BLUE' : 'ORANGE');
    }
  });

  // ---- Drawing -------------------------------------------------------------------

  function drawHeader(now, color) {
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(S(0.034))}px "Courier New", monospace`;
    let head;
    if (gameOver) {
      head = '';
    } else if (rolling()) {
      head = 'ROLLING...';
    } else if (stage === 'pause') {
      head = pauseMsg;
    } else if (turn !== myRole()) {
      head = A.state.solo ? 'THE CPU IS PLAYING...' : "RIVAL'S TURN...";
    } else if (stage === 'roll') {
      head = sixStreak > 0 ? 'A SIX! ROLL AGAIN' : 'YOUR TURN: TAP THE DIE';
    } else {
      head = 'ROLL ' + die + ' · TAP A PAWN';
    }
    if (head) ctx.fillText(head, X(0.5), Y(0.09));
  }

  function drawBoard(now, color) {
    ctx.lineWidth = 1;

    // Yards: a compact box per player with its color
    for (const role of ['host', 'guest']) {
      ctx.strokeStyle = COL[role];
      ctx.globalAlpha = 0.5;
      const bxx = yardBox(role);
      ctx.strokeRect(X(bxx.x), Y(bxx.y), S(bxx.s), S(bxx.s));
      ctx.globalAlpha = 1;
    }

    // Ring squares
    for (let s = 1; s <= RING; s++) {
      const [c, r] = RXY[s - 1];
      const [rx, ry, rw, rh] = cellRect(c, r);
      const [cx, cy] = cellXY(c, r);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.28;
      ctx.strokeRect(X(rx), Y(ry), S(rw), S(rh));
      ctx.globalAlpha = 1;
      if (s === START.host || s === START.guest) {
        // Doors get their owner's tint
        ctx.fillStyle = COL[s === START.host ? 'host' : 'guest'];
        ctx.globalAlpha = 0.25;
        ctx.fillRect(X(rx), Y(ry), S(rw), S(rh));
        ctx.globalAlpha = 1;
      } else if (SAFE.has(s)) {
        // Safe squares carry a small diamond
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.45;
        const d = Math.min(rw, rh) * 0.18;
        ctx.beginPath();
        ctx.moveTo(X(cx), Y(cy - d));
        ctx.lineTo(X(cx + d), Y(cy));
        ctx.lineTo(X(cx), Y(cy + d));
        ctx.lineTo(X(cx - d), Y(cy));
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // Corridors tinted per color, and the center goal
    for (const role of ['host', 'guest']) {
      ctx.fillStyle = COL[role];
      ctx.globalAlpha = 0.18;
      for (const [c, r] of CXY[role]) {
        const [rx, ry, rw, rh] = cellRect(c, r);
        ctx.fillRect(X(rx), Y(ry), S(rw), S(rh));
      }
      ctx.globalAlpha = 1;
    }
    const [gx, gy] = cellXY(9, 9);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.6;
    ctx.strokeRect(X(BX + OFF[8]), Y(BY + OFF[8]), S(3 * CM), S(3 * CM));
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.round(S(0.02))}px "Courier New", monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('HOME', X(gx), Y(gy + 0.007));
  }

  // Where pawn i of `role` sits on screen (goal pawns line up in the center)
  function pawnXY(role, i) {
    const p = pawns[role][i];
    if (p.st === 'home') {
      return yardSlot(role, i);
    }
    if (p.st === 'ring') {
      const [c, r] = RXY[p.pos - 1];
      const [cx, cy] = cellXY(c, r);
      // Two pawns on one square sit side by side
      const here = [];
      for (const rl of ['host', 'guest']) {
        pawns[rl].forEach((q, qi) => {
          if (q.st === 'ring' && q.pos === p.pos) here.push(rl + qi);
        });
      }
      if (here.length > 1) {
        const k = here.indexOf(role + i);
        return [cx + (k === 0 ? -0.011 : 0.011), cy];
      }
      return [cx, cy];
    }
    if (p.st === 'corr') {
      const [c, r] = CXY[role][p.pos - 1];
      return cellXY(c, r);
    }
    // goal: lined up inside the center, blue low, orange high
    const [gx, gy] = cellXY(9, 9);
    const k = pawns[role].slice(0, i).filter(q => q.st === 'goal').length;
    return [gx - 0.045 + k * 0.03, gy + (role === 'host' ? 0.045 : -0.038)];
  }

  function drawPawns(now, color) {
    const blinkOn = Math.floor(now / 300) % 2 === 0;
    const movable = new Set(
      (!gameOver && stage === 'move' && turn === myRole() && !rolling())
        ? legalMoves(myRole(), die).map(m => m.i) : []
    );
    for (const role of ['host', 'guest']) {
      for (let i = 0; i < 4; i++) {
        const [px, py] = pawnXY(role, i);
        ctx.fillStyle = COL[role];
        ctx.beginPath();
        ctx.arc(X(px), Y(py), S(0.0155), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = Math.max(1, S(0.004));
        ctx.stroke();
        if (role === myRole() && movable.has(i) && blinkOn) {
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(2, S(0.006));
          ctx.beginPath();
          ctx.arc(X(px), Y(py), S(0.023), 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
  }

  const PIPS = {
    1: [[0, 0]],
    2: [[-1, -1], [1, 1]],
    3: [[-1, -1], [0, 0], [1, 1]],
    4: [[-1, -1], [1, -1], [-1, 1], [1, 1]],
    5: [[-1, -1], [1, -1], [0, 0], [-1, 1], [1, 1]],
    6: [[-1, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [1, 1]]
  };

  function drawDieFace(cxPx, cyPx, sidePx, face, ang, colBox, colPips) {
    ctx.save();
    ctx.translate(cxPx, cyPx);
    ctx.rotate(ang);
    ctx.strokeStyle = colBox;
    ctx.lineWidth = Math.max(2, S(0.006));
    ctx.strokeRect(-sidePx / 2, -sidePx / 2, sidePx, sidePx);
    ctx.fillStyle = colPips;
    for (const [ox, oy] of PIPS[face] || []) {
      ctx.beginPath();
      ctx.arc(ox * sidePx * 0.24, oy * sidePx * 0.24, S(0.009), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawDie(now, color) {
    const mine = !gameOver && turn === myRole();
    const [dx, dy, ds] = [DIE.x, DIE.y, DIE.s];
    const boxCol = mine ? color : '#777';
    const pipCol = mine ? color : '#999';

    if (diceAnim && now >= diceAnim.until) {
      diceAnim = null;
      A.beep(600, 0.06); // the die settles
    }

    if (diceAnim) {
      // Tumble: the die spins, hops and flickers faces, then settles
      const t = Math.min(1, (now - diceAnim.start) / ROLL_MS);
      const ease = 1 - (1 - t) * (1 - t);
      const face = t > 0.85 ? diceAnim.final : 1 + (Math.floor(now / 80) * 7 + 3) % 6;
      const ang = (1 - ease) * 9 + Math.sin(now / 40) * (1 - t) * 0.25;
      const hop = Math.abs(Math.sin(t * Math.PI * 3)) * (1 - t) * 0.035;
      const scale = 1 + (1 - t) * 0.25;
      drawDieFace(X(dx), Y(dy - hop), S(ds * scale), face, ang, boxCol, pipCol);
      return;
    }

    if (die > 0) {
      drawDieFace(X(dx), Y(dy), S(ds), die, 0, boxCol, pipCol);
    } else {
      ctx.strokeStyle = boxCol;
      ctx.lineWidth = Math.max(2, S(0.006));
      ctx.strokeRect(X(dx - ds / 2), Y(dy - ds / 2), S(ds), S(ds));
    }
    if (mine && stage === 'roll' && Math.floor(now / 400) % 2 === 0) {
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.font = `bold ${Math.round(S(0.03))}px "Courier New", monospace`;
      ctx.fillText('TAP TO ROLL', X(dx + 0.24), Y(dy + 0.012));
    }
  }

  // Exposed for automated tests; not part of the game logic
  A.state.pcDebug = () => ({
    turn, stage, die, sixStreak, gameOver,
    rolling: rolling(),
    timeLeft: A.state.timeLeft,
    pawns: {
      host: pawns.host.map(p => ({ ...p })),
      guest: pawns.guest.map(p => ({ ...p }))
    },
    goals: { host: goalCount('host'), guest: goalCount('guest') },
    legal: (stage === 'move' && !gameOver) ? legalMoves(turn, die) : []
  });
  A.state.pcSet = (p, t, st, d) => {
    for (const role of ['host', 'guest']) {
      pawns[role] = p[role].map(q => ({ st: q.st, pos: Number(q.pos) || 0 }));
    }
    turn = t;
    stage = st;
    die = Number(d) || 0;
    sixStreak = 0;
    gameOver = false;
    pauseMsg = '';
    diceAnim = null;
  };
  A.state.pcRoll = (v) => {
    if (turn !== myRole() || stage !== 'roll' || gameOver) return false;
    A.send({ type: 'roll', v });
    return processRoll(myRole(), v);
  };
  A.state.pcMove = (i) => {
    if (applyMove(myRole(), i)) { A.send({ type: 'mv', i }); return true; }
    return false;
  };
})();
