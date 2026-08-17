# MY ARCADE

A page of classic-game variants, built for **two phones connected over the
internet**. Very simple, very old fashioned: black, white and *beeps*.

Games live side by side in this single repository and share one server,
one deploy and one look.

## Games

| Game | Path | Two-phone twist |
|------|------|-----------------|
| **PONG** (1972) | [`/pong/`](public/pong) | The ball crosses between screens. 1-3 balls, SHRINK & GHOST modes |
| **BRICKS** | [`/bricks/`](public/bricks) | Pong meets Breakout: every brick of yours smashed is a rival point |
| **SNAKE** (1976) | [`/snake/`](public/snake) | Every apple you eat drops a wall block into the rival's arena |
| **BREAKOUT** (1976) | [`/breakout/`](public/breakout) | Same wall on both phones: fastest demolition wins |
| **INVADERS** (1978) | [`/invaders/`](public/invaders) | Clear a row and it lands on top of the rival's formation |
| **MISSILES** (1980) | [`/missiles/`](public/missiles) | Every third intercept launches a missile at the rival |
| **FROGGER** (1981) | [`/frogger/`](public/frogger) | Crossing race against the clock |
| **TETRIS** (1984) | [`/tetris/`](public/tetris) | Multi-line clears send garbage rows to the rival |
| **MINES** | [`/mines/`](public/mines) | Minesweeper race on separate boards: a mine resets yours, first clear wins |
| **FLAPPY** (2013) | [`/flappy/`](public/flappy) | Best of 5: both fly the same pipe course, furthest flight wins the round |

All matches share the same flow: pick options, share a link, timed match
(1-4 min) with the countdown between the scores, everything turns red
under 30 seconds, and the match ends with confetti for the winner and a
pixel sad face for the loser.

## How multiplayer works

- Each player opens a game in their **phone's browser** (nothing to install).
- One player configures the match (time, balls...), taps **CREATE GAME**
  and gets a **link to share** (WhatsApp, SMS, whatever).
- The other player simply **opens the link** and the match starts. Players
  can be on **different networks anywhere in the world**: both phones
  connect to the server over WebSocket and it pairs them up.
- If a phone leaves the browser for any reason the game **pauses** and the
  seat is held for **10 minutes**; the session, the score and the match
  resume automatically when the player comes back.

## Architecture

```
phone 1  ──WebSocket──►  server (relay + rooms)  ◄──WebSocket──  phone 2
```

- `public/index.html` — the portal: the list of games.
- `public/arcade.js` — the shared client engine: rooms, link invites,
  resume after any disconnect, match clock (host is the referee), pause
  while a player is away, score sync, retro frame and end scenes. A game
  registers with `Arcade.register({...})` and only implements physics,
  drawing, input and its own messages.
- `public/<game>/` — each game: an HTML page plus a small `game.js` module.
- `public/style.css` — shared retro stylesheet (1972 CRT look).
- `lib/rooms.js` — room, relay and resume logic. **Game-agnostic**: it
  pairs two phones and relays opaque messages, so every game uses it.
- `api/ws.js` — the relay as a Vercel function (native WebSockets).
- `server.js` — the same thing for local play or a VPS.
- Game physics run only on the phones; the server never simulates.

## Back office

`/admin/` is the back office: log in to see per-game stats (page visits,
games created, games played) and to change the admin credentials.
Default login is `admin` / `admin` — **change it right after the first
deploy**, from the panel itself.

Stats, credentials and sessions live in the storage layer (`lib/store.js`),
which picks its backend automatically:

1. **Postgres / Neon** (recommended): set a `DATABASE_URL` env var in the
   Vercel project with a Neon connection string. Uses Neon's serverless
   HTTP driver; the `arcade_kv` table is created automatically on first
   use. Persistent.
2. **Upstash Redis**: detected via `KV_REST_API_URL/TOKEN` (or
   `UPSTASH_REDIS_REST_URL/TOKEN`). Persistent.
3. **In-memory** fallback: fine locally, but on Vercel the counters and
   any changed password reset whenever the function instance is recycled.

The panel header shows which mode is active.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000 in two tabs or two devices on the same network
```

## Deploy on Vercel

1. Go to [vercel.com](https://vercel.com), **Add New… → Project** and import
   this repository.
2. Change nothing (framework "Other", no build command) and hit **Deploy**.
3. Share `https://your-project.vercel.app` — the portal — with your players.

Notes on Vercel's WebSocket beta (public beta since June 2026, on Fluid
compute):

- **Fluid compute must be on** (default for new projects).
- A connection lasts at most `maxDuration` (300 s on the Hobby plan, set in
  `vercel.json`); after a drop the clients reconnect and resume by themselves.
- Rooms live in the instance's memory. If both players vanish for several
  minutes the room may be lost (rare with low traffic): create a new game.

## Adding a new game

1. Create `public/<game>/` with its `index.html` and code; link the shared
   `../style.css` for the retro look.
2. Use the same WebSocket protocol against `/api/ws`: `create` / `join` /
   `resume` / `leave`, plus your own opaque game messages relayed to the
   rival (see `public/pong/game.js` for a complete example with pause,
   resume and clock sync).
3. Add a card for it in `public/index.html`.
