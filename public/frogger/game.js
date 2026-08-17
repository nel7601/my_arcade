/*
 * FROGGER (1981) - crossing race.
 *
 * Hop across eight lanes of traffic; every full crossing is a point
 * and the traffic gets a little faster. Getting hit sends you back to
 * the start. Swipe to hop in any direction, tap to hop forward.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { PLAY_H, COURT_W, X, Y, S, ctx } = A;

  const LANES = 8;
  const LANE_H = 0.13;
  const ROAD_TOP = 0.09;
  const FROG = 0.055;
  const HOME_Y = ROAD_TOP + LANES * LANE_H + 0.02; // start row below traffic
  const GOAL_Y = ROAD_TOP - 0.02;

  let frog = { x: 0.5, y: HOME_Y };
  let lanes = [];          // [{y, speed, dir, cars:[{x,w}]}]
  let speedFactor = 1;
  let swipeAnchor = null;
  let hopFlash = 0;

  function buildLanes() {
    lanes = [];
    for (let i = 0; i < LANES; i++) {
      const dir = i % 2 === 0 ? 1 : -1;
      const speed = (0.12 + Math.random() * 0.1) * speedFactor;
      const cars = [];
      const n = 2 + (i % 2);
      for (let k = 0; k < n; k++) {
        cars.push({ x: (k / n + Math.random() * 0.2) % 1, w: 0.13 + Math.random() * 0.08 });
      }
      lanes.push({ y: ROAD_TOP + i * LANE_H, speed, dir, cars });
    }
  }

  function resetFrog() {
    frog = { x: 0.5, y: HOME_Y };
  }

  function hop(dx, dy) {
    frog.x = Math.max(FROG / 2, Math.min(COURT_W - FROG / 2, frog.x + dx * 0.11));
    frog.y += dy * LANE_H;
    if (frog.y > HOME_Y) frog.y = HOME_Y;
    A.beep(660, 0.03);
    hopFlash = performance.now();

    if (frog.y <= GOAL_Y + 0.01) {
      A.addScore(1);
      A.sndScore();
      A.flash('CROSSED!');
      speedFactor = Math.min(2.2, speedFactor * 1.06);
      for (const l of lanes) l.speed = Math.abs(l.speed) * 1.06;
      resetFrog();
    }
  }

  A.register({
    game: 'frogger',
    title: 'FROGGER',
    solo: true,

    onStart() {
      speedFactor = 1;
      buildLanes();
      resetFrog();
    },

    onResume() {
      buildLanes();
      resetFrog();
    },

    onPointer(phase, x, y) {
      if (phase === 'down') {
        swipeAnchor = { x, y, moved: false };
        return;
      }
      if (!swipeAnchor) return;
      const dx = x - swipeAnchor.x;
      const dy = y - swipeAnchor.y;
      if (phase === 'move') {
        if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) {
          if (Math.abs(dx) > Math.abs(dy)) hop(Math.sign(dx), 0);
          else hop(0, Math.sign(dy));
          swipeAnchor = { x, y, moved: true };
        }
        return;
      }
      // Tap (no movement) = hop forward
      if (phase === 'up' && !swipeAnchor.moved &&
          Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05) {
        hop(0, -1);
      }
      swipeAnchor = null;
    },

    step(dt) {
      for (const l of lanes) {
        for (const c of l.cars) {
          c.x += l.dir * l.speed * dt;
          if (l.dir > 0 && c.x > 1.05) c.x = -c.w - 0.05;
          if (l.dir < 0 && c.x + c.w < -0.05) c.x = 1.05;
        }
      }
      // Collision while the frog is inside a traffic lane
      const fy = frog.y;
      for (const l of lanes) {
        if (fy + FROG / 2 > l.y + 0.02 && fy - FROG / 2 < l.y + LANE_H - 0.02) {
          for (const c of l.cars) {
            if (frog.x + FROG / 2 > c.x && frog.x - FROG / 2 < c.x + c.w) {
              A.sndScore();
              resetFrog();
              return;
            }
          }
        }
      }
    },

    draw(now) {
      // Lane separators
      ctx.globalAlpha = 0.25;
      for (let i = 0; i <= LANES; i++) {
        const y = ROAD_TOP + i * LANE_H;
        for (let x = 0; x < COURT_W; x += 0.08) {
          ctx.fillRect(X(x), Y(y), S(0.04), 1);
        }
      }
      ctx.globalAlpha = 1;

      // Cars: hollow rectangles with a windshield block
      for (const l of lanes) {
        const cy = l.y + (LANE_H - 0.06) / 2;
        for (const c of l.cars) {
          ctx.fillRect(X(c.x), Y(cy), S(c.w), S(0.06));
          ctx.clearRect(X(c.x) + S(0.015), Y(cy) + S(0.015), S(c.w - 0.03), S(0.03));
        }
      }

      // Frog: a chunky square with legs, blinking right after a hop
      const blink = now - hopFlash < 120;
      const fx = X(frog.x - FROG / 2), fy = Y(frog.y - FROG / 2);
      if (!blink || Math.floor(now / 60) % 2 === 0) {
        ctx.fillRect(fx, fy, S(FROG), S(FROG));
        ctx.fillRect(fx - S(0.012), fy, S(0.012), S(0.018));
        ctx.fillRect(fx + S(FROG), fy, S(0.012), S(0.018));
        ctx.fillRect(fx - S(0.012), fy + S(FROG - 0.018), S(0.012), S(0.018));
        ctx.fillRect(fx + S(FROG), fy + S(FROG - 0.018), S(0.012), S(0.018));
      }

      // Goal strip
      ctx.globalAlpha = 0.35;
      for (let x = 0; x < COURT_W; x += 0.05) {
        ctx.fillRect(X(x), Y(GOAL_Y - 0.02), S(0.025), S(0.02));
      }
      ctx.globalAlpha = 1;
    }
  });
})();
