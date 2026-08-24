/*
 * BATTLESHIP - the classic naval duel, one phone per fleet.
 *
 * Each player shuffles a random fleet (5-4-3-3-2 on a 10x10 grid) and
 * taps READY; fleets are exchanged so both phones can score every shot
 * locally, exactly like TANKS shares its battlefield. Then it's turns:
 * tap a cell in the enemy waters to fire - a hit lets you shoot again,
 * a miss hands the turn over. Every hit is a point; sinking the whole
 * enemy fleet ends the match early. If the clock runs out first, the
 * player with more hits wins.
 *
 * The big top grid is the ENEMY waters (your shots); the small bottom
 * grid is YOUR fleet with the rival's shots falling on it.
 *
 * Solo mode: duel a hunt-and-target AI admiral.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { X, Y, S, ctx } = A;

  const GRID = 10;
  const SIZES = [5, 4, 3, 3, 2];
  const SHIP_NAMES = ['CARRIER', 'BATTLESHIP', 'CRUISER', 'SUBMARINE', 'DESTROYER'];

  // Layout (portrait court 1 x 1.6, play area down to 1.28)
  const EG = { x0: 0.105, y0: 0.065, c: 0.079 };  // enemy waters (battle)
  const OG = { x0: 0.05,  y0: 0.865, c: 0.040 };  // your fleet (battle)
  const PG = { x0: 0.105, y0: 0.105, c: 0.079 };  // your fleet (placement)
  const BTN_SHUFFLE = { x0: 0.10, y0: 0.99, x1: 0.48, y1: 1.11 };
  const BTN_READY   = { x0: 0.52, y0: 0.99, x1: 0.90, y1: 1.11 };

  const key = (x, y) => x + ',' + y;

  let phase = 'place';           // place | battle
  let ships = { host: null, guest: null };  // 5 ships each: [{cells:[{x,y}]}]
  let shotAt = { host: new Set(), guest: new Set() }; // shots RECEIVED per role
  let myReady = false;
  let theirReady = false;
  let turn = 'host';
  let gameOver = false;
  let doneAt = 0;
  let lastSplash = null;         // {x, y, grid, hit, born} shot animation
  let aiQueue = [];
  let aiDelay = 0;
  let syncDeadline = Infinity;
  let nextPoke = Infinity;

  const myRole = () => A.state.role;
  const foe = (r) => (r === 'host' ? 'guest' : 'host');

  // ---- Fleet helpers --------------------------------------------------------

  function randomFleet() {
    const taken = new Set();
    const fleet = [];
    for (const size of SIZES) {
      for (let tries = 0; ; tries++) {
        const horiz = Math.random() < 0.5;
        const x = Math.floor(Math.random() * (horiz ? GRID - size + 1 : GRID));
        const y = Math.floor(Math.random() * (horiz ? GRID : GRID - size + 1));
        const cells = [];
        for (let i = 0; i < size; i++) {
          cells.push({ x: x + (horiz ? i : 0), y: y + (horiz ? 0 : i) });
        }
        if (cells.every(c => !taken.has(key(c.x, c.y)))) {
          cells.forEach(c => taken.add(key(c.x, c.y)));
          fleet.push({ cells });
          break;
        }
        if (tries > 400) return randomFleet(); // start over (practically never)
      }
    }
    return fleet;
  }

  const shipCells = (role) => {
    const all = new Set();
    if (ships[role]) for (const s of ships[role]) for (const c of s.cells) all.add(key(c.x, c.y));
    return all;
  };

  const isSunk = (ship, role) => ship.cells.every(c => shotAt[role].has(key(c.x, c.y)));
  const sunkCount = (role) => (ships[role] ? ships[role].filter(s => isSunk(s, role)).length : 0);
  const allSunk = (role) => ships[role] !== null && sunkCount(role) === SIZES.length;
  const hitsOn = (role) => {
    const cells = shipCells(role);
    let n = 0;
    for (const k of shotAt[role]) if (cells.has(k)) n += 1;
    return n;
  };

  // ---- Battle logic (runs identically on both phones) -----------------------

  function enterBattleIfReady() {
    if (phase === 'battle') return;
    if (ships.host && ships.guest && myReady && theirReady) {
      phase = 'battle';
      turn = 'host';
      A.flash('BATTLE STATIONS!');
      A.sndScore();
    }
  }

  // A shot lands on `target`'s board; both phones run the same bookkeeping
  function applyShot(shooter, x, y) {
    const target = foe(shooter);
    const k = key(x, y);
    if (shotAt[target].has(k)) return;
    shotAt[target].add(k);
    const hit = shipCells(target).has(k);
    lastSplash = { x, y, target, hit, born: performance.now() };

    if (hit) {
      if (shooter === myRole()) {
        A.addScore(1);
        const ship = ships[target].find(s => s.cells.some(c => c.x === x && c.y === y));
        if (isSunk(ship, target)) {
          A.flash('SUNK: ' + SHIP_NAMES[ships[target].indexOf(ship)] + '!');
          A.sndScore();
        } else {
          A.flash('HIT!');
          A.beep(160, 0.15);
        }
      } else {
        A.beep(160, 0.15);
      }
      // Classic rule: a hit earns another shot - the turn stays
    } else {
      if (shooter === myRole()) A.beep(500, 0.05);
      turn = target;
    }

    if (allSunk(target)) {
      gameOver = true;
      doneAt = performance.now() + 1400;
      A.flash(shooter === myRole() ? 'ENEMY FLEET DESTROYED!' : 'YOUR FLEET IS SUNK!');
    }
  }

  function myFire(x, y) {
    if (phase !== 'battle' || gameOver || turn !== myRole()) return;
    if (shotAt[foe(myRole())].has(key(x, y))) return;
    A.send({ type: 'fire', x, y });
    applyShot(myRole(), x, y);
  }

  // ---- Solo AI: hunt randomly (with parity), then target the neighbors ------

  function aiStep(dt) {
    if (!A.state.solo || phase !== 'battle' || gameOver || turn !== 'guest') return;
    aiDelay -= dt;
    if (aiDelay > 0) return;
    aiDelay = 0.9;

    let cell = null;
    while (aiQueue.length && !cell) {
      const c = aiQueue.shift();
      if (c.x >= 0 && c.x < GRID && c.y >= 0 && c.y < GRID &&
          !shotAt.host.has(key(c.x, c.y))) cell = c;
    }
    if (!cell) {
      const opts = [];
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          if (!shotAt.host.has(key(x, y)) && (x + y) % 2 === 0) opts.push({ x, y });
        }
      }
      if (!opts.length) {
        for (let y = 0; y < GRID; y++) {
          for (let x = 0; x < GRID; x++) {
            if (!shotAt.host.has(key(x, y))) opts.push({ x, y });
          }
        }
      }
      if (!opts.length) return;
      cell = opts[Math.floor(Math.random() * opts.length)];
    }

    const wasHit = shipCells('host').has(key(cell.x, cell.y));
    applyShot('guest', cell.x, cell.y);
    if (wasHit) {
      aiQueue.push({ x: cell.x + 1, y: cell.y }, { x: cell.x - 1, y: cell.y },
        { x: cell.x, y: cell.y + 1 }, { x: cell.x, y: cell.y - 1 });
    }
  }

  // ---- Setup / sync ----------------------------------------------------------

  function resetMatch() {
    phase = 'place';
    ships = { host: null, guest: null };
    ships[A.state.solo ? 'host' : myRole()] = randomFleet();
    shotAt = { host: new Set(), guest: new Set() };
    myReady = false;
    theirReady = false;
    turn = 'host';
    gameOver = false;
    lastSplash = null;
    aiQueue = [];
    aiDelay = 1.2;
    syncDeadline = Infinity;
    nextPoke = Infinity;
  }

  function goReady() {
    if (myReady || phase !== 'place') return;
    myReady = true;
    A.beep(459, 0.05);
    if (A.state.solo) {
      ships.guest = randomFleet();
      theirReady = true;
    } else {
      A.send({ type: 'fleet', ships: ships[myRole()].map(s => s.cells) });
    }
    enterBattleIfReady();
  }

  function stateMsg() {
    return {
      type: 'state',
      phase,
      turn,
      ships: {
        host: ships.host ? ships.host.map(s => s.cells) : null,
        guest: ships.guest ? ships.guest.map(s => s.cells) : null
      },
      shots: { host: [...shotAt.host], guest: [...shotAt.guest] }
    };
  }

  function adoptState(msg) {
    phase = msg.phase === 'battle' ? 'battle' : 'place';
    turn = msg.turn === 'guest' ? 'guest' : 'host';
    for (const r of ['host', 'guest']) {
      ships[r] = msg.ships[r]
        ? msg.ships[r].map(cells => ({ cells: cells.map(c => ({ x: Number(c.x), y: Number(c.y) })) }))
        : null;
      shotAt[r] = new Set(msg.shots[r]);
    }
    const mine = myRole();
    myReady = phase === 'battle' || !!ships[mine];
    theirReady = phase === 'battle' || !!ships[foe(mine)];
    if (!ships[mine]) {
      ships[mine] = randomFleet(); // my board never reached the rival: redo it
      myReady = false;
    }
    gameOver = phase === 'battle' && (allSunk('host') || allSunk('guest'));
    syncDeadline = Infinity;
    nextPoke = Infinity;
  }

  // ---- Registration ----------------------------------------------------------

  A.register({
    game: 'battleship',
    title: 'BATTLESHIP',
    solo: true,

    onStart() {
      resetMatch();
    },

    onResume() {
      // A reload lost my board: ask the rival for everything it knows
      resetMatch();
      A.send({ type: 'state_req' });
      nextPoke = performance.now() + 3000;
      syncDeadline = performance.now() + 7000;
    },

    onMessage(msg) {
      switch (msg.type) {
        case 'fleet':
          if (phase === 'battle') {
            // The rival reloaded and restarted placement: restore them
            A.send(stateMsg());
            break;
          }
          ships[foe(myRole())] = msg.ships.map(cells =>
            ({ cells: cells.map(c => ({ x: Number(c.x), y: Number(c.y) })) }));
          theirReady = true;
          enterBattleIfReady();
          break;

        case 'fire':
          applyShot(foe(myRole()), Number(msg.x), Number(msg.y));
          break;

        case 'state_req':
          A.send(stateMsg());
          break;

        case 'state':
          adoptState(msg);
          break;
      }
    },

    onPointer(ph, x, y) {
      if (ph !== 'down' || A.state.phase !== 'playing') return;

      if (phase === 'place') {
        if (x > BTN_SHUFFLE.x0 && x < BTN_SHUFFLE.x1 && y > BTN_SHUFFLE.y0 && y < BTN_SHUFFLE.y1 && !myReady) {
          ships[myRole() || 'host'] = randomFleet();
          A.beep(226, 0.04);
        } else if (x > BTN_READY.x0 && x < BTN_READY.x1 && y > BTN_READY.y0 && y < BTN_READY.y1) {
          goReady();
        }
        return;
      }

      // Battle: taps only count inside the enemy grid
      const cx = Math.floor((x - EG.x0) / EG.c);
      const cy = Math.floor((y - EG.y0) / EG.c);
      if (cx >= 0 && cx < GRID && cy >= 0 && cy < GRID) myFire(cx, cy);
    },

    step(dt, now) {
      if (!A.state.solo) {
        if (now > nextPoke) {
          nextPoke = now + 3000;
          A.send({ type: 'state_req' });
        }
        if (now > syncDeadline) {
          // Nobody answered (both reloaded): fresh placement for everyone
          syncDeadline = Infinity;
          nextPoke = Infinity;
        }
      }
      aiStep(dt);
      // The referee blows the early whistle once a fleet is destroyed
      if (gameOver && now > doneAt && (A.state.solo || A.state.role === 'host') &&
          (A.state.timeLeft === null || A.state.timeLeft > 0.1)) {
        A.state.timeLeft = 0.01;
      }
    },

    draw(now, color) {
      if (phase === 'place') {
        drawPlacement(now, color);
      } else {
        drawBattle(now, color);
      }
    },

    status() {
      if (phase === 'place') {
        return myReady ? "WAITING FOR THE RIVAL'S FLEET..." : 'SHUFFLE YOUR FLEET, THEN GO READY';
      }
      if (gameOver) return null;
      if (turn === myRole()) return 'YOUR TURN: TAP THE ENEMY WATERS';
      return A.state.solo ? 'ENEMY ADMIRAL IS AIMING...' : 'RIVAL IS AIMING...';
    }
  });

  // ---- Drawing ---------------------------------------------------------------

  function drawGrid(g, size, color) {
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 1;
    for (let i = 0; i <= GRID; i++) {
      ctx.beginPath();
      ctx.moveTo(X(g.x0 + i * g.c), Y(g.y0));
      ctx.lineTo(X(g.x0 + i * g.c), Y(g.y0 + GRID * g.c));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(X(g.x0), Y(g.y0 + i * g.c));
      ctx.lineTo(X(g.x0 + GRID * g.c), Y(g.y0 + i * g.c));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function cellRect(g, x, y, pad) {
    return [X(g.x0 + x * g.c) + S(pad), Y(g.y0 + y * g.c) + S(pad),
      S(g.c - 2 * pad), S(g.c - 2 * pad)];
  }

  function drawShipsOn(g, role) {
    if (!ships[role]) return;
    ctx.fillStyle = '#5aa2ff';
    for (const s of ships[role]) {
      for (const c of s.cells) ctx.fillRect(...cellRect(g, c.x, c.y, 0.006));
    }
  }

  function drawShotsOn(g, role, revealSunk) {
    const cells = shipCells(role);
    for (const k of shotAt[role]) {
      const [x, y] = k.split(',').map(Number);
      if (cells.has(k)) {
        ctx.strokeStyle = '#ff5252';
        ctx.lineWidth = Math.max(2, S(0.008));
        const [rx, ry, rw, rh] = cellRect(g, x, y, 0.016);
        ctx.beginPath();
        ctx.moveTo(rx, ry); ctx.lineTo(rx + rw, ry + rh);
        ctx.moveTo(rx + rw, ry); ctx.lineTo(rx, ry + rh);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#9aa7b0';
        const [rx, ry, rw, rh] = cellRect(g, x, y, g.c * 0.42);
        ctx.fillRect(rx, ry, rw, rh);
      }
    }
    // Sunk enemy ships surface in orange
    if (revealSunk && ships[role]) {
      ctx.strokeStyle = '#ffb04f';
      ctx.lineWidth = Math.max(2, S(0.006));
      for (const s of ships[role]) {
        if (!isSunk(s, role)) continue;
        for (const c of s.cells) ctx.strokeRect(...cellRect(g, c.x, c.y, 0.01));
      }
    }
  }

  function drawSplash(g, now) {
    if (!lastSplash) return;
    const t = (now - lastSplash.born) / 500;
    if (t >= 1) { lastSplash = null; return; }
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = lastSplash.hit ? '#ff5252' : '#9aa7b0';
    ctx.lineWidth = Math.max(2, S(0.006));
    const cx = g.x0 + (lastSplash.x + 0.5) * g.c;
    const cy = g.y0 + (lastSplash.y + 0.5) * g.c;
    ctx.beginPath();
    ctx.arc(X(cx), Y(cy), S(g.c * (0.3 + 0.5 * t)), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function fleetBars(x0, y0, role, label, color) {
    ctx.fillStyle = color;
    ctx.font = `${Math.round(S(0.024))}px "Courier New", monospace`;
    ctx.textAlign = 'left';
    ctx.globalAlpha = 0.7;
    ctx.fillText(label, X(x0), Y(y0));
    ctx.globalAlpha = 1;
    if (!ships[role]) return;
    for (let i = 0; i < ships[role].length; i++) {
      const sunk = isSunk(ships[role][i], role);
      ctx.globalAlpha = sunk ? 0.25 : 1;
      ctx.fillStyle = sunk ? '#ff5252' : color;
      for (let j = 0; j < ships[role][i].cells.length; j++) {
        ctx.fillRect(X(x0 + j * 0.026), Y(y0 + 0.02 + i * 0.032), S(0.02), S(0.02));
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawPlacement(now, color) {
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.round(S(0.04))}px "Courier New", monospace`;
    ctx.fillText('YOUR FLEET', X(0.5), Y(0.07));

    drawGrid(PG, GRID, color);
    drawShipsOn(PG, A.state.solo ? 'host' : myRole());

    for (const [btn, label, on] of [
      [BTN_SHUFFLE, 'SHUFFLE', !myReady],
      [BTN_READY, myReady ? 'READY ✓' : 'READY', true]
    ]) {
      ctx.globalAlpha = on ? 1 : 0.3;
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(2, S(0.006));
      ctx.strokeRect(X(btn.x0), Y(btn.y0), S(btn.x1 - btn.x0), S(btn.y1 - btn.y0));
      ctx.fillStyle = color;
      ctx.font = `bold ${Math.round(S(0.038))}px "Courier New", monospace`;
      ctx.fillText(label, X((btn.x0 + btn.x1) / 2), Y((btn.y0 + btn.y1) / 2 + 0.014));
      ctx.globalAlpha = 1;
    }
  }

  function drawBattle(now, color) {
    const me = A.state.solo ? 'host' : myRole();
    const them = foe(me);

    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.font = `${Math.round(S(0.026))}px "Courier New", monospace`;
    ctx.globalAlpha = 0.7;
    ctx.fillText('ENEMY WATERS', X(EG.x0), Y(EG.y0 - 0.018));
    ctx.globalAlpha = 1;

    drawGrid(EG, GRID, color);
    drawShotsOn(EG, them, true);
    if (lastSplash && lastSplash.target === them) drawSplash(EG, now);

    drawGrid(OG, GRID, color);
    drawShipsOn(OG, me);
    drawShotsOn(OG, me, false);
    if (lastSplash && lastSplash.target === me) drawSplash(OG, now);

    fleetBars(0.52, 0.9, them, A.state.solo ? 'ENEMY FLEET' : 'RIVAL FLEET', color);
    fleetBars(0.76, 0.9, me, 'YOUR FLEET', color);
  }

  // Exposed for automated tests; not part of the game logic
  A.state.bsDebug = () => ({
    phase, turn, myReady, theirReady, gameOver,
    ships: {
      host: ships.host ? ships.host.map(s => s.cells) : null,
      guest: ships.guest ? ships.guest.map(s => s.cells) : null
    },
    shots: { host: [...shotAt.host], guest: [...shotAt.guest] },
    sunk: { host: sunkCount('host'), guest: sunkCount('guest') },
    hits: { host: hitsOn('host'), guest: hitsOn('guest') }
  });
})();
