/*
 * TANKS - Pocket Tanks style artillery duel on a SHARED battlefield.
 *
 * Both phones show the exact same landscape battlefield: rolling terrain
 * dealt by the host from one seed, the blue tank on the left (host) and
 * the orange tank on the right (guest). Players take turns: drag anywhere
 * to aim (the arrow grows out of your tank), release to fire. Shots carve
 * craters out of the terrain, wind changes every volley, and landing a
 * shell near the rival scores points by proximity - direct hits pay best.
 * Tap the weapon box to cycle weapons. Highest score when the clock runs
 * out wins.
 *
 * The court is the engine's landscape variant (1.6 x 1): the game asks
 * the phone for landscape orientation and shows a rotate hint while the
 * phone is held upright.
 *
 * Solo mode is target practice: bullseyes on the terrain, unlimited shots.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { X, Y, S, ctx } = A;

  // Landscape court (must match the engine's landscape constants)
  const CW = 1.6;
  const PH = 0.8;

  const N = 168;                 // terrain columns
  const STEP = CW / (N - 1);
  const GROUND_MAX = 0.795;      // just above the dashed line
  const HOST_I = 20;
  const GUEST_I = N - 21;
  const G = 0.55;                // gravity, court units / s^2
  const DT = 1 / 120;            // fixed physics step: identical on both phones

  // Blast radii: SHELL is the reference; BIG ONE blows a much wider hole
  // but pays LESS than the default shell, and TRIPLE's little explosions
  // are 25% smaller than the shell's.
  const WEAPONS = [
    { name: 'SHELL',   blast: 0.072, pts: 20, n: 1 },
    { name: 'BIG ONE', blast: 0.128, pts: 15, n: 1 },
    { name: 'TRIPLE',  blast: 0.054, pts: 12, n: 3, spread: 6 },
    { name: 'DIGGER',  blast: 0.16,  pts: 8,  n: 1 }
  ];

  // Deterministic PRNG so both phones build the identical battlefield
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let seed = 1;
  let ground = [];               // surface y per column (bigger = lower)
  let worldReady = false;
  const tanks = {
    host:  { x: HOST_I * STEP,  y: 0, i: HOST_I,  barrel: 60 },
    guest: { x: GUEST_I * STEP, y: 0, i: GUEST_I, barrel: 120 }
  };
  let turn = 'host';
  let volley = 0;
  let wind = 0;
  let myWeapon = 0;
  let shots = [];                // live projectiles
  let booms = [];                // explosion rings (visual only)
  let firedThisVolley = false;
  let acc = 0;                   // fixed-step accumulator
  let aim = null;                // {sx, sy, x, y} while dragging
  let lastShot = null;           // {a, p} for the HUD readout
  let targets = [];              // solo bullseyes: {x} (they sit on the surface)
  let nextWorldPoke = 0;
  let hostDealDeadline = Infinity;
  let fsTried = false;

  const myRole = () => A.state.role;
  const canFire = () =>
    worldReady && !shots.length && !firedThisVolley &&
    (A.state.solo || turn === myRole());

  // Every volley's wind comes from the seed, so both phones agree on it
  function windFor(v) {
    const rnd = mulberry32((seed ^ 0x5DEECE66) + v * 7919);
    return Math.round((rnd() * 2 - 1) * 12) / 100; // -0.12 .. 0.12
  }

  function groundAtX(x) {
    const t = Math.max(0, Math.min(N - 1.001, x / STEP));
    const i = Math.floor(t), f = t - i;
    return ground[i] * (1 - f) + ground[i + 1] * f;
  }

  function settleTanks() {
    tanks.host.y = ground[HOST_I];
    tanks.guest.y = ground[GUEST_I];
  }

  function buildWorld(s) {
    seed = s;
    const rnd = mulberry32(s);
    // Rolling hills: control points with cosine interpolation
    const K = 24;
    const pts = [];
    for (let i = 0; i <= Math.ceil((N - 1) / K) + 1; i++) pts.push(0.42 + rnd() * 0.3);
    ground = [];
    for (let i = 0; i < N; i++) {
      const t = i / K, j = Math.floor(t), f = t - j;
      const c = (1 - Math.cos(f * Math.PI)) / 2;
      ground.push(Math.min(GROUND_MAX, pts[j] * (1 - c) + pts[j + 1] * c));
    }
    // Flatten a small pad under each tank
    for (const ti of [HOST_I, GUEST_I]) {
      for (let d = -3; d <= 3; d++) {
        if (ground[ti + d] !== undefined) ground[ti + d] = ground[ti];
      }
    }
    settleTanks();
  }

  function spawnTarget() {
    for (let tries = 0; tries < 60; tries++) {
      const x = 0.22 + Math.random() * (CW - 0.44);
      if (Math.abs(x - tanks.host.x) < 0.24) continue;
      if (targets.some(t => Math.abs(t.x - x) < 0.2)) continue;
      return { x };
    }
    return { x: CW * 0.72 };
  }

  function applyWorld(s) {
    buildWorld(s);
    turn = 'host';
    volley = 0;
    wind = windFor(0);
    shots = [];
    booms = [];
    firedThisVolley = false;
    acc = 0;
    aim = null;
    lastShot = null;
    worldReady = true;
    if (A.state.solo) targets = [spawnTarget(), spawnTarget(), spawnTarget()];
  }

  // The host deals the battlefield, like FLAPPY deals its pipe courses
  function dealWorld() {
    const s = Math.floor(Math.random() * 1e9) + 1;
    if (!A.state.solo) A.send({ type: 'world', seed: s });
    applyWorld(s);
  }

  // ---- Firing & simulation (identical on both phones) ----------------------

  // Angle arrives in tenths of a degree and power as an integer, so both
  // phones integrate the exact same shot with the fixed timestep.
  function fire(from, a10, p, w) {
    const wp = WEAPONS[w];
    const t = tanks[from];
    const n = wp.n || 1;
    for (let k = 0; k < n; k++) {
      const a = a10 / 10 + (wp.spread || 0) * (k - (n - 1) / 2);
      const r = a * Math.PI / 180;
      const v0 = 0.28 + (p / 100) * 0.92;
      shots.push({
        x: t.x + Math.cos(r) * 0.055,
        y: t.y - 0.02 - Math.sin(r) * 0.055,
        vx: Math.cos(r) * v0,
        vy: -Math.sin(r) * v0,
        w, from, age: 0, trailT: 0, trail: []
      });
    }
    t.barrel = a10 / 10;
    lastShot = { a: Math.round(a10 / 10), p };
    firedThisVolley = true;
    A.beep(320, 0.08);
  }

  function explode(s) {
    const wp = WEAPONS[s.w];
    const cy = Math.min(s.y, groundAtX(s.x));

    // Carve the crater: the surface drops to the bottom edge of the blast
    for (let i = 0; i < N; i++) {
      const dx = Math.abs(i * STEP - s.x);
      if (dx < wp.blast) {
        const dig = cy + Math.sqrt(wp.blast * wp.blast - dx * dx);
        if (dig > ground[i]) ground[i] = Math.min(GROUND_MAX, dig);
      }
    }
    settleTanks();
    booms.push({ x: s.x, y: cy, r: wp.blast, born: performance.now() });
    A.beep(130, 0.25);

    const R = wp.blast + 0.035;

    if (A.state.solo) {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const d = Math.hypot(t.x - s.x, (groundAtX(t.x) - 0.025) - cy);
        if (d < R) {
          const pts = Math.max(1, Math.round(wp.pts * (1 - d / R)));
          A.addScore(pts);
          A.flash('+' + pts + ' TARGET!');
          A.sndScore();
          targets[i] = spawnTarget();
        }
      }
      return;
    }

    // Points by proximity - only the shooter's phone scores; the engine
    // relays the new total to the rival.
    const other = s.from === 'host' ? 'guest' : 'host';
    const enemy = tanks[other];
    const dE = Math.hypot(enemy.x - s.x, (enemy.y - 0.02) - cy);
    if (s.from === myRole()) {
      if (dE < R) {
        const pts = Math.max(1, Math.round(wp.pts * (1 - dE / R)));
        A.addScore(pts);
        A.flash(dE < 0.045 ? 'DIRECT HIT! +' + pts : 'HIT! +' + pts);
        A.sndScore();
      } else {
        const self = tanks[s.from];
        if (Math.hypot(self.x - s.x, (self.y - 0.02) - cy) < R) {
          A.flash('YOU SHELLED YOURSELF!');
        }
      }
    }
  }

  function endVolley() {
    firedThisVolley = false;
    if (!A.state.solo) turn = turn === 'host' ? 'guest' : 'host';
    volley += 1;
    wind = windFor(volley);
  }

  function physStep() {
    for (let i = shots.length - 1; i >= 0; i--) {
      const s = shots[i];
      s.age += DT;
      s.vx += wind * DT;
      s.vy += G * DT;
      s.x += s.vx * DT;
      s.y += s.vy * DT;
      s.trailT += DT;
      if (s.trailT > 0.05) {
        s.trailT = 0;
        s.trail.push([s.x, s.y]);
        if (s.trail.length > 14) s.trail.shift();
      }
      if (s.x < -0.15 || s.x > CW + 0.15 || s.y > 1.4) {
        shots.splice(i, 1);
        continue;
      }
      if (s.age > 0.04 && s.y >= groundAtX(s.x)) {
        shots.splice(i, 1);
        explode(s);
      }
    }
    if (firedThisVolley && shots.length === 0) endVolley();
  }

  // Pure simulation of one shot on the current terrain (used by the test
  // helper tkSolve to find a hitting angle/power pair)
  function ghostShot(from, a, p) {
    const t = tanks[from];
    const r = a * Math.PI / 180, v0 = 0.28 + (p / 100) * 0.92;
    let x = t.x + Math.cos(r) * 0.055, y = t.y - 0.02 - Math.sin(r) * 0.055;
    let vx = Math.cos(r) * v0, vy = -Math.sin(r) * v0, age = 0;
    for (let i = 0; i < 30000; i++) {
      age += DT; vx += wind * DT; vy += G * DT; x += vx * DT; y += vy * DT;
      if (x < -0.15 || x > CW + 0.15 || y > 1.4) return null;
      if (age > 0.04 && y >= groundAtX(x)) return { x, y };
    }
    return null;
  }

  // ---- Orientation: ask the phone to lie sideways ---------------------------

  function tryRotate() {
    try {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => {});
      }
    } catch { /* not supported (iOS): the rotate hint covers it */ }
  }

  function tryFullscreenOnce() {
    // Landscape lock only works in fullscreen on most phones; try once
    // per match on the first touch (a user gesture), never insist.
    if (fsTried || window.innerWidth >= window.innerHeight) return;
    fsTried = true;
    try {
      const p = document.documentElement.requestFullscreen &&
        document.documentElement.requestFullscreen();
      if (p && p.then) p.then(tryRotate).catch(() => {});
    } catch { /* fine without it */ }
  }

  // ---- Registration ---------------------------------------------------------

  A.register({
    game: 'tanks',
    title: 'TANKS',
    solo: true,
    landscape: true,

    onStart() {
      fsTried = false;
      worldReady = false;
      hostDealDeadline = Infinity;
      if (A.state.solo || A.state.role === 'host') {
        dealWorld();
      } else {
        nextWorldPoke = performance.now() + 2500;
      }
      tryRotate();
    },

    onResume() {
      // Our terrain is gone after a reload: ask the rival for the world.
      // If nobody answers (both reloaded), the host deals a fresh one.
      worldReady = false;
      shots = [];
      booms = [];
      aim = null;
      A.send({ type: 'state_req' });
      nextWorldPoke = performance.now() + 3000;
      hostDealDeadline = A.state.role === 'host' ? performance.now() + 6000 : Infinity;
    },

    onEnd() {
      shots = [];
      booms = [];
      aim = null;
    },

    onMessage(msg) {
      switch (msg.type) {
        case 'world':
          applyWorld(Number(msg.seed) || 1);
          hostDealDeadline = Infinity;
          break;

        case 'shot':
          // Only ever sent on the sender's turn; simulate it here too
          fire(turn, Number(msg.a) || 0,
            Math.max(10, Math.min(100, Number(msg.p) || 10)),
            Math.min(WEAPONS.length - 1, Math.max(0, Number(msg.w) || 0)));
          break;

        case 'state_req':
          if (worldReady) {
            A.send({
              type: 'state',
              seed,
              ground: ground.map(g => Math.round(g * 1000) / 1000),
              turn,
              volley
            });
          }
          break;

        case 'state':
          seed = Number(msg.seed) || 1;
          ground = msg.ground.map(Number);
          turn = msg.turn === 'guest' ? 'guest' : 'host';
          volley = Number(msg.volley) || 0;
          wind = windFor(volley);
          shots = [];
          booms = [];
          firedThisVolley = false;
          settleTanks();
          worldReady = true;
          hostDealDeadline = Infinity;
          break;
      }
    },

    onPointer(ph, x, y) {
      if (A.state.phase !== 'playing') return;
      if (ph === 'down') {
        tryFullscreenOnce();
        if (worldReady) aim = { sx: x, sy: y, x, y };
        return;
      }
      if (!aim) return;
      if (ph === 'move') { aim.x = x; aim.y = y; return; }

      // Release: a tiny drag is a tap (weapon box), a real drag fires
      const dx = aim.x - aim.sx, dy = aim.y - aim.sy;
      const len = Math.hypot(dx, dy);
      const inWeaponBox = aim.sx < 0.42 && aim.sy < 0.1;
      aim = null;
      if (len < 0.03) {
        if (inWeaponBox && canFire()) {
          myWeapon = (myWeapon + 1) % WEAPONS.length;
          A.beep(500, 0.04);
        }
        return;
      }
      if (!canFire()) return;
      const a10 = Math.round(Math.atan2(-dy, dx) * 1800 / Math.PI);
      const p = Math.max(10, Math.min(100, Math.round((len / 0.5) * 100)));
      A.send({ type: 'shot', a: a10, p, w: myWeapon });
      fire(myRole(), a10, p, myWeapon);
    },

    step(dt, now) {
      if (!worldReady) {
        // Guest waiting for the world / resumed player waiting for state
        if (!A.state.solo && now > nextWorldPoke) {
          nextWorldPoke = now + 3000;
          A.send({ type: 'state_req' });
        }
        if (now > hostDealDeadline) {
          hostDealDeadline = Infinity;
          dealWorld();
        }
        return;
      }
      if (shots.length) {
        acc = Math.min(acc + dt, 0.25);
        while (acc >= DT) {
          acc -= DT;
          physStep();
          if (!shots.length) { acc = 0; break; }
        }
      }
    },

    draw(now, color) {
      if (!worldReady) {
        ctx.textAlign = 'center';
        ctx.font = `${Math.round(S(0.04))}px "Courier New", monospace`;
        if (Math.floor(now / 400) % 2 === 0) {
          ctx.fillText('BUILDING THE BATTLEFIELD...', X(CW / 2), Y(PH / 2));
        }
        return;
      }

      // Terrain: dark green fill with a bright surface line
      ctx.fillStyle = '#16321a';
      ctx.beginPath();
      ctx.moveTo(X(0), Y(ground[0]));
      for (let i = 1; i < N; i++) ctx.lineTo(X(i * STEP), Y(ground[i]));
      ctx.lineTo(X(CW), Y(PH));
      ctx.lineTo(X(0), Y(PH));
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#49a94f';
      ctx.lineWidth = Math.max(2, S(0.005));
      ctx.beginPath();
      ctx.moveTo(X(0), Y(ground[0]));
      for (let i = 1; i < N; i++) ctx.lineTo(X(i * STEP), Y(ground[i]));
      ctx.stroke();

      // Solo bullseyes sitting on the surface
      if (A.state.solo) {
        for (const t of targets) {
          const ty = groundAtX(t.x) - 0.025;
          ctx.strokeStyle = '#ff5252';
          ctx.lineWidth = Math.max(2, S(0.006));
          ctx.strokeRect(X(t.x - 0.024), Y(ty - 0.024), S(0.048), S(0.048));
          ctx.fillStyle = '#ff5252';
          ctx.fillRect(X(t.x - 0.007), Y(ty - 0.007), S(0.014), S(0.014));
        }
      }

      // Tanks: host blue on the left, guest orange on the right, on BOTH
      // phones - the battlefield view is shared.
      const av = aimInfo();
      for (const role of A.state.solo ? ['host'] : ['host', 'guest']) {
        const t = tanks[role];
        const mine = role === myRole();
        const barrel = (mine && av) ? av.a : t.barrel;
        const r = barrel * Math.PI / 180;
        ctx.fillStyle = role === 'host' ? '#5ad0ff' : '#ffb04f';
        ctx.fillRect(X(t.x - 0.028), Y(t.y - 0.024), S(0.056), S(0.024)); // hull
        ctx.fillRect(X(t.x - 0.014), Y(t.y - 0.038), S(0.028), S(0.016)); // dome
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = Math.max(2, S(0.007));
        ctx.beginPath();
        ctx.moveTo(X(t.x), Y(t.y - 0.032));
        ctx.lineTo(X(t.x + Math.cos(r) * 0.05), Y(t.y - 0.032 - Math.sin(r) * 0.05));
        ctx.stroke();
        if (mine) {
          ctx.fillStyle = color;
          ctx.textAlign = 'center';
          ctx.font = `bold ${Math.round(S(0.024))}px "Courier New", monospace`;
          ctx.fillText('YOU', X(t.x), Y(t.y - 0.055));
        }
      }

      // Aim arrow out of my tank while dragging
      if (av && canFire()) {
        const me = tanks[myRole()];
        const r = av.a * Math.PI / 180;
        const L = 0.09 + (av.p / 100) * 0.2;
        const tipX = me.x + Math.cos(r) * L, tipY = me.y - 0.032 - Math.sin(r) * L;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, S(0.005));
        ctx.beginPath();
        ctx.moveTo(X(me.x), Y(me.y - 0.032));
        ctx.lineTo(X(tipX), Y(tipY));
        const hr = r + Math.PI * 0.85, hl = r - Math.PI * 0.85;
        ctx.moveTo(X(tipX), Y(tipY));
        ctx.lineTo(X(tipX + Math.cos(hr) * 0.025), Y(tipY - Math.sin(hr) * 0.025));
        ctx.moveTo(X(tipX), Y(tipY));
        ctx.lineTo(X(tipX + Math.cos(hl) * 0.025), Y(tipY - Math.sin(hl) * 0.025));
        ctx.stroke();
      }

      // Projectiles and their fading trails
      ctx.fillStyle = color;
      for (const s of shots) {
        for (let i = 0; i < s.trail.length; i++) {
          ctx.globalAlpha = 0.12 + 0.5 * (i / s.trail.length);
          ctx.fillRect(X(s.trail[i][0]) - 1, Y(s.trail[i][1]) - 1, 2, 2);
        }
        ctx.globalAlpha = 1;
        ctx.fillRect(X(s.x) - S(0.007), Y(s.y) - S(0.007), S(0.014), S(0.014));
      }

      // Explosion rings
      for (let i = booms.length - 1; i >= 0; i--) {
        const bm = booms[i];
        const t = (now - bm.born) / 450;
        if (t >= 1) { booms.splice(i, 1); continue; }
        ctx.globalAlpha = 1 - t;
        ctx.strokeStyle = '#ffd24a';
        ctx.lineWidth = Math.max(2, S(0.008));
        ctx.beginPath();
        ctx.arc(X(bm.x), Y(bm.y), S(bm.r * (0.4 + 0.6 * t)), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // HUD - weapon box (tap to cycle), wind, angle/power readout
      ctx.fillStyle = color;
      ctx.font = `bold ${Math.round(S(0.03))}px "Courier New", monospace`;
      ctx.textAlign = 'left';
      if (canFire() || shots.length) {
        const flip = canFire() ? ' ▸' : '';
        ctx.fillText('[ ' + WEAPONS[myWeapon].name + flip + ' ]', X(0.02), Y(0.055));
      }
      ctx.textAlign = 'center';
      const wN = Math.round(Math.abs(wind) * 100);
      const arrows = wN === 0 ? '·' : (wind < 0 ? '<' : '>').repeat(Math.max(1, Math.ceil(wN / 4)));
      ctx.fillText('WIND ' + arrows + ' ' + wN, X(CW / 2), Y(0.055));
      const info = av || lastShot;
      if (info) {
        ctx.textAlign = 'right';
        ctx.fillText(Math.round(info.a) + '° · ' + info.p + '%', X(CW - 0.02), Y(0.055));
      }

      // Rotate hint while the phone is held upright
      if (window.innerHeight > window.innerWidth && Math.floor(now / 600) % 2 === 0) {
        ctx.textAlign = 'center';
        ctx.font = `bold ${Math.round(S(0.045))}px "Courier New", monospace`;
        ctx.fillText('TURN YOUR PHONE SIDEWAYS', X(CW / 2), Y(0.22));
      }
    },

    status() {
      if (!worldReady) return 'SETTING UP THE BATTLEFIELD...';
      if (shots.length) return null;
      if (A.state.solo) return 'DRAG TO AIM · RELEASE TO FIRE';
      return turn === myRole()
        ? 'YOUR TURN · DRAG TO AIM, RELEASE TO FIRE'
        : 'RIVAL IS AIMING...';
    }
  });

  function aimInfo() {
    if (!aim) return null;
    const dx = aim.x - aim.sx, dy = aim.y - aim.sy;
    const len = Math.hypot(dx, dy);
    if (len < 0.03) return null;
    return {
      a: Math.atan2(-dy, dx) * 180 / Math.PI,
      p: Math.max(10, Math.min(100, Math.round((len / 0.5) * 100)))
    };
  }

  // Exposed for automated tests; not part of the game logic
  A.state.tkDebug = () => ({
    ready: worldReady,
    seed, turn, volley, wind,
    weapon: myWeapon,
    shots: shots.length,
    groundSum: Math.round(ground.reduce((a, b) => a + b, 0) * 10000) / 10000,
    ground0: ground[0],
    tanks: {
      hx: tanks.host.x, hy: tanks.host.y,
      gx: tanks.guest.x, gy: tanks.guest.y
    },
    targets: targets.map(t => t.x),
    canFire: canFire()
  });
  A.state.tkFire = (a10, p, w) => {
    if (!canFire()) return false;
    if (typeof w === 'number') myWeapon = w;
    A.send({ type: 'shot', a: a10, p, w: myWeapon });
    fire(myRole(), a10, p, myWeapon);
    return true;
  };
  A.state.tkSolve = (tx) => {
    let best = null;
    for (let a = 15; a <= 165; a += 3) {
      for (let p = 15; p <= 100; p += 5) {
        const hit = ghostShot(myRole(), a, p);
        if (!hit) continue;
        const err = Math.abs(hit.x - tx);
        if (!best || err < best.err) best = { a, p, err, ix: hit.x };
      }
    }
    return best;
  };
})();
