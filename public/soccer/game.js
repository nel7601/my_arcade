/*
 * SOCCER - one-on-one head soccer on a shared landscape pitch.
 *
 * Each player is a big-headed footballer with swinging legs: hold a
 * finger to the side of your player to RUN, swipe up (or tap the upper
 * half) to JUMP. When the ball rolls into your boot the leg swings on
 * its own and LOFTS the ball forward and up - that is your way of
 * lifting it off the floor, because both GOALS float slightly above
 * the ground: a ball rolling on the grass bounces off the goal shelf,
 * only an airborne ball between shelf and crossbar counts.
 *
 * BLUE (host) defends the left goal, ORANGE (guest) the right one.
 * Headers work too: the ball bounces off heads and bodies with your
 * momentum added.
 *
 * Networking: real time, like ARCHER/PONG. Each phone simulates its own
 * player and streams it; the HOST phone is the authority on the ball
 * and the goals, broadcasting ball state - the guest simulates the ball
 * between packets (its own kicks are reported and adopted, so they feel
 * instant). Goals score through the engine's goal/concede channel.
 *
 * Solo mode: a CPU striker that chases, jumps and kicks.
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { X, Y, S, ctx } = A;

  // Landscape court (matches the engine's landscape constants)
  const CW = 1.6;
  const PH = 0.8;
  const GY = 0.72;               // grass line

  // Players
  const RUN = 0.55;
  const JUMP_V = 1.05;
  const G_P = 2.6;
  const HEAD_R = 0.032;

  // Ball
  const BR = 0.028;
  const G_B = 1.5;
  const REST = 0.75;
  const DRAG = 0.12;

  // Goals float above the grass: shelf and crossbar make the mouth
  const GOAL_D = 0.13;                 // depth of the box
  const SHELF_Y = GY - 0.11;           // top of the bottom shelf
  const BAR_Y = GY - 0.33;             // underside of the crossbar
  const BAR_T = 0.012;

  const KICK_R = 0.075;
  const KICK_CD = 0.45;

  const BLUE = '#5ad0ff', ORANGE = '#ffb04f', GRAY = '#9aa7b0';

  let players = null;            // {host:{x,y,vy,vx,facing,kickT,anim}, guest:{...}}
  let ball = null;               // {x,y,vx,vy}
  let freezeUntil = 0;           // kickoff freeze
  let touch = null;              // {x, y, y0, jumped}
  let lastMeSent = 0;
  let lastBallSent = 0;
  let nextPoke = 0;
  let fsTried = false;
  let acc = 0;
  const DT = 1 / 120;

  const myRole = () => (A.state.solo ? 'host' : A.state.role);
  const foe = (r) => (r === 'host' ? 'guest' : 'host');
  const isBallBoss = () => A.state.solo || A.state.role === 'host';

  function newPlayer(role) {
    return {
      x: role === 'host' ? 0.35 : CW - 0.35,
      y: GY, vx: 0, vy: 0,
      facing: role === 'host' ? 1 : -1,
      kickT: 0, anim: 0, run: 0
    };
  }

  function kickoff() {
    players = { host: newPlayer('host'), guest: newPlayer('guest') };
    ball = { x: CW / 2, y: 0.32, vx: 0, vy: 0 };
    freezeUntil = performance.now() + 900;
  }

  // ---- Physics ----------------------------------------------------------------

  function stepPlayer(p, dt, wantDir, wantJump) {
    p.vx = wantDir * RUN;
    if (wantDir) p.facing = wantDir;
    p.x = Math.max(0.16, Math.min(CW - 0.16, p.x + p.vx * dt));
    if (wantJump && p.y >= GY - 0.001) p.vy = -JUMP_V;
    p.vy += G_P * dt;
    p.y = Math.min(GY, p.y + p.vy * dt);
    if (p.y >= GY) p.vy = 0;
    p.kickT = Math.max(0, p.kickT - dt);
    p.anim = Math.max(0, p.anim - dt);
    p.run = wantDir ? p.run + dt : 0;
  }

  // Ball vs one player: head/body bounce plus the automatic boot
  function collidePlayer(p, isMine) {
    // Head and body as circles
    for (const [cy, r] of [[p.y - 0.105, HEAD_R], [p.y - 0.045, 0.028]]) {
      const dx = ball.x - p.x, dy = ball.y - cy;
      const d = Math.hypot(dx, dy), min = r + BR;
      if (d > 0 && d < min) {
        const nx = dx / d, ny = dy / d;
        ball.x = p.x + nx * min;
        ball.y = cy + ny * min;
        const rel = ball.vx * nx + ball.vy * ny;
        if (rel < 0) {
          ball.vx -= 1.7 * rel * nx;
          ball.vy -= 1.7 * rel * ny;
        }
        ball.vx += p.vx * 0.45;
        ball.vy += p.vy * 0.45 - 0.06;
        A.beep(459, 0.03);
      }
    }
    // The boot: swings by itself and LIFTS the ball off the floor
    const fx = p.x + p.facing * 0.035, fy = p.y - 0.012;
    if (p.kickT <= 0 && Math.hypot(ball.x - fx, ball.y - fy) < KICK_R) {
      p.kickT = KICK_CD;
      p.anim = 0.2;
      ball.vx = p.facing * 0.78 + p.vx * 0.5;
      ball.vy = Math.min(ball.vy, 0) - 0.88;
      A.beep(226, 0.06);
      return true; // kicked
    }
    return false;
  }

  // One goal box: returns 'goal' | null, bouncing the ball off its bars
  function collideGoal(left) {
    const x0 = left ? 0 : CW - GOAL_D;
    const x1 = left ? GOAL_D : CW;
    const mouthIn = ball.x > x0 - BR && ball.x < x1 + BR;
    if (!mouthIn) return null;

    // Crossbar (underside at BAR_Y) and shelf (top at SHELF_Y)
    for (const [top, bot] of [[BAR_Y - BAR_T, BAR_Y], [SHELF_Y, SHELF_Y + BAR_T]]) {
      if (ball.x > x0 && ball.x < x1) {
        if (ball.y + BR > top && ball.y - BR < bot) {
          if (ball.y < (top + bot) / 2) { // hit from above
            ball.y = top - BR;
            ball.vy = -Math.abs(ball.vy) * REST;
          } else {                        // hit from below
            ball.y = bot + BR;
            ball.vy = Math.abs(ball.vy) * REST;
          }
          A.beep(226, 0.04);
        }
      }
    }
    // Inside the mouth, between the bars: GOAL
    const inMouthY = ball.y - BR > BAR_Y && ball.y + BR < SHELF_Y;
    const behindLine = left ? ball.x < GOAL_D - 0.045 : ball.x > CW - GOAL_D + 0.045;
    if (inMouthY && behindLine) return 'goal';
    return null;
  }

  function stepBall(dt) {
    ball.vy += G_B * dt;
    ball.vx *= (1 - DRAG * dt);
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Grass, ceiling, side walls
    if (ball.y > GY - BR) {
      ball.y = GY - BR;
      ball.vy = -Math.abs(ball.vy) * REST;
      if (Math.abs(ball.vy) < 0.06) ball.vy = 0;
      ball.vx *= 0.985;
    }
    if (ball.y < BR) { ball.y = BR; ball.vy = Math.abs(ball.vy) * REST; }
    if (ball.x < BR) { ball.x = BR; ball.vx = Math.abs(ball.vx) * REST; }
    if (ball.x > CW - BR) { ball.x = CW - BR; ball.vx = -Math.abs(ball.vx) * REST; }
    const sp = Math.hypot(ball.vx, ball.vy);
    if (sp > 1.7) { ball.vx *= 1.7 / sp; ball.vy *= 1.7 / sp; }
  }

  // ---- Control & CPU ------------------------------------------------------------

  function myInput() {
    const me = players[myRole()];
    let dir = 0, jump = false;
    if (touch) {
      if (touch.x < me.x - 0.04) dir = -1;
      else if (touch.x > me.x + 0.04) dir = 1;
      if (!touch.jumped && (touch.y0 - touch.y > 0.09 || touch.y0 < 0.4)) {
        jump = true;
        touch.jumped = true;
      }
    }
    return [dir, jump];
  }

  function cpuInput() {
    const p = players.guest;
    // Stay goal-side of the ball, close in, jump for high balls
    const target = ball.x + 0.055;
    const dir = Math.abs(target - p.x) < 0.02 ? 0 : (target > p.x ? 1 : -1);
    const jump = p.y >= GY - 0.001 && ball.y < GY - 0.2 &&
      Math.abs(ball.x - p.x) < 0.16 && Math.random() < 0.08;
    return [dir, jump];
  }

  // ---- Orientation helpers (same as TANKS/ARCHER) -------------------------------

  function tryRotate() {
    try {
      if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(() => {});
      }
    } catch { /* the rotate hint covers it */ }
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

  // ---- Registration ---------------------------------------------------------------

  A.register({
    game: 'soccer',
    title: 'SOCCER',
    solo: true,
    landscape: true,

    onStart() {
      fsTried = false;
      touch = null;
      kickoff();
      tryRotate();
    },

    onResume() {
      touch = null;
      kickoff();
      A.send({ type: 'state_req' });
      nextPoke = performance.now() + 3000;
    },

    onEnd() {
      touch = null;
    },

    onPeerBack() {
      if (isBallBoss()) kickoff();
    },

    onMessage(msg) {
      switch (msg.type) {
        case 'me': {
          // The rival's phone owns the rival player
          const r = players[foe(myRole())];
          r.x = Number(msg.x) || r.x;
          r.y = Number(msg.y) || GY;
          r.vx = Number(msg.vx) || 0;
          r.facing = msg.f === -1 ? -1 : 1;
          if (msg.k) r.anim = 0.2;
          break;
        }

        case 'ball':
          // The host's ball is the truth; simulate onward from it
          if (!isBallBoss()) {
            ball.x = Number(msg.x);
            ball.y = Number(msg.y);
            ball.vx = Number(msg.vx);
            ball.vy = Number(msg.vy);
          }
          break;

        case 'kick':
          // The guest kicked on its screen: adopt it if it is plausible
          if (isBallBoss() &&
              Math.hypot(ball.x - Number(msg.x), ball.y - Number(msg.y)) < 0.14) {
            ball.x = Number(msg.x); ball.y = Number(msg.y);
            ball.vx = Number(msg.vx); ball.vy = Number(msg.vy);
          }
          break;

        case 'kickoff':
          kickoff();
          break;

        case 'state_req':
          if (isBallBoss()) {
            A.send({ type: 'kickoff' });
            kickoff();
          }
          break;
      }
    },

    onPointer(ph, x, y) {
      if (A.state.phase !== 'playing') return;
      if (ph === 'down') {
        tryFullscreenOnce();
        touch = { x, y, y0: y, jumped: false };
        return;
      }
      if (!touch) return;
      if (ph === 'move') { touch.x = x; touch.y = y; return; }
      touch = null;
    },

    step(dt, now) {
      if (!players) return;
      const frozen = now < freezeUntil;
      const me = players[myRole()];

      acc = Math.min(acc + dt, 0.2);
      while (acc >= DT) {
        acc -= DT;
        if (frozen) continue;

        // My player, from my finger
        const [dir, jump] = myInput();
        stepPlayer(me, DT, dir, jump);

        // The CPU striker (solo only)
        if (A.state.solo) {
          const [cd, cj] = cpuInput();
          stepPlayer(players.guest, DT, cd, cj);
        } else {
          // Extrapolate the rival between packets (their phone owns them)
          const r = players[foe(myRole())];
          r.x = Math.max(0.16, Math.min(CW - 0.16, r.x + r.vx * DT));
          r.vy += G_P * DT;
          r.y = Math.min(GY, r.y + r.vy * DT);
          if (r.y >= GY) r.vy = 0;
          r.kickT = Math.max(0, r.kickT - DT);
          r.anim = Math.max(0, r.anim - DT);
        }

        // The ball: everyone simulates, the host decides
        stepBall(DT);
        const kickedMine = collidePlayer(me, true);
        if (A.state.solo) collidePlayer(players.guest, false);
        else collidePlayer(players[foe(myRole())], false);
        if (kickedMine && !isBallBoss()) {
          A.send({ type: 'kick', x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy });
        }

        if (isBallBoss()) {
          const inLeft = collideGoal(true);
          const inRight = collideGoal(false);
          if (inLeft === 'goal' || inRight === 'goal') {
            // Left goal belongs to the host: a ball inside it scores for
            // the guest (concede); the right goal scores for the host
            if (A.state.solo) {
              if (inRight === 'goal') { A.addScore(1); A.flash('GOOOAL!'); A.sndScore(); }
              else { A.state.score.opp += 1; A.flash('THE CPU SCORES'); A.beep(120, 0.3); }
            } else if (inRight === 'goal') {
              A.addScore(1);
              A.flash('GOOOAL!');
              A.sndScore();
            } else {
              A.concede(1);
              A.flash('GOAL AGAINST YOU');
            }
            if (!A.state.solo) A.send({ type: 'kickoff' });
            kickoff();
            break;
          }
        } else {
          collideGoal(true);  // bars still bounce on the guest's screen
          collideGoal(false); // (the host calls the actual goals)
        }
      }

      // Streams: my player ~12Hz, the ball (host) ~10Hz
      if (!A.state.solo && now - lastMeSent > 80) {
        lastMeSent = now;
        A.send({
          type: 'me',
          x: Math.round(me.x * 1000) / 1000,
          y: Math.round(me.y * 1000) / 1000,
          vx: Math.round(me.vx * 100) / 100,
          f: me.facing,
          k: me.anim > 0.1 ? 1 : 0
        });
      }
      if (!A.state.solo && isBallBoss() && now - lastBallSent > 100) {
        lastBallSent = now;
        A.send({
          type: 'ball',
          x: Math.round(ball.x * 1000) / 1000,
          y: Math.round(ball.y * 1000) / 1000,
          vx: Math.round(ball.vx * 100) / 100,
          vy: Math.round(ball.vy * 100) / 100
        });
      }
    },

    draw(now, color) {
      if (!players) return;

      // Grass
      ctx.fillStyle = '#16321a';
      ctx.fillRect(X(0), Y(GY), S(CW), S(PH - GY));
      ctx.strokeStyle = '#49a94f';
      ctx.lineWidth = Math.max(2, S(0.005));
      ctx.beginPath();
      ctx.moveTo(X(0), Y(GY));
      ctx.lineTo(X(CW), Y(GY));
      ctx.stroke();
      // Halfway line
      ctx.globalAlpha = 0.3;
      ctx.setLineDash([6, 8]);
      ctx.beginPath();
      ctx.moveTo(X(CW / 2), Y(0.1));
      ctx.lineTo(X(CW / 2), Y(GY));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // Goals: floating boxes with nets, open toward the field
      for (const left of [true, false]) {
        const x0 = left ? 0 : CW - GOAL_D;
        ctx.strokeStyle = left ? BLUE : ORANGE;
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = Math.max(2, S(0.008));
        ctx.beginPath();
        ctx.moveTo(X(x0), Y(BAR_Y));
        ctx.lineTo(X(x0 + GOAL_D), Y(BAR_Y));      // crossbar
        ctx.moveTo(X(x0), Y(SHELF_Y + BAR_T));
        ctx.lineTo(X(x0 + GOAL_D), Y(SHELF_Y + BAR_T)); // shelf
        const backX = left ? 0.004 : CW - 0.004;
        ctx.moveTo(X(backX), Y(BAR_Y));
        ctx.lineTo(X(backX), Y(SHELF_Y + BAR_T));  // back post
        ctx.stroke();
        // Net
        ctx.globalAlpha = 0.25;
        ctx.lineWidth = 1;
        for (let k = 1; k < 4; k++) {
          ctx.beginPath();
          ctx.moveTo(X(x0 + k * GOAL_D / 4), Y(BAR_Y));
          ctx.lineTo(X(x0 + k * GOAL_D / 4), Y(SHELF_Y + BAR_T));
          ctx.stroke();
        }
        for (let k = 1; k < 4; k++) {
          const yy = BAR_Y + k * (SHELF_Y + BAR_T - BAR_Y) / 4;
          ctx.beginPath();
          ctx.moveTo(X(x0), Y(yy));
          ctx.lineTo(X(x0 + GOAL_D), Y(yy));
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // Players
      for (const role of ['host', 'guest']) {
        const p = players[role];
        const dummyCpu = A.state.solo && role === 'guest';
        drawPlayer(p, dummyCpu ? GRAY : (role === 'host' ? BLUE : ORANGE), now);
        if (role === myRole() && !A.state.solo || (A.state.solo && role === 'host')) {
          ctx.fillStyle = color;
          ctx.textAlign = 'center';
          ctx.font = `bold ${Math.round(S(0.024))}px "Courier New", monospace`;
          ctx.fillText('YOU', X(p.x), Y(p.y - 0.19));
        }
      }

      // Ball
      ctx.fillStyle = '#f2f2f2';
      ctx.beginPath();
      ctx.arc(X(ball.x), Y(ball.y), S(BR), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(X(ball.x), Y(ball.y), S(BR), 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(X(ball.x), Y(ball.y), S(BR * 0.45), 0, Math.PI * 2);
      ctx.stroke();

      // Kickoff countdown
      if (performance.now() < freezeUntil) {
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.font = `bold ${Math.round(S(0.05))}px "Courier New", monospace`;
        ctx.fillText('KICKOFF!', X(CW / 2), Y(0.2));
      }

      // Rotate hint while the phone is held upright
      if (window.innerHeight > window.innerWidth && Math.floor(now / 600) % 2 === 0) {
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.font = `bold ${Math.round(S(0.045))}px "Courier New", monospace`;
        ctx.fillText('TURN YOUR PHONE SIDEWAYS', X(CW / 2), Y(0.12));
      }
    },

    status() {
      return 'HOLD TO RUN · SWIPE UP TO JUMP · THE BOOT KICKS BY ITSELF';
    }
  });

  // A big-headed footballer with running/kicking legs
  function drawPlayer(p, col, now) {
    const hipY = p.y - 0.035;
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = Math.max(2, S(0.009));
    // Legs: swing while running, big forward swing while kicking
    let swing = p.run > 0 ? Math.sin(now / 70) * 0.35 : 0.15;
    if (p.y < GY - 0.002) swing = 0.5;                 // tucked in the air
    let kickSwing = 0;
    if (p.anim > 0) kickSwing = (0.2 - p.anim) / 0.2 * 1.5; // the boot flies
    const legL = 0.038;
    const a1 = Math.PI / 2 + swing * 0.6 - kickSwing * p.facing * 0;
    const a2 = Math.PI / 2 - swing * 0.6;
    // Back leg
    ctx.beginPath();
    ctx.moveTo(X(p.x), Y(hipY));
    ctx.lineTo(X(p.x - Math.cos(a1) * 0.012 - 0.008), Y(hipY + Math.sin(a1) * legL));
    ctx.stroke();
    // Kicking leg (front): rotates toward facing when the boot swings
    const kx = p.x + p.facing * (0.01 + kickSwing * 0.03);
    const ky = hipY + legL * (1 - kickSwing * 0.45);
    ctx.beginPath();
    ctx.moveTo(X(p.x), Y(hipY));
    ctx.lineTo(X(kx), Y(ky));
    ctx.stroke();
    // Boot
    ctx.fillRect(X(kx) - S(0.006), Y(ky) - S(0.005), S(0.019), S(0.01));
    // Body
    ctx.beginPath();
    ctx.moveTo(X(p.x), Y(hipY));
    ctx.lineTo(X(p.x), Y(p.y - 0.073));
    ctx.stroke();
    // Head with an eye looking where the player faces
    ctx.beginPath();
    ctx.arc(X(p.x), Y(p.y - 0.105), S(HEAD_R), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(X(p.x + p.facing * 0.014), Y(p.y - 0.108), S(0.005), 0, Math.PI * 2);
    ctx.fill();
  }

  // Exposed for automated tests; not part of the game logic
  A.state.scDebug = () => ({
    ready: !!players,
    ball: ball ? {
      x: Math.round(ball.x * 1000) / 1000, y: Math.round(ball.y * 1000) / 1000,
      vx: Math.round(ball.vx * 100) / 100, vy: Math.round(ball.vy * 100) / 100
    } : null,
    me: players ? {
      x: Math.round(players[myRole()].x * 1000) / 1000,
      y: Math.round(players[myRole()].y * 1000) / 1000,
      grounded: players[myRole()].y >= GY - 0.001
    } : null,
    rival: players ? {
      x: Math.round(players[foe(myRole())].x * 1000) / 1000,
      y: Math.round(players[foe(myRole())].y * 1000) / 1000
    } : null,
    frozen: performance.now() < freezeUntil,
    shelfY: SHELF_Y, barY: BAR_Y, goalD: GOAL_D, groundY: GY
  });
  A.state.scSetBall = (x, y, vx, vy) => {
    ball = { x, y, vx, vy };
  };
})();
