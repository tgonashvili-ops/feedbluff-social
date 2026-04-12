# CLAUDE.md — FeedBluff Social

AI assistant reference for the FeedBluff Social codebase. Read this before making any changes.

---

## Project Overview

**FeedBluff Social** is a social-casino gambling game built as a full-stack Node.js application with zero external dependencies. Players scroll a mock social media feed, place virtual-coin bets, and cash out before a post "reveals" its outcome. All coins are virtual with no real-money value.

- **Version**: 1.0
- **Runtime**: Node.js >=18.0.0
- **Dependencies**: None — only Node.js built-ins (`http`, `fs`, `path`, `crypto`, `url`)

---

## Repository Layout

```
feedbluff-social/
├── server.js      # Backend HTTP server (~505 lines)
├── index.html     # Frontend single-page application (~859 lines)
└── package.json   # Minimal project metadata, single start script
```

There are **no subdirectories, no build step, no configuration files** (no ESLint, Prettier, TypeScript, Docker, or CI/CD). All backend and frontend code lives in these two root files.

---

## Running the Project

```bash
npm start          # runs: node server.js
# or directly:
node server.js
```

The server starts on port **3000** by default. Override with the `PORT` environment variable:

```bash
PORT=8080 node server.js
```

The only environment variable in use is `PORT`. All other configuration is hardcoded in `server.js`.

**Demo accounts** (all use password `demo123`):
- `GoldRush88`, `LuckyJan`, `Pro_Dealer`, `CryptoKing`, `NightOwl`

---

## Architecture

### Backend (`server.js`)

Pure Node.js HTTP server with no framework. Routing is done via manual URL and method matching. The file is organized into these logical sections:

1. **Config constants** (lines ~15–26) — coin packages, daily bonus, jackpot threshold
2. **In-memory database** (lines ~28–56) — `Map`s and `Array`s; data is lost on restart
3. **Utility helpers** — SHA256 hashing, token generation, JSON response helpers
4. **RNGService** — HMAC-SHA256 provably-fair outcome generation
5. **JackpotService** — pool accumulation (1% of every bet) and distribution
6. **BonusService** — 24-hour daily bonus logic
7. **GameService** — scroll, bet, cashout, open-post game loop
8. **ShopService** — coin package definitions (demo-mode only, no real payments)
9. **HTTP request handler** — manual router with CORS headers
10. **Server startup** — binds to PORT, prints startup banner

**Service pattern**: Static-method classes (no instantiation):
```js
class GameService {
  static scroll(userId) { … }
  static bet(userId, amounts) { … }
  static cashout(userId) { … }
  static openPost(userId) { … }
}
```

### Frontend (`index.html`)

Single HTML file containing embedded `<style>` and `<script>` blocks. No bundler, no framework, no component system.

**State** is held in top-level global variables:
```js
let token, user, bet1, bet2, depth, mult, canOpen, betPlaced
```
`token` is also persisted in `localStorage` as `fb_token`.

**UI updates** are done by direct DOM manipulation (`document.getElementById`, `textContent`, `innerHTML`).

---

## Data Models

### In-Memory DB (`server.js`, lines ~28–37)

```js
const DB = {
  users: new Map(),          // userId → user object
  sessions: new Map(),       // token → userId
  rounds: [],                // all game rounds
  transactions: [],          // coin transaction history
  jackpotPool: 0,
  jackpotHistory: [],
  purchases: [],
};
```

Data is **not persisted** — the DB resets on every server restart.

### User object

```js
{
  id: 'u_<timestamp>',
  username: string,
  passwordHash: string,      // SHA256(password + 'feedbluff_social_v1')
  coins: number,
  rounds: number,
  totalWon: number,
  totalLost: number,
  dailyBonusClaimed: boolean,
  lastLogin: ISO8601 string,
  createdAt: ISO8601 string,
}
```

### Round object

```js
{
  id: 'r_<timestamp>_<userId>',
  userId: string,
  scrollDepth: number,
  multiplier: number,
  status: 'active' | 'completed' | 'cancelled',
  bets: [{ amount, cashedOut }],
  partialCashouts: [],
  startedAt: ISO8601 string,
  outcome: 'jackpot' | 'win' | 'troll' | 'scam' | 'empty',
  totalChange: number,
  completedAt: ISO8601 string,
}
```

### Transaction object

```js
{
  id: 'tx_<timestamp>',
  userId: string,
  type: 'daily_bonus' | 'win' | 'loss' | 'purchase',
  amount: number,
  coinsAfter: number,
  createdAt: ISO8601 string,
}
```

---

## API Reference

**Base URL**: `http://localhost:3000`

All protected routes require:
```
Authorization: Bearer <token>
Content-Type: application/json
```

CORS is open (`*`) for all origins.

### Auth

| Method | Path | Body | Auth Required |
|--------|------|------|---------------|
| POST | `/api/auth/register` | `{ username, password }` | No |
| POST | `/api/auth/login` | `{ username, password }` | No |

### Game

| Method | Path | Body | Auth Required |
|--------|------|------|---------------|
| POST | `/api/game/scroll` | — | Yes |
| POST | `/api/game/bet` | `{ amounts: [n, n] }` | Yes |
| POST | `/api/game/cashout` | — | Yes |
| POST | `/api/game/open` | — | Yes |
| POST | `/api/game/reset` | — | Yes |
| GET | `/api/game/stats` | — | Yes |

### Bonus, Shop, User

| Method | Path | Auth Required |
|--------|------|---------------|
| POST | `/api/bonus/daily` | Yes |
| GET | `/api/bonus/status` | Yes |
| GET | `/api/shop/packages` | No |
| POST | `/api/shop/buy` | Yes |
| GET | `/api/user/me` | Yes |
| GET | `/api/user/coins` | Yes |

### Public

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Serve `index.html` |
| GET | `/api/health` | Health check |
| GET | `/api/leaderboard` | Top 10 users by coins |
| GET | `/api/events` | Server-Sent Events stream |

---

## Game Mechanics

### Core Loop

1. **Scroll** — Each scroll call increments `scrollDepth` and rebuilds the multiplier:
   ```
   multiplier = 1.0 + (depth - 1) * 0.35 + random * 0.2
   ```
2. **Bet** — Up to two simultaneous bets; 1% of each bet contributes to the jackpot pool.
3. **Cashout** (optional) — Partial cashout at current multiplier (50% of bet returned).
4. **Open** — Reveals post outcome via RNG and settles bets.

### RNG (Provably Fair)

Uses HMAC-SHA256 seeded with a server seed, client seed, and nonce. Outcome probabilities:

| Outcome | Base Probability | Effect |
|---------|-----------------|--------|
| jackpot | 6% + scroll bonus (max +6%) | ×2.8 multiplier |
| win | 55% | ×1.1 multiplier |
| troll | 15% | ×0.4 penalty |
| scam | 8% | −80% of bet |
| empty | 16% | No change |

### Jackpot

- 1% of every bet contributes to `DB.jackpotPool`
- When pool reaches `JACKPOT_THRESHOLD` (500,000 coins), it distributes evenly to all users
- Jackpot trigger is broadcast via Server-Sent Events

### Hardcoded Game Constants

```js
const DAILY_BONUS = 2000;       // coins per 24h
const WELCOME_COINS = 10000;    // coins on registration
const JACKPOT_THRESHOLD = 500000;
```

---

## Real-Time Events (SSE)

`GET /api/events` opens a persistent SSE stream. The server pushes:
- Player action summaries (real users + simulated AI players every 3.5 s)
- Jackpot distribution events

Frontend subscribes via `EventSource`:
```js
const es = new EventSource('/api/events');
es.onmessage = (e) => { … };
```

---

## Authentication

- **Registration**: SHA256(`password + 'feedbluff_social_v1'`) stored as `passwordHash`
- **Session tokens**: 32 random bytes from `crypto.randomBytes(32).toString('hex')`
- **Token storage**: `DB.sessions` Map (server-side) + `localStorage` (client-side)
- Tokens do not expire in the current implementation

**Security note**: The password salt is a static string. In production this should be replaced with bcrypt or Argon2 with a per-user salt.

---

## Coding Conventions

### General

- **Pure JavaScript (ES6+)** — no TypeScript, no JSX, no transpilation
- **Zero dependencies** — do not add npm packages without strong justification
- **No build step** — code runs directly with `node server.js`
- Prefer `async/await` over raw Promises or callbacks

### ID Generation

All IDs follow a prefixed `<type>_<timestamp>` pattern:
- Users: `u_<Date.now()>`
- Rounds: `r_<Date.now()>_<userId>`
- Transactions: `tx_<Date.now()>`
- Purchases: `pur_<Date.now()>`

### Error Responses

Return JSON with an `error` string on failure:
```js
res.writeHead(400, headers);
res.end(JSON.stringify({ error: 'Descriptive message' }));
```

Return JSON with `success: true` (and any payload) on success:
```js
res.end(JSON.stringify({ success: true, user, token }));
```

### Service Classes

New backend logic should be added as static methods on an appropriate service class, or as a new static-method class if a new domain is needed. Keep service classes focused on a single domain.

### Frontend

- Use `document.getElementById` for element lookups; prefer caching references
- Global game state lives in top-level `let` variables — minimize additions
- UI updates go through existing helpers (`updateUI()`, `updateMultUI()`)
- Sound effects via `snd(type)` — types: `'scroll'`, `'bet'`, `'win'`, `'jackpot'`, `'troll'`, `'click'`
- API calls use the `api(path, method, body)` helper which injects the auth header

---

## What Does Not Exist (Do Not Assume)

- No test suite — no Jest, Vitest, Mocha, or any test runner
- No linter or formatter configuration
- No TypeScript — do not add `.ts` files or type annotations
- No Docker or CI/CD configuration
- No environment file (`.env`) — no `dotenv` package
- No persistent database — all data is in-memory
- No payment processing — shop purchases are demo-mode only
- No README.md beyond this file

---

## Common Tasks

### Add a new API endpoint

1. Add route handling inside the main `requestHandler` function in `server.js`, following the existing pattern:
   ```js
   if (method === 'POST' && pathname === '/api/your/route') {
     const body = await readBody(req);
     const data = JSON.parse(body);
     const result = YourService.yourMethod(userId, data);
     if (result.error) return send(res, 400, result);
     return send(res, 200, result);
   }
   ```
2. If authentication is required, extract `userId` via the existing session lookup pattern before the route block.

### Add a new game outcome

1. Update `RNGService.generateOutcome()` in `server.js` — adjust the probability weights.
2. Update `GameService.openPost()` to handle the new outcome string.
3. Update the frontend `openPost()` function in `index.html` to render the new outcome.

### Modify coin economy

Edit the constants at the top of `server.js`:
```js
const DAILY_BONUS = 2000;
const WELCOME_COINS = 10000;
const JACKPOT_THRESHOLD = 500000;
```

### Add a new SSE event type

Broadcast from the server by writing to all open SSE response objects stored in the events array. Follow the `data: <JSON>\n\n` SSE protocol format.

---

## Important Caveats

1. **Data loss on restart** — The in-memory DB resets every time the server restarts. Do not rely on persisted state in development.
2. **Single-file architecture** — Both `server.js` and `index.html` are large single files. Keep additions minimal and well-commented with the existing section-header style (`// ── SECTION NAME ──`).
3. **No concurrency safety** — The in-memory DB has no locking. Race conditions are possible under concurrent requests for the same user.
4. **Simulated activity** — The SSE stream emits fake activity from AI players every 3.5 seconds. This is intentional game design, not a bug.
5. **Demo shop only** — `POST /api/shop/buy` does not process real payments. It always succeeds.
