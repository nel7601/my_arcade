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
  const BLUE = '#5ad0ff', ORANGE = '#ffb04f', GRAY = '#9aa7b0', RED = '#ff3b30';

  // It takes 3 leg hits, 2 body hits or 1 head shot to kill
  const HP_MAX = 6;
  const DMG = { head: 6, body: 3, leg: 2 };

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
  let hp = { host: HP_MAX, guest: HP_MAX };
  let wounds = { host: [], guest: [] };  // open wounds: {zone, drip}
  let blood = [];                // falling droplets {x, y, vy, life}
  let deadRole = null;           // who is ragdolling right now
  let respawnAt = 0;             // when the host re-deals after a death
  let ragdoll = null;            // verlet puppet: {role, pts, cons, drip}
  const RESPAWN_MS = 3000;
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
  const canFire = () =>
    worldReady && !deadRole && performance.now() - lastFireAt > COOLDOWN;

  // Platform center height at round-time t (seeded sine, same on both phones)
  const platY = (role, t) => 0.48 - plat[role].amp * Math.sin(plat[role].om * t + plat[role].ph);
  const feetY = (role, t) => platY(role, t) - PLAT_H / 2;

  // Where a wound of each zone sits on the archer (for blood and marks)
  const zoneY = (role, zone, t) => {
    const fy = feetY(role, t);
    return zone === 'head' ? fy - 0.09 : zone === 'body' ? fy - 0.052 : fy - 0.015;
  };

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
    hp = { host: HP_MAX, guest: HP_MAX };
    wounds = { host: [], guest: [] };
    blood = [];
    deadRole = null;
    ragdoll = null;
  }

  // ---- Ragdoll: a small verlet puppet that tumbles off the platform ----------

  function spawnRagdoll(role, dir) {
    const ax = pos[role], fy = feetY(role, gt);
    const rnd = mulberry32((seed ^ 0xC0FFEE) + roundN * 97 + (role === 'host' ? 0 : 7));
    const rel = [
      [0, -0.095],            // head
      [0, -0.07],             // shoulders
      [0, -0.03],             // hip
      [-0.014, 0],            // left foot
      [0.014, 0],             // right foot
      [(role === 'host' ? 1 : -1) * 0.03, -0.06] // bow hand
    ];
    const kick = 0.25 + rnd() * 0.2;
    const h = 1 / 60; // verlet stores velocity as last-frame displacement
    const pts = rel.map(([ox, oy]) => {
      const vx = dir * kick * (0.7 + rnd() * 0.6);
      const vy = -(0.15 + rnd() * 0.25);
      return { x: ax + ox, y: fy + oy, px: ax + ox - vx * h, py: fy + oy - vy * h };
    });
    const len = (a, b) => Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
    const cons = [[0, 1], [1, 2], [2, 3], [2, 4], [1, 5]].map(([a, b]) => [a, b, len(a, b)]);
    ragdoll = { role, pts, cons, drip: 0 };
  }

  function stepRagdoll(dt) {
    if (!ragdoll) return;
    const d = Math.min(dt, 0.033);
    for (const p of ragdoll.pts) {
      const vx = (p.x - p.px) * 0.995, vy = (p.y - p.py) * 0.995;
      p.px = p.x; p.py = p.y;
      p.x += vx;
      p.y += vy + G * d * d;
      if (p.y > GY) { // ground: bounce a little, drag a lot
        p.y = GY;
        p.px = p.x - vx * 0.4;
        p.py = p.y + vy * 0.35;
      }
    }
    for (let it = 0; it < 3; it++) {
      for (const [a, b, L] of ragdoll.cons) {
        const pa = ragdoll.pts[a], pb = ragdoll.pts[b];
        const dx = pb.x - pa.x, dy = pb.y - pa.y;
        const dist = Math.hypot(dx, dy) || 1e-6;
        const off = (dist - L) / dist / 2;
        pa.x += dx * off; pa.y += dy * off;
        pb.x -= dx * off; pb.y -= dy * off;
      }
    }
    // The body keeps bleeding while it tumbles
    ragdoll.drip -= dt;
    if (ragdoll.drip <= 0 && blood.length < 80) {
      ragdoll.drip = 0.08;
      const hipPt = ragdoll.pts[2];
      blood.push({ x: hipPt.x, y: hipPt.y, vy: 0.02, life: 1 });
    }
  }

  // A death freezes the duel: the loser ragdolls, then the host re-deals
  function startDeath(role, dir) {
    deadRole = role;
    respawnAt = performance.now() + RESPAWN_MS;
    spawnRagdoll(role, dir);
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

  // 'head' | 'body' | 'leg' | null against `role`'s archer at round-time t
  function hitTestAt(role, x, y, t) {
    const ax = pos[role], fy = feetY(role, t);
    if (Math.hypot(x - ax, y - (fy - 0.095)) < HEAD_R) return 'head';
    if (Math.abs(x - ax) < 0.02) {
      if (y > fy - 0.078 && y <= fy - 0.03) return 'body';
      if (y > fy - 0.03 && y <= fy) return 'leg';
    }
    return null;
  }

  // Wound bookkeeping: returns true when the hit is lethal
  function damage(role, zone) {
    hp[role] = Math.max(0, hp[role] - (DMG[zone] || 2));
    wounds[role].push({ zone, drip: 0 });
    return hp[role] <= 0;
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

  // The shooter learns about the outcome from the victim's phone
  function confirmedKill(zone) {
    A.addScore(1);
    A.flash(zone === 'head' ? 'HEAD SHOT! KILL +1' : 'KILL! +1');
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

      if (ar.age > 0.05 && !deadRole) {
        if (ar.from !== me) {
          // I am the authority on arrows hitting MY archer
          const hit = hitTestAt(me, ar.x, ar.y, gt);
          if (hit) {
            const dir = ar.vx >= 0 ? 1 : -1;
            arrows.splice(i, 1);
            const dead = damage(me, hit);
            A.send({ type: 'ouch', id: ar.id, hit, dead });
            A.flash(dead ? 'YOU WERE KILLED!' : "YOU'RE HIT: " + hit.toUpperCase());
            A.beep(120, 0.25);
            if (dead) startDeath(me, dir);
            continue;
          }
        } else if (A.state.solo) {
          // Solo: the dummy has no phone, so I judge my own arrows
          const hit = hitTestAt('guest', ar.x, ar.y, gt);
          if (hit) {
            const dir = ar.vx >= 0 ? 1 : -1;
            arrows.splice(i, 1);
            if (damage('guest', hit)) {
              confirmedKill(hit);
              startDeath('guest', dir);
            } else {
              A.flash('HIT: ' + hit.toUpperCase() + '!');
              A.beep(160, 0.2);
            }
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
          const zone = ['head', 'body', 'leg'].includes(msg.hit) ? msg.hit : 'body';
          const k = arrows.findIndex(ar => ar.id === Number(msg.id) &&
            ar.from === myRole());
          const dir = k >= 0 ? (arrows[k].vx >= 0 ? 1 : -1)
            : (pos[foe(myRole())] >= pos[myRole()] ? 1 : -1);
          if (k >= 0) arrows.splice(k, 1);
          if (msg.dead) {
            confirmedKill(zone);
            damage(foe(myRole()), zone);
            startDeath(foe(myRole()), dir);
          } else {
            damage(foe(myRole()), zone); // mirror the rival's wounds locally
            A.flash('HIT: ' + zone.toUpperCase() + '!');
            A.beep(160, 0.2);
          }
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
            A.send({
              type: 'state', seed, roundN, t: Math.round(gt * 100) / 100,
              hp,
              wz: { host: wounds.host.map(w => w.zone), guest: wounds.guest.map(w => w.zone) },
              dead: deadRole
            });
          }
          break;

        case 'state':
          seed = Number(msg.seed) || 1;
          roundN = Number(msg.roundN) || 0;
          placeArchers();
          gt = Number(msg.t) || 0;
          // A reload must not heal anyone: wounds and hp travel too
          if (msg.hp) {
            // In a live round hp is always 1..HP_MAX (0 re-deals instantly)
            const cl = (v) => (Number.isFinite(v) ? Math.max(1, Math.min(HP_MAX, v)) : HP_MAX);
            hp = { host: cl(Number(msg.hp.host)), guest: cl(Number(msg.hp.guest)) };
          }
          if (msg.wz) {
            for (const role of ['host', 'guest']) {
              wounds[role] = (msg.wz[role] || [])
                .filter(z => ['head', 'body', 'leg'].includes(z))
                .map(z => ({ zone: z, drip: 0 }));
            }
          }
          // A reload mid-ragdoll rejoins the death pause (shortened)
          if (msg.dead === 'host' || msg.dead === 'guest') {
            deadRole = msg.dead;
            respawnAt = performance.now() + 1500;
            spawnRagdoll(deadRole, deadRole === 'host' ? 1 : -1);
          }
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

      // A death pauses the duel: ragdoll for a beat, then the host re-deals
      if (deadRole) {
        stepRagdoll(dt);
        if (now > respawnAt && (A.state.solo || A.state.role === 'host')) {
          nextRound();
        }
      }

      // Bleeding: open wounds drip until the duel is re-dealt
      for (const role of ['host', 'guest']) {
        if (role === deadRole) continue; // the ragdoll drips on its own
        for (const w of wounds[role]) {
          w.drip -= dt;
          if (w.drip <= 0 && blood.length < 80) {
            w.drip = 0.1 + Math.random() * 0.15;
            blood.push({
              x: pos[role] + (Math.random() - 0.5) * 0.016,
              y: zoneY(role, w.zone, gt),
              vy: 0.02 + Math.random() * 0.05,
              life: 1
            });
          }
        }
      }
      for (let i = blood.length - 1; i >= 0; i--) {
        const d = blood[i];
        d.vy += G * dt * 0.6;
        d.y += d.vy * dt;
        d.life -= dt * 0.5;
        if (d.y >= GY || d.life <= 0) blood.splice(i, 1);
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
        if (role === deadRole) continue; // the ragdoll below replaces it
        drawArcher(pos[role], role === 'host' ? 1 : -1, col, fy,
          mine && av ? av.a : null);

        // Open wounds: red marks on the archer
        ctx.fillStyle = RED;
        wounds[role].forEach((w, k) => {
          const wy = zoneY(role, w.zone, gt);
          ctx.beginPath();
          ctx.arc(X(pos[role] + (k % 2 ? 0.007 : -0.006)), Y(wy), S(0.005), 0, Math.PI * 2);
          ctx.fill();
        });

        // Health bar over the head
        const frac = hp[role] / HP_MAX;
        ctx.fillStyle = '#333';
        ctx.fillRect(X(pos[role] - 0.032), Y(fy - 0.132), S(0.064), S(0.008));
        ctx.fillStyle = frac > 0.5 ? '#37e05a' : RED;
        ctx.fillRect(X(pos[role] - 0.032), Y(fy - 0.132), S(0.064 * frac), S(0.008));

        if (mine) {
          ctx.fillStyle = color;
          ctx.textAlign = 'center';
          ctx.font = `bold ${Math.round(S(0.024))}px "Courier New", monospace`;
          ctx.fillText('YOU', X(pos[role]), Y(fy - 0.152));
        }
      }

      // The fallen archer, tumbling
      if (ragdoll) {
        const pts = ragdoll.pts;
        const col = (A.state.solo && ragdoll.role === 'guest') ? GRAY
          : (ragdoll.role === 'host' ? BLUE : ORANGE);
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(2, S(0.008));
        ctx.beginPath();
        ctx.moveTo(X(pts[1].x), Y(pts[1].y)); ctx.lineTo(X(pts[2].x), Y(pts[2].y)); // torso
        ctx.moveTo(X(pts[2].x), Y(pts[2].y)); ctx.lineTo(X(pts[3].x), Y(pts[3].y)); // legs
        ctx.moveTo(X(pts[2].x), Y(pts[2].y)); ctx.lineTo(X(pts[4].x), Y(pts[4].y));
        ctx.moveTo(X(pts[1].x), Y(pts[1].y)); ctx.lineTo(X(pts[5].x), Y(pts[5].y)); // arm
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(X(pts[0].x), Y(pts[0].y), S(0.016), 0, Math.PI * 2);
        ctx.stroke();
      }

      // Blood droplets falling from open wounds
      ctx.fillStyle = RED;
      for (const d of blood) {
        ctx.globalAlpha = Math.max(0.2, d.life);
        ctx.fillRect(X(d.x) - 1, Y(d.y) - 2, 2, 4);
      }
      ctx.globalAlpha = 1;

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
      if (deadRole) {
        const me = A.state.solo ? 'host' : myRole();
        return deadRole === me ? 'YOU ARE DOWN... RESPAWNING' : 'RIVAL IS DOWN... RESPAWNING';
      }
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
    // Bow: a tall shallow limb (quadratic curve) with a straight string,
    // held out along the aim - much flatter than the old semicircle
    const base = aimDeg !== null ? aimDeg * Math.PI / 180 : (dir > 0 ? 0.6 : Math.PI - 0.6);
    const hx = ax + Math.cos(base) * 0.03;          // bow hand
    const hy = fy - 0.06 - Math.sin(base) * 0.03;
    const px = Math.cos(base + Math.PI / 2), py = -Math.sin(base + Math.PI / 2);
    const L = 0.042;                                 // half length, tip to tip
    const t1x = hx + px * L, t1y = hy + py * L;
    const t2x = hx - px * L, t2y = hy - py * L;
    const cxp = hx + Math.cos(base) * 0.02;          // shallow belly toward the aim
    const cyp = hy - Math.sin(base) * 0.02;
    ctx.lineWidth = Math.max(2, S(0.007));
    ctx.beginPath();
    ctx.moveTo(X(t1x), Y(t1y));
    ctx.quadraticCurveTo(X(cxp), Y(cyp), X(t2x), Y(t2y));
    ctx.stroke();
    // string between the tips
    ctx.lineWidth = Math.max(1, S(0.0025));
    ctx.beginPath();
    ctx.moveTo(X(t1x), Y(t1y));
    ctx.lineTo(X(t2x), Y(t2y));
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
    arrows: arrows.length, stuck: stuck.length, canFire: canFire(),
    hp: { host: hp.host, guest: hp.guest },
    wounds: { host: wounds.host.map(w => w.zone), guest: wounds.guest.map(w => w.zone) },
    blood: blood.length,
    dead: deadRole, ragdoll: !!ragdoll
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
