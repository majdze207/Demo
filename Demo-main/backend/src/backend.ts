// =========================================================================
//  backend.ts — COMPLETE FINAL SERVER
//  Full production backend with progressive jackpots, per-game edges,
//  betting bonus wheel, admin lottery control, and all core features
// =========================================================================
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import pino from 'pino';
import { Pool, PoolClient } from 'pg';
import { ethers } from 'ethers';
import cron from 'node-cron';
import 'dotenv/config';

// =========================================================================
//  SECTION 1: ENV + LOGGER + DB POOL
// =========================================================================
const ENV = {
  PORT: Number(process.env.PORT || 5000),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL!,
  DB_SSL: process.env.DB_SSL === 'true',
  DB_SSL_REJECT_UNAUTHORIZED: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
  DB_SSL_CA: process.env.DB_SSL_CA,
  JWT_SECRET: process.env.JWT_SECRET!,
  BSC_RPC: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/',
  USDT: (process.env.USDT_BEP20 || '0x55d398326f99059fF775485246999027B3197955').toLowerCase(),
  PLATFORM_WALLET: (process.env.PLATFORM_WALLET || '0x0000000000000000000000000000000000000000').toLowerCase(),
  CHAIN_ID: Number(process.env.BSC_CHAIN_ID || 56),
  MIN_CONFIRMATIONS: Number(process.env.MIN_CONFIRMATIONS || 3),
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'admin@cryptoplay.io',
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
};

const logger = pino({
  level: ENV.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: ENV.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});

const sslConfig = ENV.DB_SSL
  ? {
      rejectUnauthorized: ENV.DB_SSL_REJECT_UNAUTHORIZED,
      ...(ENV.DB_SSL_CA ? { ca: ENV.DB_SSL_CA } : {}),
    }
  : false;

const pool = new Pool({
  connectionString: ENV.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: sslConfig,
});
pool.on('error', (err) => logger.error({ err }, 'PG pool error'));

const query = (text: string, params?: any[]) => pool.query(text, params);

const withTransaction = async <T>(cb: (c: PoolClient) => Promise<T>): Promise<T> => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await cb(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
};

const lockUser = async (c: PoolClient, uid: string) => {
  const r = await c.query(
    `SELECT id,email,username,balance,demo_balance,status,package,
            active_ref_count,wallet_address,last_bonus_spin,
            referrer_pkg_snapshot,referrer_activity_pct,total_wagered,
            streak_count,last_login_date,last_login_at,xp,level,
            daily_withdrawn_total,daily_withdrawn_date,
            monthly_withdrawn_total,monthly_withdrawn_month,
            wager_locked_until,last_demo_reset
     FROM users WHERE id=$1 FOR UPDATE`, [uid]);
  if (!r.rowCount) throw Object.assign(new Error('USER_NOT_FOUND'), { status: 404 });
  return r.rows[0];
};

// =========================================================================
//  SECTION 2: CRYPTO / HASH UTILS
// =========================================================================
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const hmac512 = (k: string, m: string) => crypto.createHmac('sha512', k).update(m).digest('hex');
const randHex = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
const randInt = (min: number, max: number) => crypto.randomInt(min, max);

const pickWeighted = <T extends { weight: number }>(items: T[]): T => {
  const SCALE = 100_000;
  const buckets = items.map((i) => Math.round(i.weight * SCALE));
  const total = buckets.reduce((s, b) => s + b, 0);
  const r = randInt(0, total);
  let acc = 0;
  for (let i = 0; i < items.length; i++) { acc += buckets[i]; if (r < acc) return items[i]; }
  return items[items.length - 1];
};

const computeRoll = (ss: string, cs: string, nonce: number) => {
  const h = hmac512(ss, `${cs}:${nonce}`);
  const int = parseInt(h.slice(0, 8), 16);
  return Math.floor(((int / 0x100000000) * 100) * 100) / 100;
};

const verifyRoll = (ss: string, cs: string, nonce: number, expected: number) => {
  const roll = computeRoll(ss, cs, nonce);
  return { roll, matches: Math.abs(roll - expected) < 0.005, server_seed_hash: sha256(ss) };
};

// =========================================================================
//  SECTION 3: RATE LIMITERS / PAGINATION / SANITIZE
// =========================================================================
interface Bucket { timestamps: number[]; }
const rlStore = new Map<string, Bucket>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rlStore.entries())
    if (v.timestamps.every((t) => now - t > 86_400_000)) rlStore.delete(k);
}, 60_000);

const rateLimit = (windowMs: number, max: number) =>
  (req: Request, res: Response, next: NextFunction) => {
    const key = `rl:${(req as any).user?.id || req.ip}:${req.baseUrl}${req.path}`;
    const now = Date.now();
    const bucket = rlStore.get(key) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
    if (bucket.timestamps.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - bucket.timestamps[0])) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ success: false, error: 'RATE_LIMITED', retryAfter });
    }
    bucket.timestamps.push(now);
    rlStore.set(key, bucket);
    next();
  };

const sensitiveLimit = rateLimit(30_000, 1);
const betLimit       = rateLimit(1_000, 1);
const authLimit      = rateLimit(60_000, 5);
const readLimit      = rateLimit(1_000, 20);
const adminLimit     = rateLimit(60_000, 30);

const paginationGuard = (maxLimit = 50, defLimit = 20) =>
  (req: Request, res: Response, next: NextFunction) => {
    const rawL = parseInt(req.query.limit as string, 10);
    const rawP = parseInt(req.query.page as string, 10);
    const limit = Math.min(Number.isFinite(rawL) ? Math.max(1, rawL) : defLimit, maxLimit);
    const page  = Number.isFinite(rawP) && rawP > 0 ? rawP : 1;
    if ((page - 1) * limit > 5_000)
      return res.status(400).json({ success: false, error: 'OFFSET_TOO_LARGE' });
    (req as any).pagination = { limit, offset: (page - 1) * limit, page };
    next();
  };

const SENSITIVE = new Set(['password_hash', 'server_seed', 'totp_secret', 'reset_token', 'internal_notes']);
const sanitize = <T extends Record<string, any>>(row: T): Partial<T> => {
  const out: any = {};
  for (const [k, v] of Object.entries(row)) if (!SENSITIVE.has(k)) out[k] = v;
  return out;
};
const sanitizeMany = <T extends Record<string, any>>(rows: T[]) => rows.map(sanitize);

// =========================================================================
//  SECTION 4: JWT + AUTH + ADMIN MIDDLEWARE
// =========================================================================
const signToken = (payload: object) =>
  jwt.sign(payload, ENV.JWT_SECRET, { expiresIn: '7d' });

const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [scheme, token] = (req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer' || !token)
      return res.status(401).json({ success: false, error: 'NO_TOKEN' });
    let payload: any;
    try { payload = jwt.verify(token, ENV.JWT_SECRET); }
    catch { return res.status(401).json({ success: false, error: 'INVALID_TOKEN' }); }
    const r = await query(
      `SELECT id,email,username,package,status,balance,demo_balance,
              active_ref_count,streak_count,last_login_date,xp,level
       FROM users WHERE id=$1`, [payload.id]);
    if (!r.rowCount) return res.status(401).json({ success: false, error: 'USER_NOT_FOUND' });
    if (r.rows[0].status === 'banned')
      return res.status(403).json({ success: false, error: 'ACCOUNT_BANNED' });
    (req as any).user = r.rows[0];
    next();
  } catch (e) { next(e); }
};

const adminMiddleware = (req: Request, res: Response, next: NextFunction) => {
  if ((req as any).user?.email !== ENV.ADMIN_EMAIL)
    return res.status(403).json({ success: false, error: 'ADMIN_ONLY' });
  next();
};

// =========================================================================
//  SECTION 5: IDEMPOTENCY MIDDLEWARE
// =========================================================================
const idempotency = (endpoint: string) => async (req: Request, res: Response, next: NextFunction) => {
  const key = req.header('Idempotency-Key') || (req.body && req.body.idempotencyKey);
  if (!key || typeof key !== 'string' || key.length < 8 || key.length > 120)
    return res.status(400).json({ success: false, error: 'IDEMPOTENCY_KEY_REQUIRED' });
  const userId = (req as any).user?.id || null;
  const requestHash = sha256(JSON.stringify(req.body || {}));
  try {
    const existing = await query(
      `SELECT key,user_id,request_hash,response,status_code,expires_at
       FROM idempotency_keys WHERE key=$1`, [key]);
    if (existing.rowCount) {
      const row = existing.rows[0];
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        await query('DELETE FROM idempotency_keys WHERE key=$1', [key]);
      } else {
        if (row.request_hash !== requestHash)
          return res.status(409).json({ success: false, error: 'IDEMPOTENCY_KEY_CONFLICT' });
        if (row.response)
          return res.status(row.status_code || 200).json(row.response);
        return res.status(409).json({ success: false, error: 'IDEMPOTENCY_IN_PROGRESS' });
      }
    }
    await query(
      `INSERT INTO idempotency_keys (key,user_id,endpoint,request_hash)
       VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING`,
      [key, userId, endpoint, requestHash]);
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      query(`UPDATE idempotency_keys SET response=$1, status_code=$2 WHERE key=$3`,
        [JSON.stringify(body), res.statusCode, key]).catch(() => {});
      return originalJson(body);
    };
    next();
  } catch (e) { next(e); }
};

// =========================================================================
//  SECTION 6: WEB3 — USDT BEP-20 VALIDATOR
// =========================================================================
const provider = new ethers.JsonRpcProvider(ENV.BSC_RPC, { chainId: ENV.CHAIN_ID, name: 'bsc' });
const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];
const erc20 = new ethers.Interface(ERC20_ABI);
let USDT_DECIMALS: number | null = null;

const getUsdtDecimals = async (): Promise<number> => {
  if (USDT_DECIMALS !== null) return USDT_DECIMALS;
  const c = new ethers.Contract(ENV.USDT, ERC20_ABI, provider);
  USDT_DECIMALS = Number(await c.decimals());
  return USDT_DECIMALS;
};

const verifyUsdtPayment = async (txHash: string) => {
  try {
    if (!ethers.isHexString(txHash, 32)) return { success: false, reason: 'INVALID_HASH' };
    const tx = await provider.getTransaction(txHash);
    if (!tx) return { success: false, reason: 'TX_NOT_FOUND' };
    const rc = await provider.getTransactionReceipt(txHash);
    if (!rc) return { success: false, reason: 'TX_PENDING' };
    if (rc.status !== 1) return { success: false, reason: 'TX_FAILED' };
    if (tx.to?.toLowerCase() !== ENV.USDT) return { success: false, reason: 'NOT_USDT' };
    const log = rc.logs.find((l) => l.address.toLowerCase() === ENV.USDT);
    if (!log) return { success: false, reason: 'NO_TRANSFER' };
    const parsed = erc20.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed || parsed.name !== 'Transfer') return { success: false, reason: 'BAD_EVENT' };
    const to = parsed.args.to as string;
    const valueWei = parsed.args.value as bigint;
    if (to.toLowerCase() !== ENV.PLATFORM_WALLET)
      return { success: false, reason: 'WRONG_RECIPIENT' };
    const decimals = await getUsdtDecimals();
    const amount = ethers.formatUnits(valueWei, decimals);
    const currentBlock = await provider.getBlockNumber();
    const confirmations = currentBlock - rc.blockNumber + 1;
    return {
      success: true,
      isFinal: confirmations >= ENV.MIN_CONFIRMATIONS,
      details: {
        txHash, from: parsed.args.from as string, to,
        amount, decimals, confirmations, blockNumber: rc.blockNumber,
      },
    };
  } catch (e: any) {
    logger.error({ e, txHash }, 'verifyUsdtPayment failed');
    return { success: false, reason: 'RPC_ERROR', error: e.message };
  }
};

// =========================================================================
//  SECTION 7: SETTINGS CACHE
// =========================================================================
const settingCache = new Map<string, { value: any; exp: number }>();
const getSetting = async (key: string): Promise<any> => {
  const c = settingCache.get(key);
  if (c && c.exp > Date.now()) return c.value;
  const r = await query('SELECT value FROM platform_settings WHERE key=$1', [key]);
  if (!r.rowCount) throw new Error(`SETTING_${key}_MISSING`);
  settingCache.set(key, { value: r.rows[0].value, exp: Date.now() + 60_000 });
  return r.rows[0].value;
};
const invalidateSetting = (key: string) => settingCache.delete(key);

const getHouseEdge = async (pkg: string, game: 'dice'|'prediction'|'boxes'|'wheel', demo: boolean) => {
  const cfg = await getSetting('per_game_edge');
  const gcfg = cfg[game] || {};
  const base = gcfg[pkg] ?? gcfg.none ?? 0.15;
  if (!demo) return base;
  const dm = await getSetting('demo_mode');
  const mult = Number(dm.house_edge_multiplier ?? 0.4);
  return +(base * mult).toFixed(4);
};
const getPackageRates = () => getSetting('package_rates');
const getWithdrawalFee = () => getSetting('withdrawal_fee');
const getWheelConfig = () => getSetting('bonus_wheel');
const getStreakRewards = () => getSetting('streak_rewards');
const getGamesEnabled = () => getSetting('games_enabled');
const getLotteryCut = () => getSetting('lottery_platform_cut');
const getDemoMode = () => getSetting('demo_mode');
const getWithdrawalLimits = () => getSetting('withdrawal_limits');

// =========================================================================
//  SECTION 8: AUDIT LOG HELPER
// =========================================================================
const writeAudit = async (opts: {
  adminId: string; adminEmail: string; action: string;
  targetType?: string; targetId?: string;
  before?: any; after?: any;
  ip?: string; ua?: string;
}) => {
  try {
    await query(
      `INSERT INTO audit_log
         (admin_id,admin_email,action,target_type,target_id,
          before_state,after_state,ip_address,user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [opts.adminId, opts.adminEmail, opts.action, opts.targetType || null,
       opts.targetId || null,
       opts.before ? JSON.stringify(opts.before) : null,
       opts.after ? JSON.stringify(opts.after) : null,
       opts.ip || null, opts.ua || null]);
  } catch (e) { logger.error({ e }, 'audit write failed'); }
};

// =========================================================================
//  SECTION 9: AUTH SERVICE
// =========================================================================
const registerUser = async (p: { email: string; password: string; username?: string; referralCode?: string }) => {
  const exists = await query('SELECT 1 FROM users WHERE email=$1', [p.email]);
  if (exists.rowCount) throw Object.assign(new Error('EMAIL_TAKEN'), { status: 409 });

  let referrer: any = null;
  if (p.referralCode) {
    const r = await query('SELECT id,package,status FROM users WHERE referral_code=$1', [p.referralCode]);
    if (!r.rowCount) throw Object.assign(new Error('INVALID_REFERRAL_CODE'), { status: 400 });
    if (r.rows[0].status === 'banned') throw Object.assign(new Error('REFERRER_BANNED'), { status: 403 });
    referrer = r.rows[0];
  }

  const rates = await getPackageRates();
  const refPkg = referrer?.package || 'none';
  const snap = rates[refPkg] || rates.none;

  const hash = await bcrypt.hash(p.password, 12);
  let code: string = '';
  for (let i = 0; i < 5; i++) {
    code = 'U' + randHex(3).toUpperCase();
    const d = await query('SELECT 1 FROM users WHERE referral_code=$1', [code]);
    if (!d.rowCount) break;
  }

  const r = await query(
    `INSERT INTO users
       (email,password_hash,username,referral_code,referred_by,
        referrer_pkg_snapshot,referrer_activity_pct)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id,email,username,referral_code,package,status,balance,
               demo_balance,referrer_pkg_snapshot,created_at`,
    [p.email, hash, p.username || null, code,
     referrer?.id || null, refPkg, snap.activity || 0]);
  const user = r.rows[0];
  const token = signToken({ id: user.id, email: user.email });
  return { user, token };
};

const loginUser = async (email: string, password: string) => {
  const u = await query(
    `SELECT id,email,username,password_hash,package,status,balance,demo_balance,
            referral_code,streak_count,last_login_date,xp,level
     FROM users WHERE email=$1`, [email]);
  if (!u.rowCount) throw Object.assign(new Error('INVALID_CREDENTIALS'), { status: 401 });
  const user = u.rows[0];
  if (user.status === 'banned') throw Object.assign(new Error('ACCOUNT_BANNED'), { status: 403 });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw Object.assign(new Error('INVALID_CREDENTIALS'), { status: 401 });
  await query('UPDATE users SET last_login_at=NOW() WHERE id=$1', [user.id]);
  delete user.password_hash;
  const token = signToken({ id: user.id, email: user.email });
  return { user, token };
};

// =========================================================================
//  SECTION 10: STREAK + MISSIONS
// =========================================================================
const applyDailyStreak = async (c: PoolClient, userId: string) => {
  const r = await c.query(
    `SELECT streak_count, last_login_date, last_login_at FROM users WHERE id=$1 FOR UPDATE`, [userId]);
  const u = r.rows[0];
  const today = new Date().toISOString().slice(0, 10);
  const last = u.last_login_date ? new Date(u.last_login_date).toISOString().slice(0, 10) : null;

  // منع إعادة الفحص إذا مر أقل من 24 ساعة
  if (last === today) return { applied: false, streak_count: u.streak_count, reward: 0 };

  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const newStreak = last === yesterday ? u.streak_count + 1 : 1;
  const cfg = await getStreakRewards();
  const dayIdx = Math.min(newStreak, cfg.daily.length) - 1;
  const reward = Number(cfg.daily[dayIdx] || 0);

  await c.query(
    `UPDATE users SET streak_count=$1, last_login_date=$2, xp=xp+5 WHERE id=$3`,
    [newStreak, today, userId]);

  if (reward > 0) {
    await c.query(
      `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
       VALUES ($1,'streak_reward',$2,'confirmed',$3,FALSE)`,
      [userId, reward, JSON.stringify({ streak: newStreak, day: dayIdx + 1 })]);
    await c.query(
      `INSERT INTO notifications (user_id,title,body,type,category)
       VALUES ($1,'Daily Streak',$2,'success','streak')`,
      [userId, `Day ${newStreak} streak: +${reward} USDT`]);
  }

  await c.query(
    `INSERT INTO user_missions (user_id,mission_id,progress,day,completed_at)
     SELECT $1, id, 1, CURRENT_DATE, NOW() FROM missions WHERE key='daily_login'
     ON CONFLICT (user_id,mission_id,day) DO UPDATE
       SET progress=1, completed_at=COALESCE(user_missions.completed_at, NOW())`,
    [userId]);

  return { applied: true, streak_count: newStreak, reward };
};

const ensureMissionsForToday = async (userId: string) => {
  await query(
    `INSERT INTO user_missions (user_id, mission_id, progress, day)
     SELECT $1, id, 0, CURRENT_DATE FROM missions WHERE is_active=TRUE
     ON CONFLICT (user_id, mission_id, day) DO NOTHING`,
    [userId]);
};

const progressMission = async (c: PoolClient, userId: string, kind: string, addAmount = 1) => {
  const missions = await c.query(
    `SELECT id, kind, target_count FROM missions WHERE is_active=TRUE AND kind=$1`, [kind]);
  for (const m of missions.rows) {
    await c.query(
      `INSERT INTO user_missions (user_id,mission_id,progress,day)
       VALUES ($1,$2,0,CURRENT_DATE)
       ON CONFLICT (user_id,mission_id,day) DO NOTHING`,
      [userId, m.id]);
    await c.query(
      `UPDATE user_missions
         SET progress = progress + $1,
             completed_at = CASE
               WHEN progress + $1 >= $2 AND completed_at IS NULL THEN NOW()
               ELSE completed_at END
       WHERE user_id=$3 AND mission_id=$4 AND day=CURRENT_DATE`,
      [addAmount, m.target_count, userId, m.id]);
  }
};

const claimMission = async (userId: string, missionId: string) => {
  return withTransaction(async (c) => {
    const r = await c.query(
      `SELECT um.id, um.progress, um.completed_at, um.claimed_at,
              m.reward_usdt, m.reward_xp, m.target_count, m.title
       FROM user_missions um
       JOIN missions m ON m.id=um.mission_id
       WHERE um.user_id=$1 AND um.mission_id=$2 AND um.day=CURRENT_DATE
       FOR UPDATE`, [userId, missionId]);
    if (!r.rowCount) throw Object.assign(new Error('MISSION_NOT_FOUND'), { status: 404 });
    const row = r.rows[0];
    if (row.claimed_at) throw Object.assign(new Error('ALREADY_CLAIMED'), { status: 409 });
    if (!row.completed_at) throw Object.assign(new Error('NOT_COMPLETED'), { status: 400 });

    await c.query(`UPDATE user_missions SET claimed_at=NOW() WHERE id=$1`, [row.id]);

    if (Number(row.reward_usdt) > 0) {
      await c.query(
        `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
         VALUES ($1,'mission_reward',$2,'confirmed',$3,FALSE)`,
        [userId, row.reward_usdt, JSON.stringify({ mission_title: row.title })]);
    }
    if (row.reward_xp > 0)
      await c.query(`UPDATE users SET xp=xp+$1 WHERE id=$2`, [row.reward_xp, userId]);

    await c.query(
      `INSERT INTO notifications (user_id,title,body,type,category)
       VALUES ($1,'Mission Claimed',$2,'success','mission')`,
      [userId, `${row.title}: +${row.reward_usdt} USDT + ${row.reward_xp} XP`]);

    return { reward_usdt: Number(row.reward_usdt), reward_xp: row.reward_xp };
  });
};

// =========================================================================
//  SECTION 11: MLM SERVICE
// =========================================================================
const activatePackage = async (p: {
  userId: string; package: 'p1_5'|'p2_10'|'p3_20'|'p4_50';
  txHash: string; fromAddress: string; amount: number;
}) => {
  return withTransaction(async (c) => {
    const dup = await c.query('SELECT 1 FROM subscriptions WHERE tx_hash=$1', [p.txHash]);
    if (dup.rowCount) throw Object.assign(new Error('TX_ALREADY_USED'), { status: 409 });

    const u = await lockUser(c, p.userId);
    const rates = await getPackageRates();
    const cfg = rates[p.package];
    if (!cfg) throw Object.assign(new Error('INVALID_PACKAGE'), { status: 400 });
    if (Math.abs(cfg.price - p.amount) > 0.01)
      throw Object.assign(new Error('AMOUNT_MISMATCH'), { status: 400 });

    const isUpgrade = u.package !== 'none' && u.package !== p.package;
    const prevPkg = u.package;

    const sub = await c.query(
      `INSERT INTO subscriptions
         (user_id,package,amount_usdt,tx_hash,from_address,to_address,
          chain_id,is_upgrade,previous_pkg,confirmed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)
       RETURNING id`,
      [p.userId, p.package, p.amount, p.txHash, p.fromAddress,
       ENV.PLATFORM_WALLET, ENV.CHAIN_ID, isUpgrade, prevPkg]);
    const subId = sub.rows[0].id;

    await c.query(
      `UPDATE users SET package=$1, status='active',
                        total_deposited=total_deposited+$2
       WHERE id=$3`,
      [p.package, p.amount, p.userId]);

    await c.query(
      `INSERT INTO transactions (user_id,type,amount_usdt,status,tx_hash,reference_id,meta,is_demo)
       VALUES ($1,'deposit',$2,'confirmed',$3,$4,$5,FALSE)`,
      [p.userId, p.amount, p.txHash, subId,
       JSON.stringify({ purpose: 'package_purchase', package: p.package, is_upgrade: isUpgrade })]);

    if (u.referred_by) {
      const l1Snap = rates[u.referrer_pkg_snapshot] || rates.none;
      const l1Amount = +(p.amount * l1Snap.l1).toFixed(8);
      if (l1Amount > 0) {
        await c.query(
          `INSERT INTO referral_commissions
             (earner_id,source_user_id,subscription_id,kind,level,rate,base_amount,amount_usdt)
           VALUES ($1,$2,$3,'subscription',1,$4,$5,$6)`,
          [u.referred_by, p.userId, subId, l1Snap.l1, p.amount, l1Amount]);
        await c.query(
          `INSERT INTO transactions (user_id,type,amount_usdt,status,reference_id,meta,is_demo)
           VALUES ($1,'referral_l1',$2,'confirmed',$3,$4,FALSE)`,
          [u.referred_by, l1Amount, subId,
           JSON.stringify({ from_user: p.userId, package: p.package, rate: l1Snap.l1 })]);
        await c.query(
          `UPDATE users SET active_ref_count=active_ref_count+1 WHERE id=$1`,
          [u.referred_by]);
        await c.query(
          `INSERT INTO notifications (user_id,title,body,type,category)
           VALUES ($1,'New L1 Referral',$2,'success','referral')`,
          [u.referred_by, `You earned ${l1Amount} USDT`]);
      }

      const ref2 = await c.query('SELECT referred_by FROM users WHERE id=$1', [u.referred_by]);
      const l2User = ref2.rows[0]?.referred_by;
      if (l2User) {
        const l2Rate = 0.05;
        const l2Amount = +(p.amount * l2Rate).toFixed(8);
        if (l2Amount > 0) {
          await c.query(
            `INSERT INTO referral_commissions
               (earner_id,source_user_id,subscription_id,kind,level,rate,base_amount,amount_usdt)
             VALUES ($1,$2,$3,'subscription',2,$4,$5,$6)`,
            [l2User, p.userId, subId, l2Rate, p.amount, l2Amount]);
          await c.query(
            `INSERT INTO transactions (user_id,type,amount_usdt,status,reference_id,meta,is_demo)
             VALUES ($1,'referral_l2',$2,'confirmed',$3,$4,FALSE)`,
            [l2User, l2Amount, subId,
             JSON.stringify({ from_user: p.userId, level: 2, package: p.package })]);
          await c.query(
            `INSERT INTO notifications (user_id,title,body,type,category)
             VALUES ($1,'New L2 Referral',$2,'success','referral')`,
            [l2User, `You earned ${l2Amount} USDT`]);
        }
      }
    }

    await c.query(
      `INSERT INTO notifications (user_id,title,body,type,category)
       VALUES ($1,'Package Activated',$2,'success','package')`,
      [p.userId, `${p.package} active. Your referral link is live!`]);

    logger.info({ userId: p.userId, pkg: p.package, isUpgrade }, '✅ Package activated');
    return { subscriptionId: subId, isUpgrade, previousPackage: prevPkg };
  });
};

const distributeActivityCommission = async (
  c: PoolClient, bettorId: string, houseEdgeRevenue: number
) => {
  if (houseEdgeRevenue <= 0) return;
  const r = await c.query(
    `SELECT referred_by, referrer_activity_pct FROM users WHERE id=$1`, [bettorId]);
  const referrerId = r.rows[0]?.referred_by;
  const pct = Number(r.rows[0]?.referrer_activity_pct || 0);
  if (!referrerId || pct <= 0) return;
  const amount = +(houseEdgeRevenue * pct).toFixed(8);
  if (amount <= 0) return;
  await c.query(
    `INSERT INTO referral_commissions
       (earner_id,source_user_id,kind,level,rate,base_amount,amount_usdt)
     VALUES ($1,$2,'activity',1,$3,$4,$5)`,
    [referrerId, bettorId, pct, houseEdgeRevenue, amount]);
  await c.query(
    `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
     VALUES ($1,'referral_activity',$2,'confirmed',$3,FALSE)`,
    [referrerId, amount, JSON.stringify({ from_user: bettorId, base: houseEdgeRevenue })]);
};

// =========================================================================
//  JACKPOT POOLS (Progressive)
// =========================================================================
const getGamePool = async (game: string): Promise<number> => {
  const r = await query(`SELECT current_pool FROM game_pools WHERE game = $1`, [game]);
  return Number(r.rows[0]?.current_pool || 0);
};

const contributeToPool = async (c: PoolClient, game: string, amount: number) => {
  if (amount <= 0) return;
  await c.query(
    `UPDATE game_pools
     SET current_pool = current_pool + $1,
         total_contributed = total_contributed + $1,
         updated_at = NOW()
     WHERE game = $2`,
    [amount, game]
  );
};

const claimJackpot = async (c: PoolClient, game: string): Promise<number> => {
  const r = await c.query(`SELECT current_pool FROM game_pools WHERE game = $1 FOR UPDATE`, [game]);
  const pool = Number(r.rows[0]?.current_pool || 0);
  if (pool <= 0) return 0;
  await c.query(
    `UPDATE game_pools
     SET current_pool = 0,
         total_paid_out = total_paid_out + $1,
         updated_at = NOW()
     WHERE game = $2`,
    [pool, game]
  );
  return pool;
};

const getGameLimit = async (game: string) => {
  const r = await query(`SELECT * FROM game_limits WHERE game = $1`, [game]);
  return r.rows[0] || { min_bet: 0.5, max_bet: 100, jackpot_pct: 0.02 };
};

// =========================================================================
//  SECTION 12: SEED MANAGEMENT
// =========================================================================
const getOrCreateSeed = async (c: PoolClient, uid: string) => {
  let r = await c.query(
    `SELECT id,server_seed,server_seed_hash,client_seed,nonce
     FROM user_seeds WHERE user_id=$1 AND is_active=TRUE FOR UPDATE`, [uid]);
  if (!r.rowCount) {
    const ss = randHex(32), ssh = sha256(ss), cs = randHex(8);
    r = await c.query(
      `INSERT INTO user_seeds (user_id,server_seed,server_seed_hash,client_seed,nonce)
       VALUES ($1,$2,$3,$4,0)
       RETURNING id,server_seed,server_seed_hash,client_seed,nonce`,
      [uid, ss, ssh, cs]);
  }
  return r.rows[0];
};

// =========================================================================
//  SECTION 13: DICE (Real + Demo) — with jackpot contribution
// =========================================================================
const rollDice = async (p: {
  userId: string; betAmount: number; target: number;
  condition: 'over'|'under'; isDemo: boolean;
}) => {
  const games = await getGamesEnabled();
  if (!games.dice) throw Object.assign(new Error('GAME_DISABLED'), { status: 403 });
  if (!['over','under'].includes(p.condition))
    throw Object.assign(new Error('INVALID_CONDITION'), { status: 400 });
  if (p.target < 0.01 || p.target > 95.99)
    throw Object.assign(new Error('TARGET_OUT_OF_RANGE'), { status: 400 });
  if (p.betAmount <= 0)
    throw Object.assign(new Error('INVALID_BET_AMOUNT'), { status: 400 });

  return withTransaction(async (c) => {
    const u = await lockUser(c, p.userId);
    if (u.status === 'banned') throw Object.assign(new Error('ACCOUNT_BANNED'), { status: 403 });

    const houseEdge = await getHouseEdge(u.package, 'dice', p.isDemo);
    const winChance = p.condition === 'over' ? 100 - p.target : p.target;
    const multiplier = +((100 / winChance) * (1 - houseEdge)).toFixed(6);
    const payout = +(p.betAmount * multiplier).toFixed(8);

    const seed = await getOrCreateSeed(c, p.userId);
    const nextNonce = Number(seed.nonce) + 1;
    const roll = computeRoll(seed.server_seed, seed.client_seed, nextNonce);
    const isWin = p.condition === 'over' ? roll > p.target : roll < p.target;
    const winAmount = isWin ? payout : 0;
    const profit = isWin ? +(payout - p.betAmount).toFixed(8) : -p.betAmount;

    await c.query(`UPDATE user_seeds SET nonce=$1 WHERE id=$2`, [nextNonce, seed.id]);

    if (p.isDemo) {
      const newDemo = Number(u.demo_balance) - p.betAmount + winAmount;
      if (newDemo < 0)
        throw Object.assign(new Error('INSUFFICIENT_DEMO_BALANCE'), { status: 400 });
      await c.query(`UPDATE users SET demo_balance=$1 WHERE id=$2`, [newDemo, p.userId]);
    } else {
      if (Number(u.balance) < p.betAmount)
        throw Object.assign(new Error('INSUFFICIENT_BALANCE'), { status: 400 });

      await c.query(
        `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
         VALUES ($1,'bet_loss',$2,'confirmed',$3,FALSE)`,
        [p.userId, p.betAmount, JSON.stringify({ game:'dice', roll })]);
      if (isWin && winAmount > 0) {
        await c.query(
          `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
           VALUES ($1,'bet_win',$2,'confirmed',$3,FALSE)`,
          [p.userId, winAmount, JSON.stringify({ game:'dice', roll })]);
      }
      await c.query(`UPDATE users SET total_wagered=total_wagered+$1, xp=xp+1 WHERE id=$2`,
        [p.betAmount, p.userId]);
      const heRev = +(p.betAmount * houseEdge).toFixed(8);
      await distributeActivityCommission(c, p.userId, heRev);
      const diceLimit = await getGameLimit('dice');
      const diceJC = +(p.betAmount * Number(diceLimit.jackpot_pct || 0.02)).toFixed(8);
      if (diceJC > 0) await contributeToPool(c, 'dice', diceJC);
      await progressMission(c, p.userId, 'bets_count', 1);
      await progressMission(c, p.userId, 'wager_amount', p.betAmount);

      if (isWin && winAmount >= 5) {
        await c.query(
          `INSERT INTO notifications (user_id,title,body,type,category)
           VALUES ($1,'🎉 Big Win!',$2,'success','win')`,
          [p.userId, `You won ${winAmount} USDT on Dice!`]);
      }
    }

    const bet = await c.query(
      `INSERT INTO casino_bets
         (user_id,game,bet_amount,payout,house_edge,status,server_seed_hash,
          client_seed,nonce,result_value,payload,settled_at,is_demo)
       VALUES ($1,'dice',$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11)
       RETURNING id`,
      [p.userId, p.betAmount, winAmount, houseEdge,
       isWin ? 'won' : 'lost', seed.server_seed_hash, seed.client_seed, nextNonce,
       roll, JSON.stringify({ target: p.target, condition: p.condition, winChance, multiplier }),
       p.isDemo]);

    const bal = await c.query(
      `SELECT balance, demo_balance FROM users WHERE id=$1`, [p.userId]);

    return {
      betId: bet.rows[0].id, roll, target: p.target, condition: p.condition,
      isWin, winChance, multiplier, houseEdge, betAmount: p.betAmount,
      payout: winAmount, profit,
      newBalance: p.isDemo ? Number(bal.rows[0].demo_balance) : Number(bal.rows[0].balance),
      isDemo: p.isDemo,
    };
  });
};

// =========================================================================
//  SECTION 14: MYSTERY BOXES (Real + Demo) — with jackpot contribution
// =========================================================================
const openBox = async (userId: string, boxId: string, isDemo: boolean) => withTransaction(async (c) => {
  const games = await getGamesEnabled();
  if (!games.boxes) throw Object.assign(new Error('GAME_DISABLED'), { status: 403 });
  const b = await c.query('SELECT * FROM mystery_boxes WHERE id=$1 AND is_active=TRUE', [boxId]);
  if (!b.rowCount) throw Object.assign(new Error('BOX_NOT_FOUND'), { status: 404 });
  const box = b.rows[0];
  const u = await lockUser(c, userId);
  const price = Number(box.price_usdt);
  if (u.status === 'banned') throw Object.assign(new Error('ACCOUNT_BANNED'), { status: 403 });

  const limit = await getGameLimit('boxes');
  if (price < Number(limit.min_bet) || price > Number(limit.max_bet))
    throw Object.assign(new Error('BET_OUT_OF_RANGE'), { status: 400 });

  const houseEdge = await getHouseEdge(u.package, 'boxes', isDemo);

  if (isDemo) {
    if (Number(u.demo_balance) < price)
      throw Object.assign(new Error('INSUFFICIENT_DEMO_BALANCE'), { status: 400 });
  } else {
    if (Number(u.balance) < price)
      throw Object.assign(new Error('INSUFFICIENT_BALANCE'), { status: 400 });
  }

  const outcome = pickWeighted(box.odds);
  const isJackpotOutcome = outcome.isJackpot === true;

  let prizeAmount = 0;
  if (isJackpotOutcome) {
    prizeAmount = await claimJackpot(c, 'boxes');
    if (prizeAmount <= 0) prizeAmount = +(price * 5).toFixed(8);
  } else {
    prizeAmount = +(price * Number(outcome.payout)).toFixed(8);
  }
  const isWin = prizeAmount > 0;

  if (isDemo) {
    const newDemo = Number(u.demo_balance) - price + prizeAmount;
    if (newDemo < 0) throw Object.assign(new Error('INSUFFICIENT_DEMO_BALANCE'), { status: 400 });
    await c.query(`UPDATE users SET demo_balance=$1 WHERE id=$2`, [newDemo, userId]);
  } else {
    await c.query(
      `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
       VALUES ($1,'bet_loss',$2,'confirmed',$3,FALSE)`,
      [userId, price, JSON.stringify({ game:'mystery_box', box: box.name })]);
    if (isWin) {
      await c.query(
        `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
         VALUES ($1,'bet_win',$2,'confirmed',$3,FALSE)`,
        [userId, prizeAmount, JSON.stringify({ game:'mystery_box', label: outcome.label })]);
    }
    await c.query(`UPDATE users SET total_wagered=total_wagered+$1, xp=xp+1 WHERE id=$2`, [price, userId]);
    await distributeActivityCommission(c, userId, +(price * houseEdge).toFixed(8));
    const boxLimit = await getGameLimit('boxes');
    const boxJC = +(price * Number(boxLimit.jackpot_pct || 0.05)).toFixed(8);
    if (boxJC > 0) await contributeToPool(c, 'boxes', boxJC);
    await progressMission(c, userId, 'bets_count', 1);
    await progressMission(c, userId, 'wager_amount', price);

    if (isWin && prizeAmount >= 5) {
      await c.query(
        `INSERT INTO notifications (user_id,title,body,type,category)
         VALUES ($1,'🎉 Box Winner!',$2,'success','win')`,
        [userId, `You won ${prizeAmount} USDT from ${box.name}!`]);
    }
  }

  const bet = await c.query(
    `INSERT INTO casino_bets
       (user_id,game,bet_amount,payout,house_edge,status,server_seed_hash,
        client_seed,nonce,result_value,payload,settled_at,is_demo)
     VALUES ($1,'mystery_box',$2,$3,$4,$5,'n/a','n/a',0,$6,$7,NOW(),$8)
     RETURNING id`,
    [userId, price, prizeAmount, houseEdge, isWin ? 'won' : 'lost',
     prizeAmount, JSON.stringify({ label: outcome.label, isJackpot: isJackpotOutcome }), isDemo]);

  await c.query(
    `INSERT INTO mystery_box_purchases
       (user_id,box_id,bet_id,paid_amount,prize_label,prize_amount)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, boxId, bet.rows[0].id, price, outcome.label, prizeAmount]);

  const bal = await c.query(`SELECT balance, demo_balance FROM users WHERE id=$1`, [userId]);
  const poolNow = await getGamePool('boxes');
  return {
    boxId, boxName: box.name, paid: price, outcome: outcome.label,
    payoutMultiplier: outcome.payout, prizeAmount, isWin, isJackpot: isJackpotOutcome,
    profit: +(prizeAmount - price).toFixed(8),
    newBalance: isDemo ? Number(bal.rows[0].demo_balance) : Number(bal.rows[0].balance),
    currentPool: poolNow,
    isDemo,
  };
});

// =========================================================================
//  SECTION 15: PREDICTION
// =========================================================================
const fetchBinancePrice = async (symbol: string): Promise<number> => {
  const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
  if (!r.ok) throw new Error(`BINANCE_${r.status}`);
  const j: any = await r.json();
  return Number(j.price);
};

const placePredictionBet = async (userId: string, marketId: string, side: 'up'|'down', amount: number) => {
  const games = await getGamesEnabled();
  if (!games.prediction) throw Object.assign(new Error('GAME_DISABLED'), { status: 403 });
  if (!['up','down'].includes(side)) throw Object.assign(new Error('INVALID_SIDE'), { status: 400 });
  if (amount <= 0) throw Object.assign(new Error('INVALID_AMOUNT'), { status: 400 });

  return withTransaction(async (c) => {
    const m = await c.query('SELECT * FROM prediction_markets WHERE id=$1 FOR UPDATE', [marketId]);
    if (!m.rowCount) throw Object.assign(new Error('MARKET_NOT_FOUND'), { status: 404 });
    const market = m.rows[0];
    if (market.status !== 'open') throw Object.assign(new Error('MARKET_NOT_OPEN'), { status: 400 });
    if (new Date(market.closes_at) <= new Date())
      throw Object.assign(new Error('MARKET_CLOSED'), { status: 400 });

    const u = await lockUser(c, userId);
    if (u.status === 'banned') throw Object.assign(new Error('ACCOUNT_BANNED'), { status: 403 });
    if (Number(u.balance) < amount)
      throw Object.assign(new Error('INSUFFICIENT_BALANCE'), { status: 400 });

    await c.query(
      `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
       VALUES ($1,'bet_loss',$2,'confirmed',$3,FALSE)`,
      [userId, amount, JSON.stringify({ game:'prediction', marketId, side })]);

    await c.query(
      `INSERT INTO prediction_bets (market_id,user_id,side,amount)
       VALUES ($1,$2,$3,$4)`,
      [marketId, userId, side, amount]);

    await c.query(`UPDATE users SET total_wagered=total_wagered+$1, xp=xp+1 WHERE id=$2`,
      [amount, userId]);
    await progressMission(c, userId, 'bets_count', 1);
    await progressMission(c, userId, 'wager_amount', amount);

    return { marketId, side, amount };
  });
};

const settleMarket = async (marketId: string) => {
  const m0 = await query('SELECT * FROM prediction_markets WHERE id=$1', [marketId]);
  if (!m0.rowCount) throw Object.assign(new Error('MARKET_NOT_FOUND'), { status: 404 });
  if (m0.rows[0].status === 'settled') return m0.rows[0];
  const closePrice = await fetchBinancePrice(m0.rows[0].symbol);

  return withTransaction(async (c) => {
    const m = await c.query('SELECT * FROM prediction_markets WHERE id=$1 FOR UPDATE', [marketId]);
    const market = m.rows[0];
    if (market.status === 'settled')
      throw Object.assign(new Error('ALREADY_SETTLED'), { status: 400 });

    const openPrice = Number(market.open_price);
    const winningSide = closePrice > openPrice ? 'up' : closePrice < openPrice ? 'down' : 'draw';
    const bets = await c.query(
      `SELECT * FROM prediction_bets WHERE market_id=$1 AND status='pending'`, [marketId]);

    if (winningSide === 'draw') {
      for (const b of bets.rows) {
        await c.query(
          `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
           VALUES ($1,'bet_win',$2,'confirmed',$3,FALSE)`,
          [b.user_id, b.amount, JSON.stringify({ refund: true, marketId })]);
        await c.query(`UPDATE prediction_bets SET status='refunded', payout=amount WHERE id=$1`, [b.id]);
      }
    } else {
      const totalWin = winningSide === 'up' ? Number(market.total_up) : Number(market.total_down);
      const totalLose = winningSide === 'up' ? Number(market.total_down) : Number(market.total_up);
      const rake = Number(market.house_edge);
      const netPool = totalLose * (1 - rake);
      const platformRevenue = +(totalLose * rake).toFixed(8);

      if (platformRevenue > 0) {
        await c.query(
          `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
           VALUES ((SELECT id FROM users WHERE email=$1),'platform_fee',$2,'confirmed',$3,FALSE)`,
          [ENV.ADMIN_EMAIL, platformRevenue,
           JSON.stringify({ marketId, kind: 'prediction_rake' })]);
      }

      for (const b of bets.rows) {
        if (b.side === winningSide && totalWin > 0) {
          const share = (Number(b.amount) / totalWin) * netPool;
          const payout = +(Number(b.amount) + share).toFixed(8);
          await c.query(
            `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
             VALUES ($1,'bet_win',$2,'confirmed',$3,FALSE)`,
            [b.user_id, payout, JSON.stringify({ marketId, side:'won' })]);
          await c.query(`UPDATE prediction_bets SET status='won', payout=$1 WHERE id=$2`,
            [payout, b.id]);
          await c.query(
            `INSERT INTO notifications (user_id,title,body,type,category)
             VALUES ($1,'Prediction Won',$2,'success','win')`,
            [b.user_id, `You won ${payout} USDT on ${market.symbol}`]);
        } else {
          await c.query(`UPDATE prediction_bets SET status='lost' WHERE id=$1`, [b.id]);
        }
      }
    }

    const r = await c.query(
      `UPDATE prediction_markets SET status='settled', close_price=$1, settled_at=NOW()
       WHERE id=$2 RETURNING *`,
      [closePrice, marketId]);
    logger.info({ marketId, winningSide, openPrice, closePrice }, '📊 Market settled');
    return r.rows[0];
  });
};

const settleExpiredMarkets = async () => {
  const r = await query(
    `SELECT id FROM prediction_markets WHERE status='open' AND closes_at <= NOW() LIMIT 20`);
  for (const row of r.rows) {
    try { await settleMarket(row.id); }
    catch (e) { logger.error({ e, marketId: row.id }, 'settleMarket failed'); }
  }
  return r.rowCount;
};

// =========================================================================
//  SECTION 16: BONUS WHEEL — Betting version with jackpot
// =========================================================================
const spinWheel = async (userId: string, betAmount: number, useFreeSpin: boolean, isDemo: boolean = false) => withTransaction(async (c) => {
  const games = await getGamesEnabled();
  if (!games.bonus_wheel) throw Object.assign(new Error('GAME_DISABLED'), { status: 403 });

  const u = await lockUser(c, userId);
  if (u.status === 'banned') throw Object.assign(new Error('ACCOUNT_BANNED'), { status: 403 });

  const cfg = await getSetting('bonus_wheel');
  const limit = await getGameLimit('wheel');

  if (useFreeSpin) {
    const cooldownMs = cfg.cooldown_hours * 3600 * 1000;
    if (u.last_bonus_spin && Date.now() - new Date(u.last_bonus_spin).getTime() < cooldownMs) {
      const nextAt = new Date(new Date(u.last_bonus_spin).getTime() + cooldownMs);
      throw Object.assign(new Error('COOLDOWN_ACTIVE'), { status: 429, nextAt });
    }
    betAmount = cfg.free_spin_value || 1;
  } else {
    if (betAmount < cfg.min_bet || betAmount > cfg.max_bet) {
      throw Object.assign(new Error('BET_OUT_OF_RANGE'), { status: 400, min: cfg.min_bet, max: cfg.max_bet });
    }
    if (isDemo) {
      if (Number(u.demo_balance) < betAmount) {
        throw Object.assign(new Error('INSUFFICIENT_DEMO_BALANCE'), { status: 400 });
      }
    } else {
      if (Number(u.balance) < betAmount) {
        throw Object.assign(new Error('INSUFFICIENT_BALANCE'), { status: 400 });
      }
    }
  }

  const picked = pickWeighted(cfg.segments);
  const idx = cfg.segments.indexOf(picked);
  const isJackpot = picked.isJackpot === true;

  let prize = 0;
  if (isJackpot) {
    prize = await claimJackpot(c, 'wheel');
    if (prize <= 0) prize = +(betAmount * 5).toFixed(8);
  } else {
    prize = +(betAmount * Number(picked.multiplier)).toFixed(8);
  }

  if (useFreeSpin) {
    if (prize > 0) {
      await c.query(
        `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
         VALUES ($1,'bet_win',$2,'confirmed',$3,FALSE)`,
        [userId, prize, JSON.stringify({ game: 'bonus_wheel', free: true, label: picked.label })]);
    }
  } else if (!isDemo) {
    await c.query(
      `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
       VALUES ($1,'bet_loss',$2,'confirmed',$3,FALSE)`,
      [userId, betAmount, JSON.stringify({ game:'bonus_wheel', label: picked.label })]);
    if (prize > 0) {
      await c.query(
        `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
         VALUES ($1,'bet_win',$2,'confirmed',$3,FALSE)`,
        [userId, prize, JSON.stringify({ game:'bonus_wheel', label: picked.label })]);
    }
    const jc = +(betAmount * Number(limit.jackpot_pct || 0.03)).toFixed(8);
    if (jc > 0) await contributeToPool(c, 'wheel', jc);
  }

  let txId: string | null = null;
  if (prize > 0) {
    const tx = await c.query(`SELECT id FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [userId]);
    txId = tx.rows[0]?.id || null;
  }

  await c.query(
    `INSERT INTO bonus_wheel_spins (user_id,segment_index,prize_amount,tx_id)
     VALUES ($1,$2,$3,$4)`,
    [userId, idx, prize, txId]);

  if (isDemo && !useFreeSpin) {
    // Demo mode: update demo_balance directly
    const newDemoBal = Number(u.demo_balance) - betAmount + prize;
    if (newDemoBal < 0) throw Object.assign(new Error('INSUFFICIENT_DEMO_BALANCE'), { status: 400 });
    await c.query(`UPDATE users SET demo_balance=$1 WHERE id=$2`, [newDemoBal, userId]);
  } else if (useFreeSpin) {
    await c.query(`UPDATE users SET last_bonus_spin=NOW() WHERE id=$1`, [userId]);
  } else {
    await c.query(`UPDATE users SET total_wagered=total_wagered+$1, xp=xp+1 WHERE id=$2`, [betAmount, userId]);
    await progressMission(c, userId, 'bets_count', 1);
    await progressMission(c, userId, 'wager_amount', betAmount);
  }

  const bal = await c.query('SELECT balance, demo_balance FROM users WHERE id=$1', [userId]);
  const poolNow = await getGamePool('wheel');

  return {
    segmentIndex: idx, label: picked.label, multiplier: picked.multiplier,
    betAmount, prize, isJackpot, isFreeSpin: useFreeSpin,
    newBalance: isDemo ? Number(bal.rows[0].demo_balance) : Number(bal.rows[0].balance),
    currentPool: poolNow,
    nextSpinAt: useFreeSpin ? new Date(Date.now() + (cfg.cooldown_hours * 3600 * 1000)).toISOString() : null,
  };
});

// =========================================================================
//  SECTION 17: WITHDRAW SERVICE
// =========================================================================
const calcWithdrawFee = (amount: number, cfg: { pct: number; min: number; max: number }) => {
  const fee = Math.min(Math.max(amount * cfg.pct, cfg.min), cfg.max);
  return +fee.toFixed(8);
};

const createWithdraw = async (userId: string, amount: number, walletAddress?: string) => {
  if (!Number.isFinite(amount) || amount <= 0)
    throw Object.assign(new Error('INVALID_AMOUNT'), { status: 400 });

  return withTransaction(async (c) => {
    const u = await lockUser(c, userId);
    if (u.status === 'banned') throw Object.assign(new Error('ACCOUNT_BANNED'), { status: 403 });
    if (Number(u.balance) < 10)
      throw Object.assign(new Error('MIN_BALANCE_NOT_MET'), { status: 400 });
    if (u.active_ref_count < 3)
      throw Object.assign(new Error('MIN_ACTIVE_REFS_NOT_MET'), { status: 400 });
    if (amount > Number(u.balance))
      throw Object.assign(new Error('AMOUNT_EXCEEDS_BALANCE'), { status: 400 });

    const limits = await getWithdrawalLimits();
    const today = new Date().toISOString().slice(0, 10);
    const thisMonth = new Date().toISOString().slice(0, 7);
    const dailyUsed = u.daily_withdrawn_date === today ? Number(u.daily_withdrawn_total) : 0;
    const monthlyUsed = u.monthly_withdrawn_month === thisMonth ? Number(u.monthly_withdrawn_total) : 0;

    if (dailyUsed + amount > Number(limits.daily_max))
      throw Object.assign(new Error('DAILY_LIMIT_EXCEEDED'), {
        status: 400, daily_max: limits.daily_max, used: dailyUsed });
    if (monthlyUsed + amount > Number(limits.monthly_max))
      throw Object.assign(new Error('MONTHLY_LIMIT_EXCEEDED'), {
        status: 400, monthly_max: limits.monthly_max, used: monthlyUsed });

    const w = walletAddress || u.wallet_address;
    if (!w || !ethers.isAddress(w))
      throw Object.assign(new Error('INVALID_WALLET'), { status: 400 });

    const pending = await c.query(
      `SELECT 1 FROM transactions WHERE user_id=$1 AND type='withdrawal'
       AND status='pending' LIMIT 1 FOR UPDATE`, [userId]);
    if (pending.rowCount)
      throw Object.assign(new Error('PENDING_WITHDRAWAL_EXISTS'), { status: 409 });

    if (walletAddress && walletAddress !== u.wallet_address) {
      await c.query('UPDATE users SET wallet_address=$1 WHERE id=$2', [walletAddress, userId]);
    }

    const feeCfg = await getWithdrawalFee();
    const fee = calcWithdrawFee(amount, feeCfg);

    const tx = await c.query(
      `INSERT INTO transactions
         (user_id,type,amount_usdt,fee_usdt,status,to_address,meta,is_demo)
       VALUES ($1,'withdrawal',$2,$3,'pending',$4,$5,FALSE)
       RETURNING id,amount_usdt,fee_usdt,status,created_at`,
      [userId, amount, fee, w, JSON.stringify({ wallet: w, fee_applied: fee })]);

    await c.query(
      `UPDATE users SET
         daily_withdrawn_total = CASE WHEN daily_withdrawn_date=$1 THEN daily_withdrawn_total + $2 ELSE $2 END,
         daily_withdrawn_date  = $1,
         monthly_withdrawn_total = CASE WHEN monthly_withdrawn_month=$3 THEN monthly_withdrawn_total + $2 ELSE $2 END,
         monthly_withdrawn_month = $3
       WHERE id=$4`,
      [today, amount, thisMonth, userId]);

    return tx.rows[0];
  });
};

const cancelWithdraw = async (userId: string, txId: string) => {
  return withTransaction(async (c) => {
    const t = await c.query(
      `SELECT * FROM transactions WHERE id=$1 AND user_id=$2 AND type='withdrawal' FOR UPDATE`,
      [txId, userId]);
    if (!t.rowCount) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
    const tx = t.rows[0];
    if (tx.status !== 'pending') throw Object.assign(new Error('CANNOT_CANCEL'), { status: 400 });

    await c.query(
      `UPDATE transactions SET status='rejected', admin_note='Cancelled by user' WHERE id=$1`,
      [txId]);
    await c.query(
      `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
       VALUES ($1,'bet_win',$2,'confirmed',$3,FALSE)`,
      [userId, tx.amount_usdt,
       JSON.stringify({ refund: 'user_cancelled', original_tx: txId })]);

    const today = new Date().toISOString().slice(0, 10);
    const thisMonth = new Date().toISOString().slice(0, 7);
    await c.query(
      `UPDATE users SET
         daily_withdrawn_total = CASE WHEN daily_withdrawn_date=$1 THEN GREATEST(daily_withdrawn_total - $2, 0) ELSE daily_withdrawn_total END,
         monthly_withdrawn_total = CASE WHEN monthly_withdrawn_month=$3 THEN GREATEST(monthly_withdrawn_total - $2, 0) ELSE monthly_withdrawn_total END
       WHERE id=$4`,
      [today, tx.amount_usdt, thisMonth, userId]);

    return { cancelled: true, refunded: Number(tx.amount_usdt) };
  });
};

// =========================================================================
//  SECTION 18: DEPOSITS
// =========================================================================
const createDepositIntent = async (userId: string, txHash: string) => {
  return withTransaction(async (c) => {
    const existing = await c.query('SELECT * FROM deposits WHERE tx_hash=$1 FOR UPDATE', [txHash]);
    if (existing.rowCount) return existing.rows[0];

    const r = await c.query(
      `INSERT INTO deposits (user_id,tx_hash,status,chain_id)
       VALUES ($1,$2,'pending',$3) RETURNING *`,
      [userId, txHash, ENV.CHAIN_ID]);

    const v = await verifyUsdtPayment(txHash);
    if (!v.success) {
      await c.query(
        `UPDATE deposits SET status='rejected', error_reason=$1 WHERE id=$2`,
        [v.reason || 'UNKNOWN', r.rows[0].id]);
      return { ...r.rows[0], status: 'rejected', error_reason: v.reason };
    }
    const d = v.details!;
    const newStatus = v.isFinal ? 'confirmed' : 'confirming';
    await c.query(
      `UPDATE deposits
         SET from_address=$1, to_address=$2, amount_usdt=$3, confirmations=$4,
             block_number=$5, status=$6, confirmed_at=$7, raw_meta=$8
       WHERE id=$9`,
      [d.from, d.to, d.amount, d.confirmations, d.blockNumber, newStatus,
       v.isFinal ? new Date() : null, JSON.stringify(d), r.rows[0].id]);

    if (v.isFinal) {
      await c.query(
        `INSERT INTO transactions
           (user_id,type,amount_usdt,status,tx_hash,from_address,to_address,meta,is_demo)
         VALUES ($1,'deposit',$2,'confirmed',$3,$4,$5,$6,FALSE)
         ON CONFLICT (tx_hash) DO NOTHING`,
        [userId, d.amount, txHash, d.from, d.to,
         JSON.stringify({ blockNumber: d.blockNumber, confirmations: d.confirmations,
                          source: 'deposit_intent' })]);
      await c.query(
        `INSERT INTO notifications (user_id,title,body,type,category)
         VALUES ($1,'Deposit Confirmed',$2,'success','deposit')`,
        [userId, `${d.amount} USDT credited to your account.`]);
    }

    const fresh = await c.query('SELECT * FROM deposits WHERE id=$1', [r.rows[0].id]);
    return fresh.rows[0];
  });
};

const refreshPendingDeposits = async () => {
  const r = await query(
    `SELECT id,user_id,tx_hash FROM deposits
     WHERE status IN ('pending','confirming') LIMIT 30`);
  for (const d of r.rows) {
    try {
      const v = await verifyUsdtPayment(d.tx_hash);
      if (!v.success) continue;
      const det = v.details!;
      const newStatus = v.isFinal ? 'confirmed' : 'confirming';
      await query(
        `UPDATE deposits
           SET amount_usdt=$1, confirmations=$2, block_number=$3, status=$4,
               confirmed_at=$5, from_address=$6, to_address=$7
         WHERE id=$8`,
        [det.amount, det.confirmations, det.blockNumber, newStatus,
         v.isFinal ? new Date() : null, det.from, det.to, d.id]);

      if (v.isFinal) {
        await query(
          `INSERT INTO transactions
             (user_id,type,amount_usdt,status,tx_hash,from_address,to_address,meta,is_demo)
           VALUES ($1,'deposit',$2,'confirmed',$3,$4,$5,$6,FALSE)
           ON CONFLICT (tx_hash) DO NOTHING`,
          [d.user_id, det.amount, d.tx_hash, det.from, det.to,
           JSON.stringify({ confirmations: det.confirmations, source: 'deposit_refresh' })]);
        await query(
          `INSERT INTO notifications (user_id,title,body,type,category)
           VALUES ($1,'Deposit Confirmed',$2,'success','deposit')`,
          [d.user_id, `${det.amount} USDT credited.`]);
      }
    } catch (e) { logger.error({ e, depositId: d.id }, 'refresh deposit failed'); }
  }
  return r.rowCount;
};

// =========================================================================
//  SECTION 19: WEEKLY LOTTERY (Admin-controlled)
// =========================================================================
const getOrCreateCurrentRound = async (): Promise<any> => {
  const existing = await query(
    `SELECT * FROM weekly_lottery_rounds WHERE status='open'
     AND end_at > NOW() ORDER BY round_number DESC LIMIT 1`);
  if (existing.rowCount) return existing.rows[0];

  const last = await query(`SELECT COALESCE(MAX(round_number),0) AS n FROM weekly_lottery_rounds`);
  const nextN = Number(last.rows[0].n) + 1;
  const now = new Date();
  const nextMonday = new Date(now);
  const day = now.getUTCDay();
  const daysUntilMonday = (8 - day) % 7 || 7;
  nextMonday.setUTCDate(now.getUTCDate() + daysUntilMonday);
  nextMonday.setUTCHours(0, 0, 0, 0);

  const r = await query(
    `INSERT INTO weekly_lottery_rounds (round_number,start_at,end_at,ticket_price,is_admin_controlled)
     VALUES ($1,NOW(),$2,5,TRUE) RETURNING *`, [nextN, nextMonday]);
  return r.rows[0];
};

const buyLotteryTickets = async (userId: string, quantity: number) => {
  const games = await getGamesEnabled();
  if (!games.lottery) throw Object.assign(new Error('GAME_DISABLED'), { status: 403 });
  if (quantity < 1 || quantity > 50)
    throw Object.assign(new Error('INVALID_QUANTITY'), { status: 400 });

  return withTransaction(async (c) => {
    const round = await getOrCreateCurrentRound();
    const locked = await c.query(
      'SELECT * FROM weekly_lottery_rounds WHERE id=$1 FOR UPDATE', [round.id]);
    const r = locked.rows[0];
    if (r.status !== 'open') throw Object.assign(new Error('ROUND_CLOSED'), { status: 400 });

    const u = await lockUser(c, userId);
    if (u.status === 'banned') throw Object.assign(new Error('ACCOUNT_BANNED'), { status: 403 });

    const total = +(Number(r.ticket_price) * quantity).toFixed(8);
    if (Number(u.balance) < total)
      throw Object.assign(new Error('INSUFFICIENT_BALANCE'), { status: 400 });

    await c.query(
      `INSERT INTO transactions (user_id,type,amount_usdt,status,reference_id,meta,is_demo)
       VALUES ($1,'lottery_ticket',$2,'confirmed',$3,$4,FALSE)`,
      [userId, total, r.id, JSON.stringify({ quantity, round: r.round_number })]);

    const start = r.tickets_sold + 1;
    const nums = Array.from({ length: quantity }, (_, i) => start + i);
    const vals = nums.map((_, i) => `($1,$2,$${i + 3},$${quantity + 3})`).join(',');
    const params = [r.id, userId, ...nums, r.ticket_price];
    await c.query(
      `INSERT INTO weekly_lottery_tickets (round_id,user_id,ticket_number,paid_amount)
       VALUES ${vals}`, params);

    const newSold = r.tickets_sold + quantity;
    const newGross = +(Number(r.gross_pool) + total).toFixed(8);
    const cutPct = (await getLotteryCut()).pct;
    const platformCut = +(newGross * cutPct).toFixed(8);
    const prizePool = +(newGross - platformCut).toFixed(8);

    await c.query(
      `UPDATE weekly_lottery_rounds
         SET tickets_sold=$1, gross_pool=$2, prize_pool=$3, platform_cut=$4,
             total_sales=$2, current_prize_pool=$3
       WHERE id=$5`,
      [newSold, newGross, prizePool, platformCut, r.id]);

    return {
      roundId: r.id, roundNumber: r.round_number,
      ticketNumbers: nums, totalCost: total,
      ticketsSold: newSold, prizePool,
    };
  });
};

const drawWeeklyLottery = async (roundId: string) => {
  return withTransaction(async (c) => {
    const r0 = await c.query('SELECT * FROM weekly_lottery_rounds WHERE id=$1 FOR UPDATE', [roundId]);
    if (!r0.rowCount) throw Object.assign(new Error('ROUND_NOT_FOUND'), { status: 404 });
    const round = r0.rows[0];
    if (round.status !== 'open')
      throw Object.assign(new Error('ROUND_NOT_OPEN'), { status: 400 });
    if (round.tickets_sold === 0) {
      await c.query(
        `UPDATE weekly_lottery_rounds SET status='cancelled', drawn_at=NOW() WHERE id=$1`,
        [roundId]);
      return { cancelled: true };
    }

    await c.query(`UPDATE weekly_lottery_rounds SET status='drawing' WHERE id=$1`, [roundId]);

    const winningTicketNumber = randInt(1, round.tickets_sold + 1);
    const winner = await c.query(
      `SELECT user_id FROM weekly_lottery_tickets
       WHERE round_id=$1 AND ticket_number=$2`, [roundId, winningTicketNumber]);
    const winnerId = winner.rows[0].user_id;

    const prizePool = Number(round.prize_pool);
    await c.query(
      `INSERT INTO transactions (user_id,type,amount_usdt,status,reference_id,meta,is_demo)
       VALUES ($1,'lottery_win',$2,'confirmed',$3,$4,FALSE)`,
      [winnerId, prizePool, roundId,
       JSON.stringify({ round: round.round_number, ticket: winningTicketNumber })]);

    if (Number(round.platform_cut) > 0) {
      await c.query(
        `INSERT INTO transactions (user_id,type,amount_usdt,status,reference_id,meta,is_demo)
         VALUES ((SELECT id FROM users WHERE email=$1),'platform_fee',$2,'confirmed',$3,$4,FALSE)`,
        [ENV.ADMIN_EMAIL, round.platform_cut, roundId,
         JSON.stringify({ kind: 'lottery_cut', round: round.round_number })]);
    }

    await c.query(
      `UPDATE weekly_lottery_rounds
         SET status='completed', winner_id=$1, winning_ticket=$2, drawn_at=NOW()
       WHERE id=$3`,
      [winnerId, winningTicketNumber, roundId]);

    await c.query(
      `INSERT INTO notifications (user_id,title,body,type,category)
       VALUES ($1,'🎉 Lottery Winner!',$2,'success','win')`,
      [winnerId, `You won ${prizePool} USDT in Weekly Lottery #${round.round_number}!`]);

    logger.info({ roundId, winnerId, prizePool, ticket: winningTicketNumber }, '🎟️ Weekly lottery drawn');
    return { roundId, winnerId, winningTicketNumber, prizePool };
  });
};

// =========================================================================
//  SECTION 20: EXPRESS APP
// =========================================================================
const app = express();
app.use(helmet());
app.use(cors({ origin: ENV.CORS_ORIGIN === '*' ? true : ENV.CORS_ORIGIN.split(','), credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => { logger.debug(`${req.method} ${req.url}`); next(); });

app.get('/health', async (_req, res) => {
  try {
    const dbStart = Date.now();
    await query('SELECT 1');
    const dbPingMs = Date.now() - dbStart;
    const mem = process.memoryUsage();
    res.json({
      ok: true, ts: Date.now(), uptime: Math.round(process.uptime()),
      version: '1.0.0', env: ENV.NODE_ENV,
      db: { ok: true, pingMs: dbPingMs },
      memory: {
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heapUsed_mb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotal_mb: Math.round(mem.heapTotal / 1024 / 1024),
      },
      node: process.version, platform: process.platform,
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE', ts: Date.now() });
  }
});

const R = express.Router();

// ---------- AUTH ----------
R.post('/auth/register', authLimit, async (req, res, next) => {
  try { res.status(201).json({ success: true, ...(await registerUser(req.body)) }); }
  catch (e: any) { if (e.status) return res.status(e.status).json({ success: false, error: e.message }); next(e); }
});

R.post('/auth/login', authLimit, async (req, res, next) => {
  try { res.json({ success: true, ...(await loginUser(req.body.email, req.body.password)) }); }
  catch (e: any) { if (e.status) return res.status(e.status).json({ success: false, error: e.message }); next(e); }
});

R.get('/auth/me', authMiddleware, async (req, res, next) => {
  try {
    const uid = (req as any).user.id;
    await withTransaction(async (c) => { await applyDailyStreak(c, uid); });
    await ensureMissionsForToday(uid);
    const r = await query(
      `SELECT id,email,username,referral_code,referrer_pkg_snapshot,package,
              status,balance,demo_balance,last_demo_reset,
              total_deposited,total_withdrawn,total_wagered,
              active_ref_count,wallet_address,last_bonus_spin,streak_count,
              last_login_date,xp,level,created_at,
              daily_withdrawn_total,daily_withdrawn_date,
              monthly_withdrawn_total,monthly_withdrawn_month
       FROM users WHERE id=$1`, [uid]);
    res.json({ success: true, user: r.rows[0] });
  } catch (e) { next(e); }
});

// ---------- DEMO MODE ----------
R.get('/demo/status', authMiddleware, async (req, res, next) => {
  try {
    const uid = (req as any).user.id;
    const dm = await getDemoMode();
    const r = await query(`SELECT demo_balance, last_demo_reset FROM users WHERE id=$1`, [uid]);
    res.json({
      success: true, enabled: dm.enabled,
      demo_balance: Number(r.rows[0].demo_balance),
      last_demo_reset: r.rows[0].last_demo_reset,
      reset_hours: Number(dm.reset_hours || 24),
      starting_balance: Number(dm.starting_balance || 1000),
    });
  } catch (e) { next(e); }
});

R.post('/demo/reset', authMiddleware, sensitiveLimit, async (req, res, next) => {
  try {
    const uid = (req as any).user.id;
    const dm = await getDemoMode();
    await withTransaction(async (c) => {
      await lockUser(c, uid);
      await c.query(
        `UPDATE users SET demo_balance=$1, last_demo_reset=NOW() WHERE id=$2`,
        [dm.starting_balance, uid]);
    });
    res.json({ success: true, demo_balance: Number(dm.starting_balance) });
  } catch (e: any) { if (e.status) return res.status(e.status).json({ success: false, error: e.message }); next(e); }
});

// ---------- POOLS (public) ----------
R.get('/pools/:game', readLimit, async (req, res, next) => {
  try {
    const pool = await getGamePool(req.params.game);
    res.json({ success: true, game: req.params.game, pool });
  } catch (e) { next(e); }
});

// ---------- PROVABLY FAIR (backend only) ----------
R.get('/fair/seed', authMiddleware, async (req, res, next) => {
  try {
    const uid = (req as any).user.id;
    const r = await query(
      `SELECT server_seed_hash,client_seed,nonce,created_at
       FROM user_seeds WHERE user_id=$1 AND is_active=TRUE LIMIT 1`, [uid]);
    if (!r.rowCount) {
      const c = await pool.connect();
      try {
        const seed = await getOrCreateSeed(c, uid);
        return res.json({ success: true, seed: {
          server_seed_hash: seed.server_seed_hash,
          client_seed: seed.client_seed, nonce: seed.nonce,
          algorithm: 'HMAC-SHA512',
        }});
      } finally { c.release(); }
    }
    res.json({ success: true, seed: { ...r.rows[0], algorithm: 'HMAC-SHA512' } });
  } catch (e) { next(e); }
});

R.post('/fair/client-seed', authMiddleware, sensitiveLimit, async (req, res, next) => {
  try {
    const cs = String(req.body.clientSeed || '');
    if (!cs || cs.length < 1 || cs.length > 64)
      return res.status(400).json({ success: false, error: 'INVALID_CLIENT_SEED' });
    await query(
      `UPDATE user_seeds SET client_seed=$1 WHERE user_id=$2 AND is_active=TRUE`,
      [cs, (req as any).user.id]);
    res.json({ success: true });
  } catch (e) { next(e); }
});

R.post('/fair/rotate', authMiddleware, sensitiveLimit, async (req, res, next) => {
  try {
    const uid = (req as any).user.id;
    const result = await withTransaction(async (c) => {
      const cur = await c.query(
        `SELECT id,server_seed,server_seed_hash,client_seed,nonce
         FROM user_seeds WHERE user_id=$1 AND is_active=TRUE FOR UPDATE`, [uid]);
      if (!cur.rowCount) throw Object.assign(new Error('NO_ACTIVE_SEED'), { status: 404 });
      const old = cur.rows[0];
      await c.query(`UPDATE user_seeds SET is_active=FALSE, rotated_at=NOW() WHERE id=$1`, [old.id]);
      const newSS = randHex(32), newSSH = sha256(newSS), newCS = randHex(8);
      const ins = await c.query(
        `INSERT INTO user_seeds (user_id,server_seed,server_seed_hash,client_seed,nonce)
         VALUES ($1,$2,$3,$4,0) RETURNING id,server_seed_hash,client_seed`,
        [uid, newSS, newSSH, newCS]);
      return { old: { server_seed: old.server_seed, server_seed_hash: old.server_seed_hash,
                      client_seed: old.client_seed, nonce: old.nonce },
               new: ins.rows[0] };
    });
    res.json({ success: true, ...result });
  } catch (e: any) { if (e.status) return res.status(e.status).json({ success: false, error: e.message }); next(e); }
});

R.post('/fair/verify', readLimit, async (req, res, next) => {
  try {
    const { serverSeed, clientSeed, nonce, expectedRoll } = req.body;
    if (typeof serverSeed !== 'string' || typeof clientSeed !== 'string' || typeof nonce !== 'number')
      return res.status(400).json({ success: false, error: 'MISSING_FIELDS' });
    res.json({ success: true, ...verifyRoll(serverSeed, clientSeed, nonce, Number(expectedRoll)) });
  } catch (e) { next(e); }
});

// ---------- PACKAGES / MLM ----------
R.post('/payment/purchase-package', authMiddleware, sensitiveLimit, idempotency('purchase-package'),
  async (req, res, next) => {
    try {
      const { txHash, package: pkg } = req.body;
      const v = await verifyUsdtPayment(txHash);
      if (!v.success) return res.status(400).json({ success: false, error: v.reason });
      if (!v.isFinal) return res.status(202).json({ success: false, error: 'AWAITING_CONFIRMATIONS' });
      const result = await activatePackage({
        userId: (req as any).user.id, package: pkg, txHash,
        fromAddress: v.details!.from, amount: Number(v.details!.amount),
      });
      res.json({ success: true, ...result });
    } catch (e: any) { if (e.status) return res.status(e.status).json({ success: false, error: e.message }); next(e); }
  });

R.get('/mlm/tree', authMiddleware, paginationGuard(100, 50), async (req, res, next) => {
  try {
    const uid = (req as any).user.id;
    const l1 = await query(
      `SELECT id,email,username,package,status,active_ref_count,created_at
       FROM users WHERE referred_by=$1 ORDER BY created_at DESC`, [uid]);
    const l1Ids = l1.rows.map((x) => x.id);
    let l2 = { rows: [] as any[] };
    if (l1Ids.length) {
      l2 = await query(
        `SELECT id,email,username,package,status,created_at
         FROM users WHERE referred_by = ANY($1::uuid[]) ORDER BY created_at DESC`, [l1Ids]);
    }
    const earnings = await query(
      `SELECT level,kind,COUNT(*)::int AS count,COALESCE(SUM(amount_usdt),0) AS total
       FROM referral_commissions WHERE earner_id=$1
       GROUP BY level,kind ORDER BY level,kind`, [uid]);
    const activeCount = await query(
      `SELECT COUNT(*)::int AS count FROM users WHERE referred_by=$1 AND status='active'`, [uid]);
    res.json({
      success: true,
      level1: sanitizeMany(l1.rows), level2: sanitizeMany(l2.rows),
      earnings: earnings.rows, active_ref_count: activeCount.rows[0].count,
    });
  } catch (e) { next(e); }
});

// ---------- DICE ----------
R.post('/dice/roll', authMiddleware, betLimit, idempotency('dice-roll'), async (req, res, next) => {
  try {
    const { betAmount, target, condition, isDemo } = req.body;
    const result = await rollDice({
      userId: (req as any).user.id, betAmount: Number(betAmount),
      target: Number(target), condition, isDemo: Boolean(isDemo),
    });
    res.json({ success: true, ...result });
  } catch (e: any) { if (e.status) return res.status(e.status).json({ success: false, error: e.message }); next(e); }
});

// ---------- BOXES ----------
R.get('/boxes', readLimit, async (_req, res, next) => {
  try {
    const r = await query(
      `SELECT id,name,price_usdt,image_url,odds FROM mystery_boxes
       WHERE is_active=TRUE ORDER BY price_usdt ASC`);
    res.json({ success: true, boxes: r.rows });
  } catch (e) { next(e); }
});

R.post('/boxes/:id/open', authMiddleware, betLimit, idempotency('box-open'), async (req, res, next) => {
  try {
    const isDemo = Boolean(req.body.isDemo);
    res.json({ success: true, ...(await openBox((req as any).user.id, req.params.id, isDemo)) });
  } catch (e: any) { if (e.status) return res.status(e.status).json({ success: false, error: e.message }); next(e); }
});

// ---------- PREDICTION ----------
R.get('/prediction/markets', readLimit, async (_req, res, next) => {
  try {
    const r = await query(
      `SELECT id,symbol,duration_seconds,open_price,closes_at,
              total_up,total_down,status
       FROM prediction_markets WHERE status='open' AND closes_at > NOW()
       ORDER BY closes_at ASC`);
    res.json({ success: true, markets: r.rows });
  } catch (e) { next(e); }
});

R.post('/prediction/markets/:id/bet', authMiddleware, betLimit, idempotency('prediction-bet'),
  async (req, res, next) => {
    try {
      const { side, amount } = req.body;
      const r = await placePredictionBet((req as any).user.id, req.params.id, side, Number(amount));
      res.json({ success: true, ...r });
    } catch (e: any) { if (e.status) return res.status(e.status).json({ success: false, error: e.message }); next(e); }
  });

// ---------- BONUS WHEEL ----------
R.get('/bonus/config', readLimit, async (_req, res, next) => {
  try {
    const cfg = await getSetting('bonus_wheel');
    const pool = await getGamePool('wheel');
    res.json({
      success: true,
      config: {
        cooldown_hours: cfg.cooldown_hours,
        min_bet: cfg.min_bet,
        max_bet: cfg.max_bet,
        free_spin_value: cfg.free_spin_value,
        segments: cfg.segments.map((s: any) => ({
          label: s.label, color: s.color, multiplier: s.multiplier,
        })),
      },
      currentPool: pool,
    });
  } catch (e) { next(e); }
});

R.get('/bonus/status', authMiddleware, async (req, res, next) => {
  try {
    const cfg = await getSetting('bonus_wheel');
    const u = await query('SELECT last_bonus_spin FROM users WHERE id=$1', [(req as any).user.id]);
    const last = u.rows[0].last_bonus_spin;
    const cd = cfg.cooldown_hours * 3600 * 1000;
    if (!last || Date.now() - new Date(last).getTime() >= cd)
      return res.json({ success: true, canSpin: true });
    const nextAt = new Date(new Date(last).getTime() + cd);
    res.json({ success: true, canSpin: false, nextAt,
      secondsRemaining: Math.ceil((nextAt.getTime() - Date.now()) / 1000) });
  } catch (e) { next(e); }
});

R.post('/bonus/spin', authMiddleware, sensitiveLimit, idempotency('bonus-spin'), async (req, res, next) => {
  try {
    const { betAmount, useFreeSpin, isDemo } = req.body || {};
    const result = await spinWheel((req as any).user.id, Number(betAmount) || 1, Boolean(useFreeSpin), Boolean(isDemo));
    res.json({ success: true, ...result });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({ success: false, error: e.message, ...e });
    next(e);
  }
});

// ---------- VIP ----------
R.get('/vip/tiers', readLimit, async (_req, res, next) => {
  try {
    const cfg = await getSetting('per_game_edge');
    const demoCfg = await getDemoMode();
    const dm = Number(demoCfg.house_edge_multiplier || 0.4);
    const pkgs = ['none', 'p1_5', 'p2_10', 'p3_20', 'p4_50'];
    const tiers = pkgs.map((pkg) => ({
      package: pkg,
      house_edges: {
        dice: cfg.dice?.[pkg] ?? cfg.dice?.none,
        boxes: cfg.boxes?.[pkg] ?? cfg.boxes?.none,
        prediction: cfg.prediction?.[pkg] ?? cfg.prediction?.none,
        wheel: cfg.wheel?.[pkg] ?? cfg.wheel?.none,
      },
      demo_house_edges: {
        dice: +((cfg.dice?.[pkg] ?? cfg.dice?.none) * dm).toFixed(4),
        boxes: +((cfg.boxes?.[pkg] ?? cfg.boxes?.none) * dm).toFixed(4),
        prediction: +((cfg.prediction?.[pkg] ?? cfg.prediction?.none) * dm).toFixed(4),
        wheel: +((cfg.wheel?.[pkg] ?? cfg.wheel?.none) * dm).toFixed(4),
      },
    }));
    res.json({ success: true, tiers });
  } catch (e) { next(e); }
});

// ---------- WITHDRAW ----------
R.get('/withdraw/eligibility', authMiddleware, async (req, res, next) => {
  try {
    const r = await query(
      `SELECT balance,active_ref_count,wallet_address,status,
              daily_withdrawn_total,daily_withdrawn_date,
              monthly_withdrawn_total,monthly_withdrawn_month
       FROM users WHERE id=$1`, [(req as any).user.id]);
    const u = r.rows[0];
    const limits = await getWithdrawalLimits();
    const today = new Date().toISOString().slice(0, 10);
    const thisMonth = new Date().toISOString().slice(0, 7);
    const dailyUsed = u.daily_withdrawn_date === today ? Number(u.daily_withdrawn_total) : 0;
    const monthlyUsed = u.monthly_withdrawn_month === thisMonth ? Number(u.monthly_withdrawn_total) : 0;

    if (u.status === 'banned') return res.json({ success: true, ok: false, reason: 'ACCOUNT_BANNED' });
    if (Number(u.balance) < 10)
      return res.json({ success: true, ok: false, reason: 'MIN_BALANCE_NOT_MET',
        required: 10, current: Number(u.balance) });
    if (u.active_ref_count < 3)
      return res.json({ success: true, ok: false, reason: 'MIN_ACTIVE_REFS_NOT_MET',
        required: 3, current: u.active_ref_count });
    if (!u.wallet_address) return res.json({ success: true, ok: false, reason: 'WALLET_NOT_SET' });
    res.json({ success: true, ok: true,
      limits: { daily_max: limits.daily_max, daily_used: dailyUsed,
                monthly_max: limits.monthly_max, monthly_used: monthlyUsed } });
  } catch (e) { next(e); }
});

R.post('/withdraw/request', authMiddleware, sensitiveLimit, idempotency('withdraw'), async (req, res, next) => {
  try {
    const r = await createWithdraw((req as any).user.id, Number(req.body.amount), req.body.walletAddress);
    res.status(201).json({ success: true, withdrawal: r });
  } catch (e: any) {
    if (e.status) return res.status(e.status).json({
      success: false, error: e.message,
      ...(e.daily_max ? { daily_max: e.daily_max, used: e.used } : {}),
      ...(e.monthly_max ? { monthly_max: e.monthly_max, used: e.used } : {}),
    });
    next(e);
  }
});

R.post('/withdraw/:txId/cancel', authMiddleware, sensitiveLimit, async (req, res, next) => {
  try { res.json({ success: true, ...(await cancelWithdraw((req as any).user.id, req.params.txId)) }); }
  catch (e: any) { if (e.status) return res.status(e.status).json({ success: false, error: e.message }); next(e); }
});

R.get('/withdraw/history', authMiddleware, paginationGuard(50, 20), async (req, res, next) => {
  try {
    const { limit, offset } = (req as any).pagination;
    const r = await query(
      `SELECT id,amount_usdt,fee_usdt,status,to_address,admin_note,tx_hash,created_at,updated_at
       FROM transactions WHERE user_id=$1 AND type='withdrawal'
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [(req as any).user.id, limit, offset]);
    res.json({ success: true, withdrawals: sanitizeMany(r.rows) });
  } catch (e) { next(e); }
});

// ---------- DEPOSITS ----------
R.post('/deposit/verify', authMiddleware, sensitiveLimit, idempotency('deposit-verify'), async (req, res, next) => {
  try {
    const { txHash } = req.body;
    const d = await createDepositIntent((req as any).user.id, txHash);
    res.json({ success: true, deposit: d });
  } catch (e: any) { if (e.status) return res.status(e.status).json({ success: false, error: e.message }); next(e); }
});

R.get('/deposit/history', authMiddleware, paginationGuard(50, 20), async (req, res, next) => {
  try {
    const { limit, offset } = (req as any).pagination;
    const r = await query(
      `SELECT id,tx_hash,amount_usdt,status,confirmations,created_at,confirmed_at
       FROM deposits WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [(req as any).user.id, limit, offset]);
    res.json({ success: true, deposits: r.rows });
  } catch (e) { next(e); }
});

// ---------- MISSIONS ----------
R.get('/missions', authMiddleware, async (req, res, next) => {
  try {
    const uid = (req as any).user.id;
    await ensureMissionsForToday(uid);
    const r = await query(
      `SELECT m.id,m.key,m.title,m.description,m.kind,m.target_count,
              m.reward_usdt,m.reward_xp,m.sort_order,
              COALESCE(um.progress,0) AS progress,
              um.completed_at, um.claimed_at
       FROM missions m
       LEFT JOIN user_missions um
         ON um.mission_id=m.id AND um.user_id=$1 AND um.day=CURRENT_DATE
       WHERE m.is_active=TRUE
       ORDER BY m.sort_order`, [uid]);
    const u = await query('SELECT streak_count,last_login_date FROM users WHERE id=$1', [uid]);
    const streakCfg = await getStreakRewards();
    res.json({
      success: true, missions: r.rows,
      streak: { count: u.rows[0].streak_count, last_date: u.rows[0].last_login_date,
                rewards: streakCfg.daily },
    });
  } catch (e) { next(e); }
});

R.post('/missions/:id/claim', authMiddleware, sensitiveLimit, idempotency('mission-claim'), async (req, res, next) => {
  try { res.json({ success: true, ...(await claimMission((req as any).user.id, req.params.id)) }); }
  catch (e: any) { if (e.status) return res.status(e.status).json({ success: false, error: e.message }); next(e); }
});

// ---------- NOTIFICATIONS ----------
R.get('/notifications', authMiddleware, paginationGuard(50, 20), async (req, res, next) => {
  try {
    const { limit, offset } = (req as any).pagination;
    const r = await query(
      `SELECT id,title,body,type,category,link,is_read,created_at
       FROM notifications WHERE user_id=$1 OR user_id IS NULL
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [(req as any).user.id, limit, offset]);
    const unread = await query(
      `SELECT COUNT(*)::int AS count FROM notifications
       WHERE (user_id=$1 OR user_id IS NULL) AND is_read=FALSE`,
      [(req as any).user.id]);
    res.json({ success: true, notifications: r.rows, unread: unread.rows[0].count });
  } catch (e) { next(e); }
});

R.post('/notifications/:id/read', authMiddleware, async (req, res, next) => {
  try {
    await query(
      `UPDATE notifications SET is_read=TRUE WHERE id=$1 AND (user_id=$2 OR user_id IS NULL)`,
      [req.params.id, (req as any).user.id]);
    res.json({ success: true });
  } catch (e) { next(e); }
});

R.post('/notifications/read-all', authMiddleware, async (req, res, next) => {
  try {
    await query(
      `UPDATE notifications SET is_read=TRUE WHERE user_id=$1 AND is_read=FALSE`,
      [(req as any).user.id]);
    res.json({ success: true });
  } catch (e) { next(e); }
});

// ---------- BET HISTORY ----------
R.get('/bets/history', authMiddleware, paginationGuard(50, 20), async (req, res, next) => {
  try {
    const { limit, offset } = (req as any).pagination;
    const game = (req.query.game as string) || '';
    const isDemo = req.query.isDemo;
    const status = (req.query.status as string) || '';
    const r = await query(
      `SELECT id,game,bet_amount,payout,house_edge,status,result_value,
              payload,created_at,settled_at,is_demo
       FROM casino_bets
       WHERE user_id=$1
         AND ($2 = '' OR game::text = $2)
         AND ($3 = '' OR status::text = $3)
         AND ($4 = '' OR is_demo = $4::boolean)
       ORDER BY created_at DESC LIMIT $5 OFFSET $6`,
      [(req as any).user.id, game, status,
       isDemo === 'true' ? true : isDemo === 'false' ? false : '',
       limit, offset]);
    res.json({ success: true, bets: r.rows });
  } catch (e) { next(e); }
});

// ---------- LIVE FEED ----------
R.get('/live/winners', readLimit, async (_req, res, next) => {
  try {
    const r = await query(
      `SELECT cb.id, cb.game, cb.bet_amount, cb.payout, cb.created_at, cb.is_demo,
              u.username, u.email
       FROM casino_bets cb JOIN users u ON u.id=cb.user_id
       WHERE cb.status='won' AND cb.payout > cb.bet_amount AND cb.is_demo=FALSE
       ORDER BY cb.settled_at DESC NULLS LAST LIMIT 20`);
    const feed = r.rows.map((row) => ({
      id: row.id, game: row.game,
      username: row.username || (row.email || '').split('@')[0],
      bet_amount: row.bet_amount, payout: row.payout,
      profit: +(Number(row.payout) - Number(row.bet_amount)).toFixed(4),
      created_at: row.created_at,
    }));
    res.json({ success: true, feed });
  } catch (e) { next(e); }
});

// ---------- FAQ ----------
R.get('/faq', readLimit, async (_req, res, next) => {
  try {
    const r = await query(
      `SELECT id,category,question,answer,sort_order FROM faq_entries
       WHERE is_active=TRUE ORDER BY category, sort_order`);
    res.json({ success: true, faqs: r.rows });
  } catch (e) { next(e); }
});

// ---------- LOTTERY ----------
R.get('/lottery/current', readLimit, async (_req, res, next) => {
  try {
    const round = await getOrCreateCurrentRound();
    const recent = await query(
      `SELECT id,round_number,winner_id,winning_ticket,prize_pool,drawn_at
       FROM weekly_lottery_rounds WHERE status='completed'
       ORDER BY drawn_at DESC LIMIT 5`);
    res.json({ success: true, round, recent_winners: recent.rows });
  } catch (e) { next(e); }
});

R.post('/lottery/buy', authMiddleware, sensitiveLimit, idempotency('lottery-buy'), async (req, res, next) => {
  try {
    const r = await buyLotteryTickets((req as any).user.id, Number(req.body.quantity) || 1);
    res.json({ success: true, ...r });
  } catch (e: any) { if (e.status) return res.status(e.status).json({ success: false, error: e.message }); next(e); }
});

R.get('/lottery/my-tickets', authMiddleware, paginationGuard(100, 50), async (req, res, next) => {
  try {
    const { limit, offset } = (req as any).pagination;
    const r = await query(
      `SELECT wlt.id,wlt.ticket_number,wlt.paid_amount,wlt.created_at,
              wlr.round_number,wlr.status,wlr.winning_ticket
       FROM weekly_lottery_tickets wlt
       JOIN weekly_lottery_rounds wlr ON wlr.id=wlt.round_id
       WHERE wlt.user_id=$1 ORDER BY wlt.created_at DESC LIMIT $2 OFFSET $3`,
      [(req as any).user.id, limit, offset]);
    res.json({ success: true, tickets: r.rows });
  } catch (e) { next(e); }
});

// =========================================================================
//  ADMIN ENDPOINTS
// =========================================================================
R.get('/admin/stats', authMiddleware, adminMiddleware, adminLimit, async (_req, res, next) => {
  try {
    const [users, wallets, subs, bets, ggrTotal, ggrDaily, wheelCost, pendingWd, topWinners, topLosers, demoStats] = await Promise.all([
      query(`SELECT COUNT(*)::int total,
                    COUNT(*) FILTER (WHERE status='active')::int active,
                    COUNT(*) FILTER (WHERE status='banned')::int banned FROM users`),
      query(`SELECT COALESCE(SUM(balance),0) total_balances,
                    COALESCE(SUM(demo_balance),0) total_demo_balances,
                    COALESCE(SUM(total_deposited),0) total_deposited,
                    COALESCE(SUM(total_withdrawn),0) total_withdrawn FROM users`),
      query(`SELECT COUNT(*)::int count,COALESCE(SUM(amount_usdt),0) revenue FROM subscriptions`),
      query(`SELECT COUNT(*)::int count,COALESCE(SUM(bet_amount),0) wagered,
                    COALESCE(SUM(payout),0) paid FROM casino_bets WHERE is_demo=FALSE`),
      query(`SELECT
               COALESCE(SUM(bet_amount),0) AS total_bet,
               COALESCE(SUM(payout),0) AS total_payout,
               COALESCE(SUM(CASE WHEN status IN ('won','lost') THEN bet_amount - payout ELSE 0 END),0) AS ggr
             FROM casino_bets WHERE is_demo=FALSE`),
      query(`SELECT COALESCE(SUM(bet_amount - payout),0) ggr FROM casino_bets
             WHERE status IN ('won','lost') AND is_demo=FALSE
             AND created_at >= NOW() - INTERVAL '24 hours'`),
      query(`SELECT COALESCE(SUM(prize_amount),0) total FROM bonus_wheel_spins`),
      query(`SELECT COUNT(*)::int count FROM transactions
             WHERE type='withdrawal' AND status='pending'`),
      query(`SELECT u.id,u.username,u.email,
                    COALESCE(SUM(cb.payout - cb.bet_amount),0) AS net_profit
             FROM casino_bets cb JOIN users u ON u.id=cb.user_id
             WHERE cb.status='won' AND cb.is_demo=FALSE
             GROUP BY u.id,u.username,u.email
             ORDER BY net_profit DESC LIMIT 5`),
      query(`SELECT u.id,u.username,u.email,
                    COALESCE(SUM(cb.bet_amount - cb.payout),0) AS net_loss
             FROM casino_bets cb JOIN users u ON u.id=cb.user_id
             WHERE cb.is_demo=FALSE AND cb.status IN ('won','lost')
             GROUP BY u.id,u.username,u.email
             ORDER BY net_loss DESC LIMIT 5`),
      query(`SELECT COUNT(*)::int count,
                    COALESCE(SUM(bet_amount),0) wagered,
                    COALESCE(SUM(payout),0) paid
             FROM casino_bets WHERE is_demo=TRUE`),
    ]);
    const dailyGgr = await query(`SELECT * FROM v_daily_ggr LIMIT 30`);
    const pools = await query(`SELECT game, current_pool, total_contributed, total_paid_out FROM game_pools`);
    res.json({
      success: true,
      stats: {
        users: users.rows[0], wallets: wallets.rows[0],
        subscriptions: subs.rows[0], casino: bets.rows[0],
        ggr_total: Number(ggrTotal.rows[0].ggr),
        ggr_details: ggrTotal.rows[0],
        ggr_daily: Number(ggrDaily.rows[0].ggr),
        wheel_cost_total: Number(wheelCost.rows[0].total),
        pending_withdrawals: pendingWd.rows[0].count,
        top_winners: topWinners.rows, top_losers: topLosers.rows,
        demo: demoStats.rows[0],
        daily_ggr: dailyGgr.rows,
        pools: pools.rows,
      },
    });
  } catch (e) { next(e); }
});

R.get('/admin/users', authMiddleware, adminMiddleware, paginationGuard(50, 20), async (req, res, next) => {
  try {
    const { limit, offset } = (req as any).pagination;
    const q = (req.query.q as string) || '';
    const r = await query(
      `SELECT id,email,username,referral_code,package,status,balance,demo_balance,
              active_ref_count,created_at,streak_count,xp,level,
              daily_withdrawn_total,monthly_withdrawn_total
       FROM users WHERE ($1='' OR email ILIKE '%'||$1||'%' OR username ILIKE '%'||$1||'%')
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [q, limit, offset]);
    res.json({ success: true, users: sanitizeMany(r.rows) });
  } catch (e) { next(e); }
});

R.patch('/admin/users/:id/status', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['active','banned','unverified'].includes(status))
      return res.status(400).json({ success: false, error: 'INVALID_STATUS' });
    const before = await query('SELECT id,email,status FROM users WHERE id=$1', [req.params.id]);
    if (!before.rowCount) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    const r = await query(
      `UPDATE users SET status=$1 WHERE id=$2 RETURNING id,email,status`,
      [status, req.params.id]);
    await writeAudit({
      adminId: (req as any).user.id, adminEmail: (req as any).user.email,
      action: 'user.status_change', targetType: 'user', targetId: req.params.id,
      before: before.rows[0], after: r.rows[0],
      ip: req.ip, ua: req.header('user-agent') || '',
    });
    res.json({ success: true, user: r.rows[0] });
  } catch (e) { next(e); }
});

R.post('/admin/users/:id/balance', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const { amount, note } = req.body;
    if (typeof amount !== 'number' || amount === 0)
      return res.status(400).json({ success: false, error: 'INVALID_AMOUNT' });
    const before = await query('SELECT balance FROM users WHERE id=$1', [req.params.id]);
    if (!before.rowCount) return res.status(404).json({ success: false, error: 'NOT_FOUND' });
    await withTransaction(async (c) => {
      const type = amount > 0 ? 'admin_credit' : 'admin_debit';
      await c.query(
        `INSERT INTO transactions (user_id,type,amount_usdt,status,admin_note,processed_by,meta,is_demo)
         VALUES ($1,$2,$3,'confirmed',$4,$5,$6,FALSE)`,
        [req.params.id, type, Math.abs(amount), note || null, (req as any).user.id,
         JSON.stringify({ manual: true })]);
    });
    const after = await query('SELECT balance FROM users WHERE id=$1', [req.params.id]);
    await writeAudit({
      adminId: (req as any).user.id, adminEmail: (req as any).user.email,
      action: 'user.balance_adjust', targetType: 'user', targetId: req.params.id,
      before: before.rows[0], after: after.rows[0],
      ip: req.ip, ua: req.header('user-agent') || '',
    });
    res.json({ success: true, newBalance: Number(after.rows[0].balance) });
  } catch (e) { next(e); }
});

R.get('/admin/withdrawals', authMiddleware, adminMiddleware, paginationGuard(100, 50), async (req, res, next) => {
  try {
    const { limit, offset } = (req as any).pagination;
    const status = (req.query.status as string) || 'pending';
    const r = await query(
      `SELECT t.id,t.amount_usdt,t.fee_usdt,t.status,t.created_at,t.meta,
              u.id AS user_id,u.email,u.wallet_address,u.balance
       FROM transactions t JOIN users u ON u.id=t.user_id
       WHERE t.type='withdrawal' AND t.status=$1::tx_status
       ORDER BY t.created_at DESC LIMIT $2 OFFSET $3`,
      [status, limit, offset]);
    res.json({ success: true, withdrawals: sanitizeMany(r.rows) });
  } catch (e) { next(e); }
});

R.post('/admin/withdrawals/:txId', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const { action, txHash, adminNote } = req.body;
    if (!['approve','reject'].includes(action))
      return res.status(400).json({ success: false, error: 'INVALID_ACTION' });

    const result = await withTransaction(async (c) => {
      const t = await c.query(
        `SELECT * FROM transactions WHERE id=$1 AND type='withdrawal' FOR UPDATE`,
        [req.params.txId]);
      if (!t.rowCount) throw Object.assign(new Error('NOT_FOUND'), { status: 404 });
      const tx = t.rows[0];
      if (tx.status !== 'pending')
        throw Object.assign(new Error('ALREADY_PROCESSED'), { status: 400 });

      if (action === 'approve') {
        await c.query(
          `UPDATE transactions SET status='confirmed', tx_hash=$1, admin_note=$2,
             processed_by=$3, updated_at=NOW() WHERE id=$4`,
          [txHash || null, adminNote || null, (req as any).user.id, req.params.txId]);
        await c.query(
          `UPDATE users SET total_withdrawn = total_withdrawn + $1 WHERE id=$2`,
          [tx.amount_usdt, tx.user_id]);
        if (Number(tx.fee_usdt) > 0) {
          await c.query(
            `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
             VALUES ((SELECT id FROM users WHERE email=$1),'platform_fee',$2,'confirmed',$3,FALSE)`,
            [ENV.ADMIN_EMAIL, tx.fee_usdt,
             JSON.stringify({ source: 'withdrawal_fee', ref_tx: req.params.txId })]);
        }
        await c.query(
          `INSERT INTO notifications (user_id,title,body,type,category)
           VALUES ($1,'Withdrawal Approved',$2,'success','withdrawal')`,
          [tx.user_id, `${tx.amount_usdt} USDT sent to your wallet.`]);
        return { status: 'confirmed' };
      } else {
        await c.query(
          `UPDATE transactions SET status='rejected', admin_note=$1,
             processed_by=$2, updated_at=NOW() WHERE id=$3`,
          [adminNote || null, (req as any).user.id, req.params.txId]);
        await c.query(
          `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
           VALUES ($1,'bet_win',$2,'confirmed',$3,FALSE)`,
          [tx.user_id, tx.amount_usdt,
           JSON.stringify({ refund: 'withdrawal_rejected', original_tx: req.params.txId })]);
        await c.query(
          `INSERT INTO notifications (user_id,title,body,type,category)
           VALUES ($1,'Withdrawal Rejected',$2,'warning','withdrawal')`,
          [tx.user_id, `Reason: ${adminNote || 'contact support'}`]);
        return { status: 'rejected' };
      }
    });

    await writeAudit({
      adminId: (req as any).user.id, adminEmail: (req as any).user.email,
      action: `withdrawal.${action}`, targetType: 'withdrawal', targetId: req.params.txId,
      before: { action: 'pending' }, after: result,
      ip: req.ip, ua: req.header('user-agent') || '',
    });

    res.json({ success: true, ...result });
  } catch (e: any) { if (e.status) return res.status(e.status).json({ success: false, error: e.message }); next(e); }
});

R.put('/admin/settings/:key', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const { value } = req.body;
    if (!value || typeof value !== 'object')
      return res.status(400).json({ success: false, error: 'VALUE_MUST_BE_OBJECT' });
    const before = await query('SELECT value FROM platform_settings WHERE key=$1', [req.params.key]);
    const r = await query(
      `INSERT INTO platform_settings (key,value,updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
       RETURNING key,value,updated_at`,
      [req.params.key, JSON.stringify(value)]);
    invalidateSetting(req.params.key);
    await writeAudit({
      adminId: (req as any).user.id, adminEmail: (req as any).user.email,
      action: 'settings.update', targetType: 'setting', targetId: null,
      before: before.rows[0]?.value, after: value,
      ip: req.ip, ua: req.header('user-agent') || '',
    });
    res.json({ success: true, setting: r.rows[0] });
  } catch (e) { next(e); }
});

R.get('/admin/settings', authMiddleware, adminMiddleware, async (_req, res, next) => {
  try {
    const r = await query('SELECT key,value,updated_at FROM platform_settings ORDER BY key');
    res.json({ success: true, settings: r.rows });
  } catch (e) { next(e); }
});

R.post('/admin/games/:game/toggle', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const game = req.params.game;
    const cfg = await getGamesEnabled();
    if (!(game in cfg))
      return res.status(400).json({ success: false, error: 'UNKNOWN_GAME' });
    cfg[game] = !cfg[game];
    await query(
      `UPDATE platform_settings SET value=$1, updated_at=NOW() WHERE key='games_enabled'`,
      [JSON.stringify(cfg)]);
    invalidateSetting('games_enabled');
    await writeAudit({
      adminId: (req as any).user.id, adminEmail: (req as any).user.email,
      action: 'games.toggle', targetType: 'game', targetId: null,
      before: { [game]: !cfg[game] }, after: { [game]: cfg[game] },
      ip: req.ip, ua: req.header('user-agent') || '',
    });
    res.json({ success: true, games: cfg });
  } catch (e) { next(e); }
});

R.get('/admin/audit', authMiddleware, adminMiddleware, paginationGuard(100, 50), async (req, res, next) => {
  try {
    const { limit, offset } = (req as any).pagination;
    const action = (req.query.action as string) || '';
    const r = await query(
      `SELECT a.id,a.admin_email,a.action,a.target_type,a.target_id,
              a.before_state,a.after_state,a.ip_address,a.created_at
       FROM audit_log a
       WHERE ($1 = '' OR a.action ILIKE '%'||$1||'%')
       ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`,
      [action, limit, offset]);
    res.json({ success: true, logs: r.rows });
  } catch (e) { next(e); }
});

R.post('/admin/lottery/draw', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const { roundId } = req.body;
    const r = await drawWeeklyLottery(roundId);
    await writeAudit({
      adminId: (req as any).user.id, adminEmail: (req as any).user.email,
      action: 'lottery.draw', targetType: 'lottery_round', targetId: roundId,
      before: null, after: r, ip: req.ip, ua: req.header('user-agent') || '',
    });
    res.json({ success: true, ...r });
  } catch (e: any) { if (e.status) return res.status(e.status).json({ success: false, error: e.message }); next(e); }
});

R.post('/admin/lottery/create-round', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const { endAt, ticketPrice } = req.body;
    if (!endAt) return res.status(400).json({ success: false, error: 'END_AT_REQUIRED' });
    const last = await query(`SELECT COALESCE(MAX(round_number),0) AS n FROM weekly_lottery_rounds`);
    const nextN = Number(last.rows[0].n) + 1;
    const r = await query(
      `INSERT INTO weekly_lottery_rounds (round_number, start_at, end_at, ticket_price, is_admin_controlled)
       VALUES ($1, NOW(), $2, $3, TRUE) RETURNING *`,
      [nextN, endAt, Number(ticketPrice) || 5]);
    res.json({ success: true, round: r.rows[0] });
  } catch (e) { next(e); }
});

R.post('/admin/lottery/force-draw', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const r = await query(`SELECT id FROM weekly_lottery_rounds WHERE status='open' ORDER BY round_number DESC LIMIT 1`);
    if (!r.rowCount) return res.status(404).json({ success: false, error: 'NO_OPEN_ROUND' });
    const result = await drawWeeklyLottery(r.rows[0].id);
    res.json({ success: true, ...result });
  } catch (e) { next(e); }
});

R.get('/admin/games/:game/config', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const game = req.params.game;
    const edgeR = await query(`SELECT value FROM platform_settings WHERE key='per_game_edge'`);
    const limitR = await query(`SELECT * FROM game_limits WHERE game=$1`, [game]);
    const poolR = await query(`SELECT * FROM game_pools WHERE game=$1`, [game]);
    res.json({ success: true, game,
      edges: edgeR.rows[0]?.value?.[game] || {},
      limit: limitR.rows[0] || null,
      pool: poolR.rows[0] || { current_pool: 0 },
    });
  } catch (e) { next(e); }
});

R.put('/admin/games/:game/edge', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const game = req.params.game;
    const { package: pkg, edge } = req.body;
    if (!pkg || typeof edge !== 'number' || edge < 0 || edge > 1)
      return res.status(400).json({ success: false, error: 'INVALID_INPUT' });
    const before = await query(`SELECT value FROM platform_settings WHERE key='per_game_edge'`);
    const cfg = before.rows[0]?.value || {};
    if (!cfg[game]) cfg[game] = {};
    cfg[game][pkg] = edge;
    await query(`UPDATE platform_settings SET value=$1, updated_at=NOW() WHERE key='per_game_edge'`, [JSON.stringify(cfg)]);
    invalidateSetting('per_game_edge');
    await writeAudit({
      adminId: (req as any).user.id, adminEmail: (req as any).user.email,
      action: 'game.edge_update', targetType: 'game', targetId: null,
      before: before.rows[0]?.value, after: cfg,
      ip: req.ip, ua: req.header('user-agent') || '',
    });
    res.json({ success: true, config: cfg });
  } catch (e) { next(e); }
});

R.put('/admin/games/:game/limits', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const game = req.params.game;
    const { min_bet, max_bet, jackpot_pct } = req.body;
    const r = await query(
      `UPDATE game_limits SET
         min_bet = COALESCE($1, min_bet),
         max_bet = COALESCE($2, max_bet),
         jackpot_pct = COALESCE($3, jackpot_pct),
         updated_at = NOW()
       WHERE game=$4 RETURNING *`,
      [min_bet ?? null, max_bet ?? null, jackpot_pct ?? null, game]);
    res.json({ success: true, limit: r.rows[0] });
  } catch (e) { next(e); }
});

R.get('/admin/pools', authMiddleware, adminMiddleware, async (_req, res, next) => {
  try {
    const r = await query(`SELECT * FROM game_pools ORDER BY game`);
    res.json({ success: true, pools: r.rows });
  } catch (e) { next(e); }
});

R.post('/admin/pools/:game/reset', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const before = await query(`SELECT * FROM game_pools WHERE game=$1`, [req.params.game]);
    const r = await query(`UPDATE game_pools SET current_pool=0, updated_at=NOW() WHERE game=$1 RETURNING *`, [req.params.game]);
    await writeAudit({
      adminId: (req as any).user.id, adminEmail: (req as any).user.email,
      action: 'pool.reset', targetType: 'pool', targetId: null,
      before: before.rows[0], after: r.rows[0],
      ip: req.ip, ua: req.header('user-agent') || '',
    });
    res.json({ success: true, pool: r.rows[0] });
  } catch (e) { next(e); }
});

R.post('/admin/notifications/broadcast', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const { title, body, type = 'info', category = 'general' } = req.body;
    if (!title || !body)
      return res.status(400).json({ success: false, error: 'MISSING_FIELDS' });
    await query(
      `INSERT INTO notifications (user_id,title,body,type,category)
       VALUES (NULL,$1,$2,$3,$4)`,
      [title, body, type, category]);
    await writeAudit({
      adminId: (req as any).user.id, adminEmail: (req as any).user.email,
      action: 'notifications.broadcast', targetType: 'notification', targetId: null,
      before: null, after: { title, body, type, category },
      ip: req.ip, ua: req.header('user-agent') || '',
    });
    res.json({ success: true });
  } catch (e) { next(e); }
});

R.post('/admin/deposit/refresh', authMiddleware, adminMiddleware, async (_req, res, next) => {
  try { res.json({ success: true, refreshed: await refreshPendingDeposits() }); }
  catch (e) { next(e); }
});

R.post('/admin/deposit/verify', authMiddleware, adminMiddleware, async (req, res, next) => {
  try {
    const { txHash, userId } = req.body;
    const r = await createDepositIntent(userId, txHash);
    res.json({ success: true, deposit: r });
  } catch (e: any) { if (e.status) return res.status(e.status).json({ success: false, error: e.message }); next(e); }
});

// ---------- ERROR HANDLER ----------
R.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err.issues) return res.status(400).json({ success: false, error: 'VALIDATION_ERROR', issues: err.issues });
  if (err.code === '23514') return res.status(400).json({ success: false, error: 'BUSINESS_RULE_VIOLATION' });
  if (err.code === '23505') return res.status(409).json({ success: false, error: 'DUPLICATE_ENTRY' });
  if (err.status) return res.status(err.status).json({ success: false, error: err.message });
  logger.error({ err }, 'Unhandled');
  res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR',
    ...(ENV.NODE_ENV !== 'production' && { stack: err.stack }) });
});

app.use('/api/v1', R);

// =========================================================================
//  SECTION 21: CRON WORKERS
// =========================================================================
const dailyAirdrop = async () => {
  try {
    await withTransaction(async (c) => {
      const r = await c.query(
        `SELECT id FROM users WHERE status='active' AND package <> 'none'
           AND NOT EXISTS (SELECT 1 FROM airdrops WHERE user_id=users.id
                           AND reason='daily_random'
                           AND created_at >= NOW() - INTERVAL '30 days')
         ORDER BY RANDOM() LIMIT 1`);
      if (!r.rowCount) return;
      const uid = r.rows[0].id;
      const tx = await c.query(
        `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
         VALUES ($1,'airdrop',5,'confirmed',$2,FALSE) RETURNING id`,
        [uid, JSON.stringify({ reason: 'daily_random' })]);
      await c.query(
        `INSERT INTO airdrops (user_id,amount_usdt,reason,tx_id)
         VALUES ($1,5,'daily_random',$2)`, [uid, tx.rows[0].id]);
      await c.query(
        `INSERT INTO notifications (user_id,title,body,type,category)
         VALUES ($1,'Daily Airdrop','You won 5 USDT!','success','airdrop')`, [uid]);
      logger.info({ uid }, '🎁 Daily airdrop sent');
    });
  } catch (e) { logger.error({ e }, 'dailyAirdrop failed'); }
};

const leaderboardSnapshot = async () => {
  try {
    await withTransaction(async (c) => {
      const top = await c.query(
        `SELECT id,email,username,active_ref_count FROM users
         WHERE status='active' AND active_ref_count > 0
         ORDER BY active_ref_count DESC LIMIT 10`);
      if (!top.rowCount) return;
      const rewards: Record<number, number> = { 1: 50, 2: 30, 3: 20 };
      const rankings = top.rows.map((u, i) => ({
        user_id: u.id, rank: i + 1, count: u.active_ref_count,
        reward: rewards[i + 1] || 0,
      }));
      for (const r of rankings) {
        if (!r.reward) continue;
        await c.query(
          `INSERT INTO transactions (user_id,type,amount_usdt,status,meta,is_demo)
           VALUES ($1,'leaderboard_reward',$2,'confirmed',$3,FALSE)`,
          [r.user_id, r.reward, JSON.stringify({ rank: r.rank, count: r.count })]);
        await c.query(
          `INSERT INTO notifications (user_id,title,body,type,category)
           VALUES ($1,'Leaderboard Reward',$2,'success','leaderboard')`,
          [r.user_id, `Rank #${r.rank} — ${r.reward} USDT`]);
      }
      const now = new Date();
      const start = new Date(now.getTime() - 7 * 86_400_000);
      await c.query(
        `INSERT INTO leaderboard_snapshots
           (period_type,period_start,period_end,rankings,distributed)
         VALUES ('weekly',$1,$2,$3,TRUE)`,
        [start, now, JSON.stringify(rankings)]);
      logger.info({ winners: rankings.filter((r) => r.reward).length }, '🏆 Leaderboard snapshot');
    });
  } catch (e) { logger.error({ e }, 'leaderboardSnapshot failed'); }
};

const autoCloseCompetitions = async () => {
  const r = await query(
    `UPDATE competitions SET status='awaiting_draw'
     WHERE status='open' AND end_at <= NOW() RETURNING id`);
  if (r.rowCount) logger.info({ count: r.rowCount }, '⏰ Competitions closed');
};

const autoDrawWeeklyLottery = async () => {
  // الآن يدوي - لا سحب تلقائي
  return 0;
};

const cleanupIdempotency = async () => {
  await query(`DELETE FROM idempotency_keys WHERE expires_at < NOW()`);
};

const resetDemoBalances = async () => {
  try {
    const dm = await getDemoMode();
    if (!dm.enabled) return;
    const r = await query(
      `UPDATE users SET demo_balance=$1, last_demo_reset=NOW()
       WHERE last_demo_reset IS NULL
          OR last_demo_reset < NOW() - ($2 || ' hours')::interval
       RETURNING id`,
      [dm.starting_balance, String(dm.reset_hours || 24)]);
    if (r.rowCount) logger.info({ count: r.rowCount }, '🎮 Demo balances reset');
  } catch (e) { logger.error({ e }, 'resetDemoBalances failed'); }
};

cron.schedule('0 0 * * *', dailyAirdrop, { timezone: 'UTC' });
cron.schedule('5 0 * * 1', leaderboardSnapshot, { timezone: 'UTC' });
cron.schedule('* * * * *', async () => {
  try {
    await settleExpiredMarkets();
    await autoCloseCompetitions();
  } catch (e) { logger.error({ e }, 'cron tick failed'); }
});
cron.schedule('*/2 * * * *', async () => {
  try { await refreshPendingDeposits(); }
  catch (e) { logger.error({ e }, 'deposit refresh failed'); }
});
cron.schedule('0 * * * *', async () => {
  try { await cleanupIdempotency(); await resetDemoBalances(); }
  catch (e) { logger.error({ e }, 'hourly cron failed'); }
});

// =========================================================================
//  SECTION 22: BOOTSTRAP
// =========================================================================
const start = async () => {
  try {
    await query('SELECT NOW()');
    logger.info('✅ Database connected');
    const server = app.listen(ENV.PORT, () =>
      logger.info(`🚀 Server on :${ENV.PORT} [${ENV.NODE_ENV}]`));
    const shutdown = async (s: string) => {
      logger.warn(`${s} received`);
      server.close(async () => { await pool.end(); process.exit(0); });
      setTimeout(() => process.exit(1), 10_000);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
  } catch (e) { logger.error({ e }, 'Startup failed'); process.exit(1); }
};

start();

// =========================================================
//  END OF backend.ts
// =========================================================
