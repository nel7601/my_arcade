/*
 * MISSILES (1980) - intercept & strike back.
 *
 * Missiles rain on your cities; tap anywhere to send an interceptor
 * that detonates at that point. Every missile destroyed is a point,
 * and every third intercept launches a fast missile at your rival.
 * Lose all four cities and they rebuild after a few seconds.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { PLAY_H, COURT_W, X, Y, S, ctx } = A;

  const CITY_W = 0.1, CITY_H = 0.045;
  const CITY_Y = PLAY_H - CITY_H;
  const CITY_XS = [0.14, 0.38, 0.62, 0.86];
  const BATTERY = { x: 0.5, y: PLAY_H - 0.01 };
  const SHOT_SPEED = 1.1;
  const BLAST_R = 0.09;

  let cities = [];
  let missiles = [];      // {x0,y0,x,y,tx,ty,speed,hostile:true}
  let shots = [];         // interceptors {x,y,tx,ty}
  let blasts = [];        // {x,y,age}
  let spawnTimer = 0;
  let elapsed = 0;
  let intercepts = 0;
  let rebuildAt = 0;

  function spawnMissile(speed, fromRival) {
    const tx = CITY_XS[Math.floor(Math.random() * CITY_XS.length)];
    missiles.push({
      x0: Math.random(), y0: -0.02,
      x: 0, y: 0,
      t: 0,
      tx: tx + (Math.random() * 0.06 - 0.03),
      ty: CITY_Y + CITY_H / 2,
      speed,
      fromRival: !!fromRival
    });
    const m = missiles[missiles.length - 1];
    m.x = m.x0;
    m.y = m.y0;
  }

  A.register({
    game: 'missiles',
    title: 'MISSILES',
    solo: true,

    onStart() {
      cities = CITY_XS.map(() => true);
      missiles = [];
      shots = [];
      blasts = [];
      spawnTimer = 1;
      elapsed = 0;
      intercepts = 0;
      rebuildAt = 0;
    },

    onResume() {
      cities = CITY_XS.map(() => true);
      missiles = [];
      shots = [];
      blasts = [];
    },

    onMessage(msg) {
      if (msg.type === 'attack') {
        spawnMissile(0.3, true); // rival strike: faster than the rain
        A.sndScore();
      }
    },

    onPointer(phase, x, y) {
      if (phase !== 'down') return;
      if (y < 0 || y > PLAY_H - 0.1) return; // aim inside the sky
      shots.push({ x: BATTERY.x, y: BATTERY.y, tx: x, ty: y });
      A.beep(700, 0.04);
    },

    step(dt, now) {
      elapsed += dt;

      // Rain of incoming missiles, denser over time
      spawnTimer -= dt;
      if (spawnTimer <= 0) {
        spawnTimer = Math.max(1.0, 2.8 - elapsed * 0.02);
        spawnMissile(0.1 + Math.min(0.15, elapsed * 0.002));
      }

      // Rebuild dead cities after the truce
      if (rebuildAt && now > rebuildAt) {
        cities = CITY_XS.map(() => true);
        rebuildAt = 0;
        A.flash('CITIES REBUILT');
      }

      // Interceptors fly to their target point and detonate
      for (const s of shots) {
        const dx = s.tx - s.x, dy = s.ty - s.y;
        const d = Math.hypot(dx, dy);
        const step = SHOT_SPEED * dt;
        if (d <= step) {
          blasts.push({ x: s.tx, y: s.ty, age: 0 });
          s.done = true;
          A.sndWall();
        } else {
          s.x += dx / d * step;
          s.y += dy / d * step;
        }
      }
      shots = shots.filter(s => !s.done);

      // Blasts grow then fade
      for (const bl of blasts) bl.age += dt;
      blasts = blasts.filter(bl => bl.age < 0.8);

      // Missiles fall toward their targets
      for (const m of missiles) {
        const dx = m.tx - m.x0, dy = m.ty - m.y0;
        const len = Math.hypot(dx, dy);
        m.t += (m.speed * dt) / len;
        m.x = m.x0 + dx * m.t;
        m.y = m.y0 + dy * m.t;

        // Caught in a blast?
        for (const bl of blasts) {
          const r = BLAST_R * Math.min(1, bl.age / 0.4);
          if (Math.hypot(m.x - bl.x, m.y - bl.y) < r) {
            m.dead = true;
            A.sndPaddle();
            A.addScore(1);
            intercepts += 1;
            if (intercepts % 3 === 0) {
              A.send({ type: 'attack' }); // strike back!
              A.flash('MISSILE SENT!');
            }
            break;
          }
        }

        // Impact
        if (!m.dead && m.t >= 1) {
          m.dead = true;
          blasts.push({ x: m.tx, y: m.ty, age: 0 });
          A.sndScore();
          const ci = CITY_XS.findIndex((cx, i) => cities[i] && Math.abs(cx - m.tx) < CITY_W);
          if (ci >= 0) {
            cities[ci] = false;
            if (!cities.some(Boolean) && !rebuildAt) rebuildAt = now + 6000;
          }
        }
      }
      missiles = missiles.filter(m => !m.dead);
    },

    draw(now, color) {
      // Missile trails
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, S(0.004));
      for (const m of missiles) {
        ctx.globalAlpha = m.fromRival ? 1 : 0.6;
        ctx.beginPath();
        ctx.moveTo(X(m.x0), Y(m.y0));
        ctx.lineTo(X(m.x), Y(m.y));
        ctx.stroke();
        ctx.fillRect(X(m.x) - 2, Y(m.y) - 2, 4, 4);
      }
      ctx.globalAlpha = 1;

      // Interceptor shots
      for (const s of shots) {
        ctx.fillRect(X(s.x) - 2, Y(s.y) - 2, 4, 4);
        // Target marker
        ctx.fillRect(X(s.tx) - S(0.012), Y(s.ty), S(0.024), 1);
        ctx.fillRect(X(s.tx), Y(s.ty) - S(0.012), 1, S(0.024));
      }

      // Blasts
      for (const bl of blasts) {
        const r = BLAST_R * (bl.age < 0.4 ? bl.age / 0.4 : 1 - (bl.age - 0.4) / 0.4);
        ctx.beginPath();
        ctx.arc(X(bl.x), Y(bl.y), Math.max(0, S(r)), 0, Math.PI * 2);
        ctx.fill();
      }

      // Cities + battery
      CITY_XS.forEach((cx, i) => {
        if (!cities[i]) return;
        ctx.fillRect(X(cx - CITY_W / 2), Y(CITY_Y), S(CITY_W), S(CITY_H));
        ctx.fillRect(X(cx - CITY_W / 6), Y(CITY_Y - 0.015), S(CITY_W / 3), S(0.015));
      });
      ctx.fillRect(X(BATTERY.x - 0.03), Y(PLAY_H - 0.03), S(0.06), S(0.03));
    },

    status() {
      return cities.some(Boolean) ? null : '· CITIES DOWN ·';
    }
  });
})();
