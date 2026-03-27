/**
 * FeedBluff Social — v1.0
 * Social Casino with Virtual Coins
 * Pure Node.js — zero dependencies
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;

// ── COIN PACKAGES ──
const COIN_PACKAGES = [
  { id: 'p1', coins: 5000,   price: 1.99,  label: 'Starter',  bonus: 0 },
  { id: 'p2', coins: 15000,  price: 4.99,  label: 'Popular',  bonus: 2000 },
  { id: 'p3', coins: 35000,  price: 9.99,  label: 'Big Value', bonus: 7000 },
  { id: 'p4', coins: 80000,  price: 19.99, label: 'Mega',     bonus: 20000 },
  { id: 'p5', coins: 250000, price: 49.99, label: 'Ultimate', bonus: 75000 },
];

const DAILY_BONUS = 2000;       // Free coins on daily login
const WELCOME_COINS = 10000;    // Free coins on registration
const JACKPOT_THRESHOLD = 500000; // 500K coins triggers jackpot

// ── DB ──
const DB = {
  users: new Map(),
  sessions: new Map(),
  rounds: [],
  transactions: [],
  jackpotPool: 0,
  jackpotHistory: [],
  purchases: []
};

function seedDB() {
  const demo = [
    { id:'u1', username:'GoldRush88', coins:10000 },
    { id:'u2', username:'LuckyJan',   coins:10000 },
    { id:'u3', username:'Pro_Dealer', coins:10000 },
    { id:'u4', username:'CryptoKing', coins:10000 },
    { id:'u5', username:'NightOwl',   coins:10000 },
  ];
  demo.forEach(u => {
    u.passwordHash = hashPassword('demo123');
    u.createdAt = new Date().toISOString();
    u.lastLogin = new Date().toISOString();
    u.totalWon = 0; u.totalLost = 0; u.rounds = 0;
    u.dailyBonusClaimed = false;
    DB.users.set(u.id, u);
  });
  DB.jackpotPool = Math.floor(Math.random() * 50000) + 10000;
  console.log('✅ DB seeded — 5 demo users, 10,000 coins each');
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'feedbluff_social_v1').digest('hex');
}
function generateToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  DB.sessions.set(token, userId);
  return token;
}
function verifyToken(token) { return DB.sessions.get(token) || null; }
function sanitizeUser(u) {
  if (!u) return null;
  const { passwordHash, ...safe } = u;
  return safe;
}

// ── RNG — 95% RTP ──
class RNGService {
  static generateOutcome(userId, scrollDepth) {
    const serverSeed = crypto.randomBytes(16).toString('hex');
    const clientSeed = crypto.createHash('md5').update(userId).digest('hex').slice(0, 8);
    const nonce = DB.rounds.filter(r => r.userId === userId).length;
    const hash = crypto.createHmac('sha256', serverSeed).update(clientSeed + ':' + nonce).digest('hex');
    const val = parseInt(hash.slice(0, 8), 16) / 0xFFFFFFFF;
    const depthBonus = Math.min(scrollDepth * 0.008, 0.06);

    const J = 0.06 + depthBonus;
    const W = J + 0.55;
    const T = W + 0.15;
    const S = T + 0.08 + depthBonus;

    let outcomeType;
    if (val < J)      outcomeType = 'jackpot';
    else if (val < W) outcomeType = 'win';
    else if (val < T) outcomeType = 'troll';
    else if (val < S) outcomeType = 'scam';
    else              outcomeType = 'empty';

    return {
      outcomeType,
      serverSeedHash: crypto.createHash('sha256').update(serverSeed).digest('hex'),
      clientSeed, nonce
    };
  }

  static calculatePayout(type, bet, multiplier) {
    switch (type) {
      case 'jackpot': return Math.round(bet * multiplier * 2.8) - bet;
      case 'win':     return Math.round(bet * multiplier * 1.1) - bet;
      case 'troll':   return -Math.round(bet * 0.15);
      case 'scam':    return -bet;
      default:        return 0;
    }
  }
}

// ── JACKPOT SERVICE ──
class JackpotService {
  static contribute(betAmount) {
    const contribution = Math.round(betAmount * 0.01);
    DB.jackpotPool += contribution;
    if (DB.jackpotPool >= JACKPOT_THRESHOLD) return this.trigger();
    return null;
  }

  static trigger() {
    const pool = DB.jackpotPool;
    const users = Array.from(DB.users.values());
    if (users.length === 0) return null;
    const share = Math.floor(pool / users.length);
    users.forEach(u => { u.coins += share; });
    DB.jackpotHistory.push({ amount: pool, winners: users.length, share, at: new Date().toISOString() });
    DB.jackpotPool = 0;
    broadcastEvent('jackpot', { amount: pool, share, winners: users.length });
    return { triggered: true, amount: pool, share };
  }
}

// ── DAILY BONUS SERVICE ──
class BonusService {
  static claimDaily(userId) {
    const user = DB.users.get(userId);
    if (!user) return { error: 'User not found' };

    const now = new Date();
    const lastLogin = new Date(user.lastLogin || 0);
    const hoursSince = (now - lastLogin) / (1000 * 60 * 60);

    if (hoursSince < 24 && user.dailyBonusClaimed) {
      const hoursLeft = Math.ceil(24 - hoursSince);
      return { error: 'Come back in ' + hoursLeft + ' hours!', hoursLeft };
    }

    user.coins += DAILY_BONUS;
    user.lastLogin = now.toISOString();
    user.dailyBonusClaimed = true;

    setTimeout(() => { user.dailyBonusClaimed = false; }, 24 * 60 * 60 * 1000);

    DB.transactions.push({
      id: 'tx_' + Date.now(), userId,
      type: 'daily_bonus', amount: DAILY_BONUS,
      coinsAfter: user.coins, createdAt: now.toISOString()
    });

    return { success: true, bonus: DAILY_BONUS, newCoins: user.coins };
  }

  static checkStatus(userId) {
    const user = DB.users.get(userId);
    if (!user) return { canClaim: false };
    const hoursSince = (Date.now() - new Date(user.lastLogin || 0)) / (1000 * 60 * 60);
    const canClaim = hoursSince >= 24 || !user.dailyBonusClaimed;
    return { canClaim, hoursLeft: canClaim ? 0 : Math.ceil(24 - hoursSince) };
  }
}

// ── GAME SERVICE ──
class GameService {
  static scroll(userId) {
    const user = DB.users.get(userId);
    if (!user) return { error: 'User not found' };
    if (user.coins <= 0) return { error: 'No coins! Buy more or claim daily bonus.' };

    let round = DB.rounds.find(r => r.userId === userId && r.status === 'active');
    if (!round) {
      round = {
        id: 'r_' + Date.now() + '_' + userId,
        userId, scrollDepth: 0, multiplier: 1.0,
        status: 'active', bets: [], partialCashouts: [],
        startedAt: new Date().toISOString()
      };
      DB.rounds.push(round);
    }

    round.scrollDepth++;
    round.multiplier = parseFloat(
      (1.0 + (round.scrollDepth - 1) * 0.35 + Math.random() * 0.2).toFixed(2)
    );

    const risk = Math.min(100, round.scrollDepth * 15);
    return {
      success: true,
      scrollDepth: round.scrollDepth,
      multiplier: round.multiplier,
      riskLevel: risk > 70 ? 'DANGER' : risk > 40 ? 'MEDIUM' : 'LOW',
      riskPercent: risk,
      jackpotPool: DB.jackpotPool
    };
  }

  static placeBet(userId, bets) {
    const user = DB.users.get(userId);
    if (!user) return { error: 'User not found' };
    if (!Array.isArray(bets) || bets.length === 0) return { error: 'Invalid bets' };
    if (bets.length > 2) return { error: 'Max 2 bets' };

    const totalBet = bets.reduce((s, b) => s + (b.amount || 0), 0);
    if (totalBet < 10) return { error: 'Minimum bet is 10 coins' };
    if (user.coins < totalBet) return { error: 'Not enough coins! Buy more or claim daily bonus.' };

    let round = DB.rounds.find(r => r.userId === userId && r.status === 'active');
    if (!round) return { error: 'Scroll first!' };

    user.coins -= totalBet;
    round.bets = bets.map(b => ({ amount: b.amount, cashedOut: false }));
    JackpotService.contribute(totalBet);

    return { success: true, bets: round.bets, totalBet, newCoins: user.coins, jackpotPool: DB.jackpotPool };
  }

  static partialCashout(userId, betIndex, fraction) {
    const user = DB.users.get(userId);
    if (!user) return { error: 'User not found' };
    const round = DB.rounds.find(r => r.userId === userId && r.status === 'active');
    if (!round || !round.bets[betIndex]) return { error: 'Invalid round or bet' };

    const bet = round.bets[betIndex];
    if (bet.cashedOut) return { error: 'Already cashed out' };
    if (fraction <= 0 || fraction >= 1) return { error: 'Invalid fraction' };

    const cashAmount = Math.round(bet.amount * fraction * round.multiplier);
    bet.amount = Math.round(bet.amount * (1 - fraction));
    user.coins += cashAmount;

    round.partialCashouts = round.partialCashouts || [];
    round.partialCashouts.push({ betIndex, fraction, amount: cashAmount, mult: round.multiplier });

    JackpotService.contribute(cashAmount);
    broadcastEvent('activity', {
      message: '<strong>' + user.username + '</strong> cashed out <span class="win">' + cashAmount.toLocaleString() + ' 🪙</span> at ×' + round.multiplier
    });

    return { success: true, cashAmount, remainingBet: bet.amount, newCoins: user.coins, multiplier: round.multiplier };
  }

  static openPost(userId) {
    const user = DB.users.get(userId);
    if (!user) return { error: 'User not found' };
    const round = DB.rounds.find(r => r.userId === userId && r.status === 'active');
    if (!round) return { error: 'Scroll first!' };
    if (!round.bets || round.bets.length === 0) return { error: 'Place a bet first!' };

    const rng = RNGService.generateOutcome(userId, round.scrollDepth);
    let totalChange = 0;
    const results = round.bets.map((bet, i) => {
      if (bet.cashedOut || bet.amount <= 0) return { betIndex: i, amount: 0, change: 0 };
      const change = RNGService.calculatePayout(rng.outcomeType, bet.amount, round.multiplier);
      totalChange += change;
      return { betIndex: i, amount: bet.amount, change };
    });

    user.coins = Math.max(0, user.coins + totalChange);
    user.rounds = (user.rounds || 0) + 1;
    if (totalChange > 0) user.totalWon = (user.totalWon || 0) + totalChange;
    else user.totalLost = (user.totalLost || 0) + Math.abs(totalChange);

    round.status = 'completed';
    round.outcome = rng.outcomeType;
    round.totalChange = totalChange;
    round.completedAt = new Date().toISOString();

    const jpResult = JackpotService.contribute(Math.abs(totalChange));

    DB.transactions.push({
      id: 'tx_' + Date.now(), userId,
      type: totalChange >= 0 ? 'win' : 'loss',
      amount: Math.abs(totalChange), coinsAfter: user.coins,
      createdAt: new Date().toISOString()
    });

    broadcastEvent('activity', {
      message: totalChange > 0
        ? '<strong>' + user.username + '</strong> won <span class="win">+' + totalChange.toLocaleString() + ' 🪙</span>'
        : '<strong>' + user.username + '</strong> <span class="loss">lost ' + Math.abs(totalChange).toLocaleString() + ' 🪙</span>'
    });

    return {
      success: true, outcome: rng.outcomeType, results, totalChange,
      newCoins: user.coins, multiplier: round.multiplier, scrollDepth: round.scrollDepth,
      jackpotPool: DB.jackpotPool, jackpotTriggered: jpResult,
      provablyFair: { serverSeedHash: rng.serverSeedHash, clientSeed: rng.clientSeed, nonce: rng.nonce }
    };
  }

  static resetRound(userId) {
    const idx = DB.rounds.findIndex(r => r.userId === userId && r.status === 'active');
    if (idx !== -1) DB.rounds[idx].status = 'cancelled';
    return { success: true };
  }

  static getStats(userId) {
    const user = DB.users.get(userId);
    if (!user) return { error: 'Not found' };
    const rounds = DB.rounds.filter(r => r.userId === userId && r.status === 'completed');
    const wins = rounds.filter(r => (r.totalChange || 0) > 0);
    return {
      totalRounds: rounds.length,
      winRate: rounds.length > 0 ? ((wins.length / rounds.length) * 100).toFixed(1) : 0,
      totalWon: user.totalWon || 0,
      totalLost: user.totalLost || 0,
      biggestWin: rounds.length > 0 ? Math.max(0, ...rounds.map(r => r.totalChange || 0)) : 0,
      jackpotPool: DB.jackpotPool
    };
  }
}

// ── SHOP SERVICE ──
class ShopService {
  static getPackages() {
    return { packages: COIN_PACKAGES };
  }

  // Demo purchase (no real payment)
  static demoPurchase(userId, packageId) {
    const user = DB.users.get(userId);
    if (!user) return { error: 'User not found' };
    const pkg = COIN_PACKAGES.find(p => p.id === packageId);
    if (!pkg) return { error: 'Package not found' };

    const totalCoins = pkg.coins + pkg.bonus;
    user.coins += totalCoins;

    DB.purchases.push({
      id: 'pur_' + Date.now(), userId,
      packageId, coins: totalCoins,
      price: pkg.price, createdAt: new Date().toISOString()
    });

    DB.transactions.push({
      id: 'tx_' + Date.now(), userId,
      type: 'purchase', amount: totalCoins,
      coinsAfter: user.coins, createdAt: new Date().toISOString()
    });

    broadcastEvent('activity', {
      message: '<strong>' + user.username + '</strong> purchased <span class="win">' + totalCoins.toLocaleString() + ' 🪙</span>'
    });

    return { success: true, coinsAdded: totalCoins, newCoins: user.coins, package: pkg };
  }
}

// ── SSE ──
const sseClients = new Set();
function broadcastEvent(type, data) {
  const msg = 'data: ' + JSON.stringify({ type, data, ts: Date.now() }) + '\n\n';
  sseClients.forEach(c => { try { c.write(msg); } catch {} });
}

const A_NAMES = ['Alex K.','Maria S.','BigBet Tom','LuckyJan','Pro_Dealer','NightOwl','CryptoKing','GoldRush'];
setInterval(() => {
  const n = A_NAMES[Math.floor(Math.random() * A_NAMES.length)];
  const a = Math.floor(Math.random() * 5000 + 100).toLocaleString();
  const m = (Math.random() * 4 + 1).toFixed(1);
  const msgs = [
    '<strong>' + n + '</strong> won <span class="win">+' + a + ' 🪙</span>',
    '<strong>' + n + '</strong> <span class="loss">lost ' + Math.floor(Math.random()*2000+100).toLocaleString() + ' 🪙</span>',
    '<strong>' + n + '</strong> scrolling ×' + m + '...',
    '<strong>' + n + '</strong> cashed out ' + a + ' 🪙 at ×' + m,
    '<strong>' + n + '</strong> claimed daily bonus! 🎁',
  ];
  broadcastEvent('activity', { message: msgs[Math.floor(Math.random() * msgs.length)] });
  DB.jackpotPool += Math.floor(Math.random() * 500);
  broadcastEvent('jackpot_update', { pool: DB.jackpotPool });
}, 3500);

// ── HTTP ──
function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function getBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const p = url.parse(req.url).pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    return res.end();
  }

  if (p === '/' || p === '/index.html') {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(html);
    } catch (e) { return send(res, 500, { error: 'index.html not found' }); }
  }

  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
    res.write('data: ' + JSON.stringify({ type: 'connected', data: { onlineCount: DB.users.size + 2847, jackpotPool: DB.jackpotPool } }) + '\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (p === '/api/health') return send(res, 200, { status: 'ok', users: DB.users.size, jackpotPool: DB.jackpotPool, uptime: Math.floor(process.uptime()) + 's' });
  if (p === '/api/leaderboard' && req.method === 'GET') {
    const lb = Array.from(DB.users.values()).sort((a, b) => b.coins - a.coins).slice(0, 10).map((u, i) => ({ rank: i + 1, username: u.username, coins: u.coins, rounds: u.rounds || 0 }));
    return send(res, 200, { leaderboard: lb });
  }
  if (p === '/api/shop/packages' && req.method === 'GET') return send(res, 200, ShopService.getPackages());

  const body = await getBody(req);

  // Auth
  if (p === '/api/auth/register' && req.method === 'POST') {
    const { username, password } = body;
    if (!username || !password) return send(res, 400, { error: 'Fill in all fields' });
    if (username.length < 3) return send(res, 400, { error: 'Username too short (min 3 chars)' });
    if (Array.from(DB.users.values()).find(u => u.username === username)) return send(res, 400, { error: 'Username taken' });
    const user = {
      id: 'u_' + Date.now(), username,
      passwordHash: hashPassword(password),
      coins: WELCOME_COINS, rounds: 0,
      totalWon: 0, totalLost: 0,
      dailyBonusClaimed: false,
      lastLogin: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };
    DB.users.set(user.id, user);
    return send(res, 201, { token: generateToken(user.id), user: sanitizeUser(user), welcomeBonus: WELCOME_COINS });
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    const { username, password } = body;
    const user = Array.from(DB.users.values()).find(u => u.username === username);
    if (!user || user.passwordHash !== hashPassword(password)) return send(res, 401, { error: 'Wrong username or password' });
    return send(res, 200, { token: generateToken(user.id), user: sanitizeUser(user) });
  }

  // Protected
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const userId = verifyToken(token);
  if (!userId) return send(res, 401, { error: 'Please login first' });

  // Game
  if (p === '/api/game/scroll'   && req.method === 'POST') return send(res, 200, GameService.scroll(userId));
  if (p === '/api/game/bet'      && req.method === 'POST') return send(res, 200, GameService.placeBet(userId, body.bets));
  if (p === '/api/game/cashout'  && req.method === 'POST') return send(res, 200, GameService.partialCashout(userId, body.betIndex || 0, body.fraction || 0.5));
  if (p === '/api/game/open'     && req.method === 'POST') return send(res, 200, GameService.openPost(userId));
  if (p === '/api/game/reset'    && req.method === 'POST') return send(res, 200, GameService.resetRound(userId));
  if (p === '/api/game/stats'    && req.method === 'GET')  return send(res, 200, GameService.getStats(userId));

  // Bonus
  if (p === '/api/bonus/daily'   && req.method === 'POST') return send(res, 200, BonusService.claimDaily(userId));
  if (p === '/api/bonus/status'  && req.method === 'GET')  return send(res, 200, BonusService.checkStatus(userId));

  // Shop
  if (p === '/api/shop/buy'      && req.method === 'POST') return send(res, 200, ShopService.demoPurchase(userId, body.packageId));

  // User
  if (p === '/api/user/me'       && req.method === 'GET') return send(res, 200, { user: sanitizeUser(DB.users.get(userId)) });
  if (p === '/api/user/coins'    && req.method === 'GET') return send(res, 200, { coins: DB.users.get(userId)?.coins || 0 });

  send(res, 404, { error: 'Not found' });
});

seedDB();
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   🪙 FeedBluff Social — v1.0             ║');
  console.log(`║   http://localhost:${PORT}                  ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║   Welcome Coins: 10,000 🪙               ║');
  console.log('║   Daily Bonus:    2,000 🪙               ║');
  console.log('║   Jackpot Pool:   1% of every bet        ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log('║   Login: GoldRush88 / demo123            ║');
  console.log('╚══════════════════════════════════════════╝');
});

module.exports = { DB, GameService, RNGService, JackpotService, BonusService, ShopService };
