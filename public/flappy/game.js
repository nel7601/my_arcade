/*
 * FLAPPY - best-of-5 duel.
 *
 * Each round both players fly THE SAME pipe course (same seed, host
 * deals it) on their own phone, with the rival's live pipe count on
 * screen. When both have crashed, whoever passed more pipes takes the
 * round; a tie replays it. First to 3 round wins takes the match
 * (best of 5) — or whoever leads when the match clock runs out.
 *
 * Tap anywhere to flap. ?bot=N autopilots until N pipes, then dives
 * (used by the automated tests, fun for demos).
 */

'use strict';

(() => {
  const A = window.Arcade;
  const { PLAY_H, X, Y, S, ctx } = A;

  const BIRD_X = 0.28;
  const BIRD_SIZE = 0.05;
  const GRAVITY = 2.2;
  const FLAP_VY = -0.78;
  const PIPE_W = 0.14;
  const PIPE_SPACING = 0.52;
  const PIPE_SPEED = 0.36;
  const FIRST_PIPE_X = 1.25;
  const WINS_NEEDED = 3;       // best of 5
  const PIPE_CAP = 30;         // a perfect run ends the round at 30 pipes
  const COUNTDOWN = 1.6;
  const INTERMISSION = 2.4;

  const BOT_PIPES = Number(new URLSearchParams(location.search).get('bot')) || 0;

  // Deterministic PRNG so both phones build identical courses
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  let gap = 0.30;
  let roundNum = 0;            // current round number (1-based)
  let phase = 'idle';          // idle | countdown | flying | dead | between
  let phaseT = 0;              // countdown/intermission timer
  let seed = 1;
  let gaps = [];               // gap centers per pipe index
  let traveled = 0;
  let birdY = 0.5, birdVy = 0;
  let myPipes = 0, rivalPipes = 0;
  let myDead = false, rivalDead = false, rivalFinal = false;
  let botCooldown = 0;

  // Menu selector
  let optGap = 30;
  for (const btn of document.querySelectorAll('.opt-btn[data-gap]')) {
    btn.addEventListener('click', () => {
      optGap = Number(btn.dataset.gap);
      for (const b of document.querySelectorAll('.opt-btn[data-gap]')) {
        b.classList.toggle('sel', b === btn);
      }
    });
  }

  function buildCourse(s) {
    const rnd = mulberry32(s);
    gaps = [];
    for (let i = 0; i < PIPE_CAP + 5; i++) {
      gaps.push(0.22 + rnd() * (PLAY_H - 0.55));
    }
  }

  function startRound(n, s) {
    roundNum = n;
    seed = s;
    buildCourse(s);
    traveled = 0;
    birdY = 0.55;
    birdVy = 0;
    myPipes = 0;
    rivalPipes = 0;
    myDead = false;
    rivalDead = false;
    rivalFinal = false;
    phase = 'countdown';
    phaseT = COUNTDOWN;
  }

  // The host deals the rounds
  function hostDealRound(n) {
    const s = Math.floor(Math.random() * 1e9) + 1;
    A.send({ type: 'round', n, seed: s });
    startRound(n, s);
  }

  function pipeX(i) {
    return FIRST_PIPE_X + i * PIPE_SPACING - traveled;
  }

  function crash() {
    if (myDead) return;
    myDead = true;
    A.beep(120, 0.3);
    A.send({ type: 'crashed', pipes: myPipes });
    maybeResolveRound();
  }

  function maybeResolveRound() {
    if (!(myDead && rivalDead && rivalFinal)) return;
    phase = 'between';
    phaseT = INTERMISSION;
    if (myPipes > rivalPipes) {
      A.addScore(1); // engine score = round wins, synced to the rival
      A.flash('ROUND WON ' + myPipes + '-' + rivalPipes);
      A.sndScore();
    } else if (myPipes < rivalPipes) {
      A.flash('ROUND LOST ' + myPipes + '-' + rivalPipes);
    } else {
      A.flash('TIE ' + myPipes + '-' + myPipes + ' — REPLAY');
    }
    // The host decides what happens next once the intermission ends
  }

  function matchPoint() {
    return A.state.score.me >= WINS_NEEDED || A.state.score.opp >= WINS_NEEDED;
  }

  A.register({
    game: 'flappy',
    title: 'FLAPPY',

    getOpts() {
      return { gap: optGap };
    },

    onStart(cfg) {
      gap = (cfg.opts.gap || 30) / 100;
      phase = 'idle';
      roundNum = 0;
      if (A.state.role === 'host') {
        hostDealRound(1);
      } else {
        A.flash('GET READY');
      }
    },

    onResume(cfg) {
      gap = (cfg.opts.gap || 30) / 100;
      phase = 'idle'; // wait for the host to deal a round
      A.send({ type: 'need_round' });
    },

    onPeerBack() {
      // Restart the current round fresh once the rival is back
      if (A.state.role === 'host' && A.state.phase === 'playing') {
        hostDealRound(Math.max(1, roundNum));
      }
    },

    onMessage(msg) {
      switch (msg.type) {
        case 'round':
          startRound(msg.n, msg.seed);
          break;

        case 'pipes':
          rivalPipes = Number(msg.n) || 0;
          break;

        case 'crashed':
          rivalDead = true;
          rivalFinal = true;
          rivalPipes = Number(msg.pipes) || 0;
          maybeResolveRound();
          break;

        case 'need_round':
          if (A.state.role === 'host' && A.state.phase === 'playing') {
            hostDealRound(Math.max(1, roundNum));
          }
          break;
      }
    },

    onPointer(phaseName) {
      if (phaseName !== 'down') return;
      if (phase === 'flying' && !myDead) {
        birdVy = FLAP_VY;
        A.beep(700, 0.03);
      }
    },

    step(dt, now) {
      if (phase === 'countdown') {
        phaseT -= dt;
        if (phaseT <= 0) {
          phase = 'flying';
          birdVy = FLAP_VY; // opening flap
        }
        return;
      }

      if (phase === 'between') {
        phaseT -= dt;
        if (phaseT <= 0) {
          phase = 'idle';
          if (A.state.role === 'host') {
            if (matchPoint()) {
              A.state.timeLeft = 0.01; // early final whistle
            } else {
              const tie = myPipes === rivalPipes;
              hostDealRound(tie ? roundNum : roundNum + 1);
            }
          }
        }
        return;
      }

      if (phase !== 'flying' || myDead) return;

      // Autopilot (?bot=N): aim for the next gap until N pipes, then dive
      if (BOT_PIPES > 0) {
        botCooldown -= dt;
        if (myPipes < BOT_PIPES) {
          const next = gaps[myPipes] ?? 0.6;
          if (botCooldown <= 0 && birdY > next && birdVy > -0.2) {
            birdVy = FLAP_VY;
            botCooldown = 0.14;
          }
        } // past the target: stop flapping and fall
      }

      birdVy += GRAVITY * dt;
      birdY += birdVy * dt;
      if (birdY < 0) { birdY = 0; birdVy = 0; }
      traveled += PIPE_SPEED * dt;

      // Ground
      if (birdY + BIRD_SIZE >= PLAY_H) {
        birdY = PLAY_H - BIRD_SIZE;
        crash();
        return;
      }

      // Pipes: collision with the next one, scoring when passed
      const i = myPipes;
      const px0 = pipeX(i);
      if (px0 < BIRD_X + BIRD_SIZE && px0 + PIPE_W > BIRD_X) {
        const g = gaps[i];
        if (birdY < g - gap / 2 || birdY + BIRD_SIZE > g + gap / 2) {
          crash();
          return;
        }
      }
      if (px0 + PIPE_W < BIRD_X) {
        myPipes += 1;
        A.beep(880, 0.05);
        A.send({ type: 'pipes', n: myPipes });
        if (myPipes >= PIPE_CAP) crash(); // perfect run: round ends
      }
    },

    draw(now, color) {
      // Header: round + live pipe counts
      ctx.textAlign = 'left';
      ctx.font = `bold ${Math.round(S(0.036))}px "Courier New", monospace`;
      ctx.fillText('ROUND ' + Math.max(1, roundNum), X(0.02), Y(0.055));
      ctx.textAlign = 'right';
      ctx.fillText(`YOU ${myPipes} · RIVAL ${rivalPipes}`, X(0.98), Y(0.055));
      ctx.textAlign = 'left';

      if (phase === 'idle') return;

      // Pipes
      for (let i = myPipes; i < gaps.length; i++) {
        const x = pipeX(i);
        if (x > 1.05) break;
        if (x + PIPE_W < -0.02) continue;
        const g = gaps[i];
        const w = S(PIPE_W);
        ctx.fillRect(X(x), Y(0.09), w, S(g - gap / 2 - 0.09));
        ctx.fillRect(X(x) - S(0.008), Y(g - gap / 2 - 0.03), w + S(0.016), S(0.03));
        ctx.fillRect(X(x), Y(g + gap / 2), w, S(PLAY_H - g - gap / 2));
        ctx.fillRect(X(x) - S(0.008), Y(g + gap / 2), w + S(0.016), S(0.03));
      }

      // Bird: a chunky square with a blinking wing and an eye
      const bx = X(BIRD_X), by = Y(birdY);
      ctx.fillRect(bx, by, S(BIRD_SIZE), S(BIRD_SIZE));
      ctx.fillRect(bx + S(BIRD_SIZE), by + S(BIRD_SIZE * 0.3), S(0.018), S(0.016)); // beak
      const wingUp = birdVy < 0 || Math.floor(now / 120) % 2 === 0;
      ctx.fillRect(bx - S(0.016), by + (wingUp ? -S(0.012) : S(BIRD_SIZE * 0.55)), S(0.02), S(0.02));
      ctx.fillStyle = '#000';
      ctx.fillRect(bx + S(BIRD_SIZE * 0.62), by + S(BIRD_SIZE * 0.18), Math.max(2, S(0.01)), Math.max(2, S(0.01)));
      ctx.fillStyle = color;

      // Countdown number
      if (phase === 'countdown') {
        ctx.textAlign = 'center';
        ctx.font = `bold ${Math.round(S(0.14))}px "Courier New", monospace`;
        ctx.fillText(String(Math.ceil(phaseT)), X(0.5), Y(0.55));
        ctx.textAlign = 'left';
      }

      // Dead and waiting for the rival
      if (myDead && phase === 'flying' || (myDead && !rivalFinal)) {
        ctx.textAlign = 'center';
        ctx.font = `${Math.round(S(0.04))}px "Courier New", monospace`;
        if (Math.floor(now / 400) % 2 === 0) {
          ctx.fillText('RIVAL STILL FLYING...', X(0.5), Y(0.5));
        }
        ctx.textAlign = 'left';
      }
    },

    status() {
      if (phase === 'flying' && !myDead) return null;
      if (phase === 'countdown') return 'SAME PIPES, FLY FURTHER';
      if (myDead && !rivalFinal) return `YOU CRASHED AT ${myPipes}`;
      return null;
    }
  });

  // Exposed for automated tests; not part of the game logic
  A.state.fbDebug = () => ({
    phase, roundNum, myPipes, rivalPipes, myDead, rivalDead: rivalFinal, seed
  });
})();
