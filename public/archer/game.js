/*
 * ARCHER - a Bowman-style archery duel on one shared field.
 *
 * Two stick archers stand on floating platforms that ride up and down.
 * There are NO turns: drag to draw the bow (angle + power), release to
 * loose an arrow, and shoot again as soon as the next arrow is nocked
 * (a short cooldown). Pure gravity, no wind.
 *
 * A body hit is 1 point, a HEAD SHOT pays 2; every hit re-deals the
 * duel - fresh distances and fresh platform waves from the host's seed.
 * Missed arrows stick in the ground until then. Most points when the
 * match clock runs out wins.
 *
 * Networking model: platform motion is a seeded sine over a shared
 * round clock, and - like PONG's ball ownership - each phone is the
 * AUTHORITY on arrows hitting its own archer: the victim detects the
 * hit on itself and tells the shooter, so tiny clock drift can never
 * make the phones disagree about a hit.
 *
 * Solo mode: target practice against a dummy riding its own platform.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { X, Y, S, ctx } = A;

  // Landscape court (matches the engine's landscape constants)
  const CW = 1.6;
  const PH = 0.8;
  const GY = 0.72;               // ground line (arrows can fly under platforms)
  const G = 0.55;                // gravity, court units / s^2
  const DT = 1 / 120;            // fixed physics step
  const COOLDOWN = 1400;         // ms between arrows
  const PLAT_W = 0.1, PLAT_H = 0.012;
  const HEAD_R = 0.024;
  const BLUE = '#5ad0ff', ORANGE = '#ffb04f', GRAY = '#9aa7b0';

  // Deterministic PRNG so both phones deal identical duels
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
  let roundN = 0;                // re-deal counter: bumps on every hit
  let worldReady = false;
  let gt = 0;                    // round clock driving the platform waves
  let pos = { host: 0.2, guest: 1.4 };
  let plat = {                   // per-archer platform wave
    host: { amp: 0.1, om: 1, ph: 0 },
    guest: { amp: 0.1, om: 1, ph: 0 }
  };
  let arrows = [];               // in flight: {id, from, x, y, vx, vy, age, trail}
  let stuck = [];                // arrows in the ground {x, y, ang}
  let nextId = 1;
  let lastFireAt = -1e9;
  let aim = null;
  let lastShot = null;
  let acc = 0;
  let lastGts = 0;
  let nextPoke = 0;
  let hostDealDeadline = Infinity;
  let fsTried = false;

  const myRole = () => A.state.role;
  const foe = (r) => (r === 'host' ? 'guest' : 'host');
  const canFire = () => worldReady && performance.now() - lastFireAt > COOLDOWN;

  // Platform center height at round-time t (seeded sine, same on both phones)
  const platY = (role, t) => 0.48 - plat[role].amp * Math.sin(plat[role].om * t + plat[role].ph);
  const feetY = (role, t) => platY(role, t) - PLAT_H / 2;

  function placeArchers() {
    const rnd = mulberry32((seed ^ 0x9E3779B9) + roundN * 613);
    pos.host = 0.10 + rnd() * 0.25;
    pos.guest = CW - 0.10 - rnd() * 0.25;
    for (const role of ['host', 'guest']) {
      plat[role] = {
        amp: 0.08 + rnd() * 0.08,          // 0.08..0.16
        om: 0.9 + rnd() * 0.8,             // rad/s
        ph: rnd() * Math.PI * 2
      };
    }
    stuck = [];
    arrows = [];
    gt = 0;
  }

  function applyWorld(s) {
    seed = s;
    roundN = 0;
    aim = null;
    lastShot = null;
    acc = 0;
    placeArchers();
    worldReady = true;
  }

  function dealWorld() {
    const s = Math.floor(Math.random() * 1e9) + 1;
    if (!A.state.solo) A.send({ type: 'world', seed: s });
    applyWorld(s);
  }

  // Every confirmed hit re-deals the duel; the host announces it
  function nextRound() {
    roundN += 1;
    if (!A.state.solo) A.send({ type: 'round', n: roundN });
    placeArchers();
  }

  // ---- Shooting & flight ------------------------------------------------------

  // 'head' | 'body' | null against `role`'s archer at round-time t
  function hitTestAt(role, x, y, t) {
    const ax = pos[role], fy = feetY(role, t);
    if (Math.hypot(x - ax, y - (fy - 0.095)) < HEAD_R) return 'head';
    if (Math.abs(x - ax) < 0.02 && y > fy - 0.078 && y <= fy) return 'body';
    return null;
  }

  function spawnArrow(from, id, a10, p, y0) {
    const r = (a10 / 10) * Math.PI / 180;
    const v0 = 0.3 + (p / 100) * 1.0;
    const dir = from === 'host' ? 1 : -1;
    arrows.push({
      id, from,
      x: pos[from] + dir * 0.035,
      y: y0,
      vx: Math.cos(r) * v0,
      vy: -Math.sin(r) * v0,
      age: 0, trail: [], trailT: 0
    });
    A.beep(600, 0.06);
  }

  function myFire(a10, p) {
    const id = nextId++;
    const y0 = feetY(myRole() || 'host', gt) - 0.06;
    A.send({ type: 'shot', id, a: a10, p, y: Math.round(y0 * 1000) / 1000 });
    spawnArrow(A.state.solo ? 'host' : myRole(), id, a10, p, y0);
    lastShot = { a: Math.round(a10 / 10), p };
    lastFireAt = performance.now();
  }

  // The shooter learns about its hit from the victim's phone
  function confirmedHit(hit) {
    const pts = hit === 'head' ? 2 : 1;
    A.addScore(pts);
    A.flash(hit === 'head' ? 'HEAD SHOT! +2' : 'HIT! +1');
    A.sndScore();
  }

  function physStep() {
    const me = A.state.solo ? 'host' : myRole();
    for (let i = arrows.length - 1; i >= 0; i--) {
      const ar = arrows[i];
      ar.age += DT;
      ar.vy += G * DT;
      ar.x += ar.vx * DT;
      ar.y += ar.vy * DT;
      ar.trailT += DT;
      if (ar.trailT > 0.05) {
        ar.trailT = 0;
        ar.trail.push([ar.x, ar.y]);
        if (ar.trail.length > 14) ar.trail.shift();
      }
      if (ar.x < -0.1 || ar.x > CW + 0.1) { arrows.splice(i, 1); continue; }

      if (ar.age > 0.05) {
        if (ar.from !== me) {
          // I am the authority on arrows hitting MY archer
          const hit = hitTestAt(me, ar.x, ar.y, gt);
          if (hit) {
            arrows.splice(i, 1);
            A.send({ type: 'ouch', id: ar.id, hit });
            A.flash('YOU TOOK A HIT!');
            A.beep(120, 0.25);
            if (myRole() === 'host') nextRound();
            continue;
          }
        } else if (A.state.solo) {
          // Solo: the dummy has no phone, so I judge my own arrows
          const hit = hitTestAt('guest', ar.x, ar.y, gt);
          if (hit) {
            arrows.splice(i, 1);
            confirmedHit(hit);
            roundN += 1;
            placeArchers();
            continue;
          }
        }
      }

      if (ar.y >= GY) {
        stuck.push({ x: ar.x, y: GY, ang: Math.atan2(ar.vy, ar.vx) });
        if (stuck.length > 24) stuck.shift();
        arrows.splice(i, 1);
        A.beep(226, 0.04);
      }
    }
  }

  // Ghost shot for the test helper: tracks the moving target platform
  function ghostShot(a, p) {
    const me = A.state.solo ? 'host' : myRole();
    const target = foe(me);
    const r = a * Math.PI / 180, v0 = 0.3 + (p / 100) * 1.0;
    const dir = me === 'host' ? 1 : -1;
    let x = pos[me] + dir * 0.035, y = feetY(me, gt) - 0.06;
    let vx = Math.cos(r) * v0, vy = -Math.sin(r) * v0, age = 0;
    for (let i = 0; i < 20000; i++) {
      age += DT; vy += G * DT; x += vx * DT; y += vy * DT;
      if (x < -0.1 || x > CW + 0.1 || y >= GY) return null;
      if (age > 0.05) {
        const hit = hitTestAt(target, x, y, gt + age);
        if (hit) return hit;
      }
    }
    return null;
  }

  // ---- Orientation: ask the phone to lie sideways ----------------------------

  function tryRotate() {
    try {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => {});
      }
    } catch { /* not supported (iOS): the rotate hint covers it */ }
  }

  function tryFullscreenOnce() {
    if (fsTried || window.innerWidth >= window.innerHeight) return;
    fsTried = true;
    try {
      const p = document.documentElement.requestFullscreen &&
        document.documentElement.requestFullscreen();
      if (p && p.then) p.then(tryRotate).catch(() => {});
    } catch { /* fine without it */ }
  }

  // ---- Registration -----------------------------------------------------------

  A.register({
    game: 'archer',
    title: 'ARCHER',
    solo: true,
    landscape: true,

    onStart() {
      fsTried = false;
      worldReady = false;
      hostDealDeadline = Infinity;
      lastFireAt = -1e9;
      if (A.state.solo || A.state.role === 'host') {
        dealWorld();
      } else {
        nextPoke = performance.now() + 2500;
      }
      tryRotate();
    },

    onResume() {
      worldReady = false;
      arrows = [];
      aim = null;
      A.send({ type: 'state_req' });
      nextPoke = performance.now() + 3000;
      hostDealDeadline = A.state.role === 'host' ? performance.now() + 6000 : Infinity;
    },

    onEnd() {
      arrows = [];
      aim = null;
    },

    onMessage(msg) {
      switch (msg.type) {
        case 'world':
          applyWorld(Number(msg.seed) || 1);
          hostDealDeadline = Infinity;
          break;

        case 'round':
          roundN = Number(msg.n) || 0;
          placeArchers();
          break;

        case 'shot':
          spawnArrow(foe(myRole()), Number(msg.id) || 0, Number(msg.a) || 0,
            Math.max(10, Math.min(100, Number(msg.p) || 10)),
            Number(msg.y) || feetY(foe(myRole()), gt) - 0.06);
          break;

        case 'ouch': {
          // My arrow connected: the victim's phone is the referee
          confirmedHit(msg.hit === 'head' ? 'head' : 'body');
          const k = arrows.findIndex(ar => ar.id === Number(msg.id) &&
            ar.from === myRole());
          if (k >= 0) arrows.splice(k, 1);
          if (myRole() === 'host') nextRound();
          break;
        }

        case 'gts':
          // Gentle round-clock resync from the host (same round only,
          // so a stale tick can't fight a fresh re-deal)
          if (Number(msg.n) === roundN && typeof msg.t === 'number' &&
              Math.abs(gt - msg.t) > 0.12) gt = msg.t;
          break;

        case 'state_req':
          if (worldReady) {
            A.send({ type: 'state', seed, roundN, t: Math.round(gt * 100) / 100 });
          }
          break;

        case 'state':
          seed = Number(msg.seed) || 1;
          roundN = Number(msg.roundN) || 0;
          placeArchers();
          gt = Number(msg.t) || 0;
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

      const dx = aim.x - aim.sx, dy = aim.y - aim.sy;
      const len = Math.hypot(dx, dy);
      aim = null;
      if (len < 0.03 || !canFire()) return;
      const a10 = Math.round(Math.atan2(-dy, dx) * 1800 / Math.PI);
      const p = Math.max(10, Math.min(100, Math.round((len / 0.5) * 100)));
      myFire(a10, p);
    },

    step(dt, now) {
      if (!worldReady) {
        if (!A.state.solo && now > nextPoke) {
          nextPoke = now + 3000;
          A.send({ type: 'state_req' });
        }
        if (now > hostDealDeadline) {
          hostDealDeadline = Infinity;
          dealWorld();
        }
        return;
      }
      // Platforms and arrows share one fixed-step clock
      acc = Math.min(acc + dt, 0.25);
      while (acc >= DT) {
        acc -= DT;
        gt += DT;
        if (arrows.length) physStep();
      }
      if (!A.state.solo && A.state.role === 'host' && now - lastGts > 4000) {
        lastGts = now;
        A.send({ type: 'gts', t: Math.round(gt * 100) / 100, n: roundN });
      }
    },

    draw(now, color) {
      if (!worldReady) {
        ctx.textAlign = 'center';
        ctx.font = `${Math.round(S(0.04))}px "Courier New", monospace`;
        if (Math.floor(now / 400) % 2 === 0) {
          ctx.fillText('PACING OUT THE FIELD...', X(CW / 2), Y(PH / 2));
        }
        return;
      }

      // Field: flat ground with grass ticks
      ctx.fillStyle = '#16321a';
      ctx.fillRect(X(0), Y(GY), S(CW), S(PH - GY));
      ctx.strokeStyle = '#49a94f';
      ctx.lineWidth = Math.max(2, S(0.005));
      ctx.beginPath();
      ctx.moveTo(X(0), Y(GY));
      ctx.lineTo(X(CW), Y(GY));
      ctx.stroke();
      for (let gx = 0.04; gx < CW; gx += 0.08) {
        ctx.beginPath();
        ctx.moveTo(X(gx), Y(GY));
        ctx.lineTo(X(gx + 0.012), Y(GY - 0.018));
        ctx.stroke();
      }

      // Arrows stuck in the ground from earlier misses
      ctx.strokeStyle = GRAY;
      ctx.lineWidth = Math.max(2, S(0.004));
      for (const st of stuck) {
        ctx.beginPath();
        ctx.moveTo(X(st.x), Y(st.y));
        ctx.lineTo(X(st.x - Math.cos(st.ang) * 0.035), Y(st.y - Math.sin(st.ang) * 0.035));
        ctx.stroke();
      }

      // Platforms riding their waves, archers on top
      const av = aimInfo();
      for (const role of ['host', 'guest']) {
        const mine = !A.state.solo ? role === myRole() : role === 'host';
        const dummy = A.state.solo && role === 'guest';
        const fy = feetY(role, gt);
        const col = dummy ? GRAY : (role === 'host' ? BLUE : ORANGE);
        ctx.fillStyle = GRAY;
        ctx.fillRect(X(pos[role] - PLAT_W / 2), Y(fy), S(PLAT_W), S(PLAT_H));
        ctx.fillRect(X(pos[role] - 0.004), Y(fy + PLAT_H), S(0.008), S(0.02));
        drawArcher(pos[role], role === 'host' ? 1 : -1, col, fy,
          mine && av ? av.a : null);
        if (mine) {
          ctx.fillStyle = color;
          ctx.textAlign = 'center';
          ctx.font = `bold ${Math.round(S(0.024))}px "Courier New", monospace`;
          ctx.fillText('YOU', X(pos[role]), Y(fy - 0.15));
        }
      }

      // Aim arrow while drawing the bow
      if (av && canFire()) {
        const me = A.state.solo ? 'host' : myRole();
        const r = av.a * Math.PI / 180;
        const L = 0.08 + (av.p / 100) * 0.2;
        const bx = pos[me], by = feetY(me, gt) - 0.06;
        const tipX = bx + Math.cos(r) * L, tipY = by - Math.sin(r) * L;
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, S(0.005));
        ctx.beginPath();
        ctx.moveTo(X(bx), Y(by));
        ctx.lineTo(X(tipX), Y(tipY));
        const hr = r + Math.PI * 0.85, hl = r - Math.PI * 0.85;
        ctx.moveTo(X(tipX), Y(tipY));
        ctx.lineTo(X(tipX + Math.cos(hr) * 0.02), Y(tipY - Math.sin(hr) * 0.02));
        ctx.moveTo(X(tipX), Y(tipY));
        ctx.lineTo(X(tipX + Math.cos(hl) * 0.02), Y(tipY - Math.sin(hl) * 0.02));
        ctx.stroke();
      }

      // Arrows in flight (drawn along their velocity) with trails
      for (const ar of arrows) {
        ctx.fillStyle = color;
        for (let i = 0; i < ar.trail.length; i++) {
          ctx.globalAlpha = 0.1 + 0.4 * (i / ar.trail.length);
          ctx.fillRect(X(ar.trail[i][0]) - 1, Y(ar.trail[i][1]) - 1, 2, 2);
        }
        ctx.globalAlpha = 1;
        const ang = Math.atan2(ar.vy, ar.vx);
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, S(0.005));
        ctx.beginPath();
        ctx.moveTo(X(ar.x - Math.cos(ang) * 0.03), Y(ar.y - Math.sin(ang) * 0.03));
        ctx.lineTo(X(ar.x), Y(ar.y));
        ctx.stroke();
      }

      // HUD: angle/power readout + reload state
      const info = av || lastShot;
      ctx.fillStyle = color;
      if (info) {
        ctx.textAlign = 'right';
        ctx.font = `bold ${Math.round(S(0.03))}px "Courier New", monospace`;
        ctx.fillText(Math.round(info.a) + '° · ' + info.p + '%', X(CW - 0.02), Y(0.055));
      }
      if (!canFire()) {
        ctx.textAlign = 'left';
        ctx.font = `bold ${Math.round(S(0.03))}px "Courier New", monospace`;
        ctx.fillText('NOCKING...', X(0.02), Y(0.055));
      }

      // Rotate hint while the phone is held upright
      if (window.innerHeight > window.innerWidth && Math.floor(now / 600) % 2 === 0) {
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.font = `bold ${Math.round(S(0.045))}px "Courier New", monospace`;
        ctx.fillText('TURN YOUR PHONE SIDEWAYS', X(CW / 2), Y(0.22));
      }
    },

    status() {
      if (!worldReady) return 'PACING OUT THE FIELD...';
      if (!canFire()) return null;
      return A.state.solo
        ? 'HIT THE DUMMY · SHOOT AT WILL'
        : 'NO TURNS · DRAG TO AIM, RELEASE TO SHOOT';
    }
  });

  // A chunky stick archer standing at feet height fy
  function drawArcher(ax, dir, col, fy, aimDeg) {
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(2, S(0.008));
    ctx.beginPath();
    ctx.arc(X(ax), Y(fy - 0.095), S(0.018), 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(X(ax), Y(fy - 0.077));
    ctx.lineTo(X(ax), Y(fy - 0.03));
    ctx.lineTo(X(ax - 0.014), Y(fy));
    ctx.moveTo(X(ax), Y(fy - 0.03));
    ctx.lineTo(X(ax + 0.014), Y(fy));
    ctx.stroke();
    const base = aimDeg !== null ? aimDeg * Math.PI / 180 : (dir > 0 ? 0.6 : Math.PI - 0.6);
    ctx.beginPath();
    ctx.arc(X(ax + Math.cos(base) * 0.032), Y(fy - 0.06 - Math.sin(base) * 0.032),
      S(0.026), base - Math.PI / 2, base + Math.PI / 2);
    ctx.stroke();
  }

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
  A.state.arDebug = () => ({
    ready: worldReady, seed, roundN,
    gt: Math.round(gt * 100) / 100,
    hostX: Math.round(pos.host * 1000) / 1000,
    guestX: Math.round(pos.guest * 1000) / 1000,
    hostY: Math.round(feetY('host', gt) * 1000) / 1000,
    guestY: Math.round(feetY('guest', gt) * 1000) / 1000,
    arrows: arrows.length, stuck: stuck.length, canFire: canFire()
  });
  A.state.arFire = (a10, p) => {
    if (!canFire()) return false;
    myFire(a10, p);
    return true;
  };
  A.state.arSolve = () => {
    for (let a = 20; a <= 160; a += 2) {
      for (let p = 15; p <= 100; p += 3) {
        const hit = ghostShot(a, p);
        if (hit) return { a, p, hit };
      }
    }
    return null;
  };
})();
