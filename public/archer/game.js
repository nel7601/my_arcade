/*
 * ARCHER - a Bowman-style archery duel on one shared field.
 *
 * Two stick archers face each other on a flat field, on a landscape
 * court both phones share. Turns alternate with every arrow, hit or
 * miss: drag to draw the bow (angle + power), release to loose the
 * arrow, and watch its arc - no wind, no craters, just gravity and aim.
 * A body hit is 1 point, a HEAD SHOT pays 2; every hit also redraws the
 * duel at a fresh distance (host-dealt seed keeps both phones agreed).
 * Missed arrows stay stuck in the ground until the archers move.
 * Most points when the match clock runs out wins.
 *
 * Solo mode: target practice against a dummy that never shoots back.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { X, Y, S, ctx } = A;

  // Landscape court (matches the engine's landscape constants)
  const CW = 1.6;
  const PH = 0.8;
  const GY = 0.72;               // flat ground line
  const G = 0.55;                // gravity, court units / s^2
  const DT = 1 / 120;            // fixed physics step: identical on both phones

  const HEAD_R = 0.024;          // generous head hitbox
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
  let roundN = 0;                // positions index: bumps on every hit
  let worldReady = false;
  let turn = 'host';
  let pos = { host: 0.2, guest: 1.4 };
  let arrow = null;              // the arrow in flight {x,y,vx,vy,from}
  let stuck = [];                // arrows in the ground {x,y,ang}
  let aim = null;                // {sx, sy, x, y} while dragging
  let lastShot = null;           // {a, p} for the HUD readout
  let nextPoke = 0;
  let hostDealDeadline = Infinity;
  let fsTried = false;
  let acc = 0;

  const myRole = () => A.state.role;
  const foe = (r) => (r === 'host' ? 'guest' : 'host');
  const canFire = () =>
    worldReady && !arrow && (A.state.solo || turn === myRole());

  function placeArchers() {
    const rnd = mulberry32((seed ^ 0x9E3779B9) + roundN * 613);
    pos.host = 0.10 + rnd() * 0.25;
    pos.guest = CW - 0.10 - rnd() * 0.25;
    stuck = [];
  }

  function applyWorld(s) {
    seed = s;
    roundN = 0;
    turn = 'host';
    arrow = null;
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

  // ---- Shooting & simulation (identical on both phones) ---------------------

  // 'head' | 'body' | null - the same hitbox both phones test every step
  function hitTest(role, x, y) {
    const ax = pos[role];
    const hd = Math.hypot(x - ax, y - (GY - 0.095));
    if (hd < HEAD_R) return 'head';
    if (Math.abs(x - ax) < 0.02 && y > GY - 0.078 && y <= GY) return 'body';
    return null;
  }

  function fire(from, a10, p) {
    const r = (a10 / 10) * Math.PI / 180;
    const v0 = 0.3 + (p / 100) * 1.0;
    const dir = from === 'host' ? 1 : -1;
    arrow = {
      x: pos[from] + dir * 0.035,
      y: GY - 0.06 - Math.sin(r) * 0.02,
      vx: Math.cos(r) * v0,
      vy: -Math.sin(r) * v0,
      from, age: 0, trail: [], trailT: 0
    };
    lastShot = { a: Math.round(a10 / 10), p };
    A.beep(600, 0.06);
  }

  function resolveArrow(hit) {
    const from = arrow.from;
    if (hit) {
      A.beep(160, 0.2);
      if (from === myRole()) {
        const pts = hit === 'head' ? 2 : 1;
        A.addScore(pts);
        A.flash(hit === 'head' ? 'HEAD SHOT! +2' : 'HIT! +1');
        A.sndScore();
      }
      roundN += 1;               // fresh distance after every hit
      placeArchers();
    } else {
      if (arrow.y >= GY - 0.005) {
        stuck.push({ x: arrow.x, y: GY, ang: Math.atan2(arrow.vy, arrow.vx) });
        if (stuck.length > 24) stuck.shift();
      }
      A.beep(226, 0.05);
    }
    arrow = null;
    if (!A.state.solo) turn = foe(from); // Bowman rule: alternate every arrow
  }

  function physStep() {
    if (!arrow) return;
    arrow.age += DT;
    arrow.vy += G * DT;
    arrow.x += arrow.vx * DT;
    arrow.y += arrow.vy * DT;
    arrow.trailT += DT;
    if (arrow.trailT > 0.05) {
      arrow.trailT = 0;
      arrow.trail.push([arrow.x, arrow.y]);
      if (arrow.trail.length > 16) arrow.trail.shift();
    }
    if (arrow.x < -0.1 || arrow.x > CW + 0.1) { resolveArrow(null); return; }
    const target = A.state.solo ? 'guest' : foe(arrow.from);
    if (arrow.age > 0.05) {
      const hit = hitTest(target, arrow.x, arrow.y);
      if (hit) { resolveArrow(hit); return; }
    }
    if (arrow.y >= GY) resolveArrow(null);
  }

  // Pure ghost shot for the test helper: same integration, no side effects
  function ghostShot(from, a, p) {
    const r = a * Math.PI / 180, v0 = 0.3 + (p / 100) * 1.0;
    const dir = from === 'host' ? 1 : -1;
    let x = pos[from] + dir * 0.035, y = GY - 0.06 - Math.sin(r) * 0.02;
    let vx = Math.cos(r) * v0, vy = -Math.sin(r) * v0, age = 0;
    const target = A.state.solo ? 'guest' : foe(from);
    for (let i = 0; i < 20000; i++) {
      age += DT; vy += G * DT; x += vx * DT; y += vy * DT;
      if (x < -0.1 || x > CW + 0.1) return { hit: null, x };
      if (age > 0.05) {
        const hit = hitTest(target, x, y);
        if (hit) return { hit, x };
      }
      if (y >= GY) return { hit: null, x };
    }
    return { hit: null, x };
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
      if (A.state.solo || A.state.role === 'host') {
        dealWorld();
      } else {
        nextPoke = performance.now() + 2500;
      }
      tryRotate();
    },

    onResume() {
      worldReady = false;
      arrow = null;
      aim = null;
      A.send({ type: 'state_req' });
      nextPoke = performance.now() + 3000;
      hostDealDeadline = A.state.role === 'host' ? performance.now() + 6000 : Infinity;
    },

    onEnd() {
      arrow = null;
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
            Math.max(10, Math.min(100, Number(msg.p) || 10)));
          break;

        case 'state_req':
          if (worldReady) A.send({ type: 'state', seed, roundN, turn });
          break;

        case 'state':
          seed = Number(msg.seed) || 1;
          roundN = Number(msg.roundN) || 0;
          turn = msg.turn === 'guest' ? 'guest' : 'host';
          arrow = null;
          acc = 0;
          placeArchers();
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
      A.send({ type: 'shot', a: a10, p });
      fire(myRole(), a10, p);
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
      if (arrow) {
        acc = Math.min(acc + dt, 0.25);
        while (acc >= DT) {
          acc -= DT;
          physStep();
          if (!arrow) { acc = 0; break; }
        }
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

      // Archers (solo: the rival slot is a gray dummy)
      const av = aimInfo();
      for (const role of ['host', 'guest']) {
        const mine = !A.state.solo ? role === myRole() : role === 'host';
        const dummy = A.state.solo && role === 'guest';
        drawArcher(pos[role], role === 'host' ? 1 : -1,
          dummy ? GRAY : (role === 'host' ? BLUE : ORANGE),
          mine && av ? av.a : null, now);
        if (mine) {
          ctx.fillStyle = color;
          ctx.textAlign = 'center';
          ctx.font = `bold ${Math.round(S(0.024))}px "Courier New", monospace`;
          ctx.fillText('YOU', X(pos[role]), Y(GY - 0.15));
        }
      }

      // Aim arrow while drawing the bow
      if (av && canFire()) {
        const me = A.state.solo ? 'host' : myRole();
        const r = av.a * Math.PI / 180;
        const L = 0.08 + (av.p / 100) * 0.2;
        const bx = pos[me], by = GY - 0.06;
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

      // The arrow in flight (drawn along its velocity) and its trail
      if (arrow) {
        ctx.fillStyle = color;
        for (let i = 0; i < arrow.trail.length; i++) {
          ctx.globalAlpha = 0.1 + 0.4 * (i / arrow.trail.length);
          ctx.fillRect(X(arrow.trail[i][0]) - 1, Y(arrow.trail[i][1]) - 1, 2, 2);
        }
        ctx.globalAlpha = 1;
        const ang = Math.atan2(arrow.vy, arrow.vx);
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, S(0.005));
        ctx.beginPath();
        ctx.moveTo(X(arrow.x - Math.cos(ang) * 0.03), Y(arrow.y - Math.sin(ang) * 0.03));
        ctx.lineTo(X(arrow.x), Y(arrow.y));
        ctx.stroke();
      }

      // HUD: angle/power readout
      const info = av || lastShot;
      if (info) {
        ctx.fillStyle = color;
        ctx.textAlign = 'right';
        ctx.font = `bold ${Math.round(S(0.03))}px "Courier New", monospace`;
        ctx.fillText(Math.round(info.a) + '° · ' + info.p + '%', X(CW - 0.02), Y(0.055));
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
      if (arrow) return null;
      if (A.state.solo) return 'HIT THE DUMMY · DRAG TO AIM, RELEASE TO SHOOT';
      return turn === myRole()
        ? 'YOUR TURN · DRAG TO AIM, RELEASE TO SHOOT'
        : 'RIVAL IS DRAWING THE BOW...';
    }
  });

  // A chunky stick archer: head, torso, legs, bow arc
  function drawArcher(ax, dir, col, aimDeg, now) {
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = Math.max(2, S(0.008));
    // head
    ctx.beginPath();
    ctx.arc(X(ax), Y(GY - 0.095), S(0.018), 0, Math.PI * 2);
    ctx.stroke();
    // torso
    ctx.beginPath();
    ctx.moveTo(X(ax), Y(GY - 0.077));
    ctx.lineTo(X(ax), Y(GY - 0.03));
    // legs
    ctx.lineTo(X(ax - 0.014), Y(GY));
    ctx.moveTo(X(ax), Y(GY - 0.03));
    ctx.lineTo(X(ax + 0.014), Y(GY));
    ctx.stroke();
    // bow: an arc held forward, tilted along the aim
    const base = aimDeg !== null ? aimDeg * Math.PI / 180 : (dir > 0 ? 0.6 : Math.PI - 0.6);
    ctx.beginPath();
    ctx.arc(X(ax + Math.cos(base) * 0.032), Y(GY - 0.06 - Math.sin(base) * 0.032),
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
    ready: worldReady, seed, roundN, turn,
    hostX: Math.round(pos.host * 1000) / 1000,
    guestX: Math.round(pos.guest * 1000) / 1000,
    arrow: !!arrow, stuck: stuck.length, canFire: canFire()
  });
  A.state.arFire = (a10, p) => {
    if (!canFire()) return false;
    A.send({ type: 'shot', a: a10, p });
    fire(myRole(), a10, p);
    return true;
  };
  A.state.arSolve = () => {
    const me = A.state.solo ? 'host' : myRole();
    let best = null;
    for (let a = 20; a <= 160; a += 2) {
      for (let p = 15; p <= 100; p += 3) {
        const g = ghostShot(me, a, p);
        if (g.hit) return { a, p, hit: g.hit };
        const target = A.state.solo ? 'guest' : foe(me);
        const err = Math.abs(g.x - pos[target]);
        if (!best || err < best.err) best = { a, p, err };
      }
    }
    return best;
  };
})();
