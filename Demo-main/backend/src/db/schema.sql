-- =========================================================================
--  schema.sql — COMPLETE FINAL DATABASE SCHEMA
--  PostgreSQL 14+
-- =========================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==================== ENUMS ====================
CREATE TYPE user_status        AS ENUM ('unverified','active','banned');
CREATE TYPE package_level      AS ENUM ('none','p1_5','p2_10','p3_20','p4_50');
CREATE TYPE tx_type            AS ENUM (
  'deposit','withdrawal','referral_l1','referral_l2','referral_activity',
  'bet_win','bet_loss','airdrop','leaderboard_reward','admin_credit',
  'admin_debit','competition_win','competition_entry','bonus_wheel',
  'platform_fee','mission_reward','streak_reward','lottery_ticket','lottery_win');
CREATE TYPE tx_status          AS ENUM ('pending','confirmed','failed','rejected');
CREATE TYPE deposit_status     AS ENUM ('pending','confirming','confirmed','rejected');
CREATE TYPE competition_status AS ENUM ('open','awaiting_draw','completed','cancelled');
CREATE TYPE bet_game           AS ENUM ('dice','mystery_box','prediction','bonus_wheel');
CREATE TYPE bet_status         AS ENUM ('pending','won','lost','refunded');
CREATE TYPE prediction_side    AS ENUM ('up','down');
CREATE TYPE notification_type  AS ENUM ('info','warning','success');
CREATE TYPE prediction_status  AS ENUM ('open','closed','settled','cancelled');
CREATE TYPE mission_kind       AS ENUM ('bets_count','wager_amount','referral_share','login');

-- ==================== USERS ====================
CREATE TABLE users (
  id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email                    VARCHAR(255) UNIQUE NOT NULL,
  password_hash            VARCHAR(255) NOT NULL,
  username                 VARCHAR(50) UNIQUE,
  referral_code            VARCHAR(20) UNIQUE NOT NULL,
  referred_by              UUID REFERENCES users(id) ON DELETE SET NULL,
  referrer_pkg_snapshot    package_level NOT NULL DEFAULT 'none',
  referrer_activity_pct    NUMERIC(5,4) NOT NULL DEFAULT 0,
  package                  package_level NOT NULL DEFAULT 'none',
  status                   user_status NOT NULL DEFAULT 'unverified',
  balance                  NUMERIC(18,8) NOT NULL DEFAULT 0,
  demo_balance             NUMERIC(18,8) NOT NULL DEFAULT 1000,
  last_demo_reset          TIMESTAMPTZ,
  total_deposited          NUMERIC(18,8) NOT NULL DEFAULT 0,
  total_withdrawn          NUMERIC(18,8) NOT NULL DEFAULT 0,
  total_wagered            NUMERIC(18,8) NOT NULL DEFAULT 0,
  active_ref_count         INT NOT NULL DEFAULT 0,
  wallet_address           VARCHAR(64),
  xp                       INT NOT NULL DEFAULT 0,
  level                    INT NOT NULL DEFAULT 1,
  streak_count             INT NOT NULL DEFAULT 0,
  last_login_date          DATE,
  last_login_at            TIMESTAMPTZ,
  last_bonus_spin          TIMESTAMPTZ,
  daily_withdrawn_total    NUMERIC(18,8) NOT NULL DEFAULT 0,
  monthly_withdrawn_total  NUMERIC(18,8) NOT NULL DEFAULT 0,
  daily_withdrawn_date     DATE,
  monthly_withdrawn_month  VARCHAR(7),
  wager_locked_until       TIMESTAMPTZ,
  totp_secret              VARCHAR(64),
  is_demo_verified         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_users_balance_nn    CHECK (balance >= 0),
  CONSTRAINT chk_users_demo_nn       CHECK (demo_balance >= 0),
  CONSTRAINT chk_users_deposited_nn  CHECK (total_deposited >= 0),
  CONSTRAINT chk_users_withdrawn_nn  CHECK (total_withdrawn >= 0),
  CONSTRAINT chk_users_refcnt_nn     CHECK (active_ref_count >= 0),
  CONSTRAINT chk_users_streak_nn     CHECK (streak_count >= 0)
);

CREATE INDEX idx_users_ref_code  ON users(referral_code);
CREATE INDEX idx_users_referred  ON users(referred_by);
CREATE INDEX idx_users_status    ON users(status);
CREATE INDEX idx_users_package   ON users(package);

-- ==================== SUBSCRIPTIONS ====================
CREATE TABLE subscriptions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  package        package_level NOT NULL,
  amount_usdt    NUMERIC(18,8) NOT NULL CHECK (amount_usdt > 0),
  tx_hash        VARCHAR(80) UNIQUE NOT NULL,
  from_address   VARCHAR(64) NOT NULL,
  to_address     VARCHAR(64) NOT NULL,
  chain_id       INT NOT NULL DEFAULT 56,
  is_upgrade     BOOLEAN NOT NULL DEFAULT FALSE,
  previous_pkg   package_level,
  confirmed      BOOLEAN NOT NULL DEFAULT FALSE,
  block_number   BIGINT,
  purchased_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_subs_user   ON subscriptions(user_id);
CREATE INDEX idx_subs_txhash ON subscriptions(tx_hash);

-- ==================== REFERRAL COMMISSIONS ====================
CREATE TABLE referral_commissions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  earner_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  kind            VARCHAR(20) NOT NULL CHECK (kind IN ('subscription','activity')),
  level           SMALLINT NOT NULL CHECK (level IN (1,2)),
  rate            NUMERIC(5,4) NOT NULL CHECK (rate BETWEEN 0 AND 1),
  base_amount     NUMERIC(18,8) NOT NULL,
  amount_usdt     NUMERIC(18,8) NOT NULL CHECK (amount_usdt >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_refcom_earner         ON referral_commissions(earner_id);
CREATE INDEX idx_refcom_source         ON referral_commissions(source_user_id);
CREATE INDEX idx_refcom_earner_created ON referral_commissions(earner_id, created_at DESC);
CREATE INDEX idx_refcom_earner_kind    ON referral_commissions(earner_id, kind, level);
CREATE INDEX idx_refcom_earner_kind_created
  ON referral_commissions(earner_id, kind, level, created_at DESC);

-- ==================== TRANSACTIONS (LEDGER) ====================
CREATE TABLE transactions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type           tx_type NOT NULL,
  amount_usdt    NUMERIC(18,8) NOT NULL CHECK (amount_usdt >= 0),
  fee_usdt       NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (fee_usdt >= 0),
  status         tx_status NOT NULL DEFAULT 'pending',
  tx_hash        VARCHAR(80),
  from_address   VARCHAR(64),
  to_address     VARCHAR(64),
  reference_id   UUID,
  meta           JSONB DEFAULT '{}'::jsonb,
  admin_note     TEXT,
  processed_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  is_demo        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tx_user              ON transactions(user_id);
CREATE INDEX idx_tx_type              ON transactions(type);
CREATE INDEX idx_tx_status            ON transactions(status);
CREATE INDEX idx_tx_hash              ON transactions(tx_hash);
CREATE INDEX idx_tx_user_created_desc ON transactions(user_id, created_at DESC);
CREATE INDEX idx_tx_user_demo_created ON transactions(user_id, is_demo, created_at DESC);
CREATE INDEX idx_tx_pending_wd
  ON transactions(type, status, created_at DESC)
  WHERE type='withdrawal' AND status='pending';
CREATE UNIQUE INDEX uq_deposit_hash
  ON transactions(tx_hash)
  WHERE type='deposit' AND tx_hash IS NOT NULL;

-- ==================== DEPOSITS ====================
CREATE TABLE deposits (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tx_hash         VARCHAR(80) UNIQUE NOT NULL,
  from_address    VARCHAR(64),
  to_address      VARCHAR(64),
  amount_usdt     NUMERIC(18,8) NOT NULL DEFAULT 0,
  chain_id        INT NOT NULL DEFAULT 56,
  status          deposit_status NOT NULL DEFAULT 'pending',
  confirmations   INT NOT NULL DEFAULT 0,
  block_number    BIGINT,
  error_reason    TEXT,
  raw_meta        JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at    TIMESTAMPTZ
);
CREATE INDEX idx_deposits_user          ON deposits(user_id);
CREATE INDEX idx_deposits_status        ON deposits(status);
CREATE INDEX idx_deposits_user_created  ON deposits(user_id, created_at DESC);
CREATE INDEX idx_deposits_pending       ON deposits(status, created_at)
  WHERE status IN ('pending','confirming');

-- ==================== IDEMPOTENCY KEYS ====================
CREATE TABLE idempotency_keys (
  key          VARCHAR(120) PRIMARY KEY,
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  endpoint     VARCHAR(200) NOT NULL,
  request_hash VARCHAR(64) NOT NULL,
  response     JSONB,
  status_code  INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);
CREATE INDEX idx_idem_user    ON idempotency_keys(user_id);
CREATE INDEX idx_idem_expires ON idempotency_keys(expires_at);

-- ==================== COMPETITIONS + TICKETS ====================
CREATE TABLE competitions (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title              VARCHAR(150) NOT NULL,
  description        TEXT,
  ticket_price       NUMERIC(18,8) NOT NULL CHECK (ticket_price > 0),
  max_tickets        INT NOT NULL CHECK (max_tickets > 0),
  tickets_sold       INT NOT NULL DEFAULT 0 CHECK (tickets_sold >= 0),
  prize_distribution JSONB NOT NULL,
  platform_fee_pct   NUMERIC(5,4) NOT NULL DEFAULT 0.20,
  start_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_at             TIMESTAMPTZ NOT NULL,
  status             competition_status NOT NULL DEFAULT 'open',
  winning_ticket     INT,
  winners            JSONB,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_comp_status ON competitions(status);
CREATE INDEX idx_comp_end    ON competitions(end_at);

CREATE TABLE tickets (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  competition_id UUID NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_number  INT NOT NULL,
  paid_amount    NUMERIC(18,8) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (competition_id, ticket_number)
);
CREATE INDEX idx_tickets_comp         ON tickets(competition_id);
CREATE INDEX idx_tickets_user_created ON tickets(user_id, created_at DESC);

-- ==================== WEEKLY LOTTERY ====================
CREATE TABLE weekly_lottery_rounds (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  round_number    INT NOT NULL UNIQUE,
  start_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_at          TIMESTAMPTZ NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','drawing','completed','cancelled')),
  ticket_price    NUMERIC(18,8) NOT NULL DEFAULT 5,
  tickets_sold    INT NOT NULL DEFAULT 0,
  gross_pool      NUMERIC(18,8) NOT NULL DEFAULT 0,
  prize_pool      NUMERIC(18,8) NOT NULL DEFAULT 0,
  platform_cut    NUMERIC(18,8) NOT NULL DEFAULT 0,
  winner_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  winning_ticket  INT,
  drawn_at        TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_wlr_status ON weekly_lottery_rounds(status, end_at);

CREATE TABLE weekly_lottery_tickets (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  round_id      UUID NOT NULL REFERENCES weekly_lottery_rounds(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_number INT NOT NULL,
  paid_amount   NUMERIC(18,8) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (round_id, ticket_number)
);
CREATE INDEX idx_wlt_round        ON weekly_lottery_tickets(round_id);
CREATE INDEX idx_wlt_user_created ON weekly_lottery_tickets(user_id, created_at DESC);
CREATE INDEX idx_wlt_round_user   ON weekly_lottery_tickets(round_id, user_id);

-- ==================== CASINO BETS ====================
CREATE TABLE casino_bets (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game              bet_game NOT NULL,
  bet_amount        NUMERIC(18,8) NOT NULL CHECK (bet_amount >= 0),
  payout            NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (payout >= 0),
  house_edge        NUMERIC(5,4) NOT NULL DEFAULT 0,
  status            bet_status NOT NULL DEFAULT 'pending',
  server_seed_hash  VARCHAR(128) NOT NULL,
  client_seed       VARCHAR(128) NOT NULL,
  nonce             BIGINT NOT NULL DEFAULT 0,
  result_value      NUMERIC(18,8),
  payload           JSONB DEFAULT '{}'::jsonb,
  is_demo           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at        TIMESTAMPTZ
);
CREATE INDEX idx_bets_user              ON casino_bets(user_id);
CREATE INDEX idx_bets_game              ON casino_bets(game);
CREATE INDEX idx_bets_user_created_desc ON casino_bets(user_id, created_at DESC);
CREATE INDEX idx_bets_user_demo_created ON casino_bets(user_id, is_demo, created_at DESC);
CREATE INDEX idx_bets_game_created      ON casino_bets(game, created_at DESC);

-- ==================== MYSTERY BOXES ====================
CREATE TABLE mystery_boxes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL,
  price_usdt  NUMERIC(18,8) NOT NULL CHECK (price_usdt > 0),
  image_url   TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  odds        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE mystery_box_purchases (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  box_id        UUID NOT NULL REFERENCES mystery_boxes(id) ON DELETE RESTRICT,
  bet_id        UUID REFERENCES casino_bets(id) ON DELETE SET NULL,
  paid_amount   NUMERIC(18,8) NOT NULL,
  prize_label   VARCHAR(50),
  prize_amount  NUMERIC(18,8) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_mbp_user         ON mystery_box_purchases(user_id);
CREATE INDEX idx_mbp_user_created ON mystery_box_purchases(user_id, created_at DESC);

-- ==================== USER SEEDS ====================
CREATE TABLE user_seeds (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_seed       VARCHAR(128) NOT NULL,
  server_seed_hash  VARCHAR(128) NOT NULL,
  client_seed       VARCHAR(128) NOT NULL,
  nonce             BIGINT NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  rotated_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_user_active_seed ON user_seeds(user_id) WHERE is_active = TRUE;
CREATE INDEX idx_seeds_user ON user_seeds(user_id);

-- ==================== PREDICTION ====================
CREATE TABLE prediction_markets (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  symbol            VARCHAR(20) NOT NULL,
  duration_seconds  INT NOT NULL,
  open_price        NUMERIC(18,8),
  close_price       NUMERIC(18,8),
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closes_at         TIMESTAMPTZ NOT NULL,
  settled_at        TIMESTAMPTZ,
  status            prediction_status NOT NULL DEFAULT 'open',
  total_up          NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (total_up >= 0),
  total_down        NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (total_down >= 0),
  house_edge        NUMERIC(5,4) NOT NULL DEFAULT 0.10,
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_pred_market_status ON prediction_markets(status, closes_at);

CREATE TABLE prediction_bets (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  market_id   UUID NOT NULL REFERENCES prediction_markets(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  side        prediction_side NOT NULL,
  amount      NUMERIC(18,8) NOT NULL CHECK (amount > 0),
  payout      NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (payout >= 0),
  status      bet_status NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_pred_bet_market        ON prediction_bets(market_id);
CREATE INDEX idx_pred_bet_user_created  ON prediction_bets(user_id, created_at DESC);
CREATE INDEX idx_pred_bet_market_status ON prediction_bets(market_id, status);

-- ==================== BONUS WHEEL ====================
CREATE TABLE bonus_wheel_spins (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  segment_index  INT NOT NULL,
  prize_amount   NUMERIC(18,8) NOT NULL CHECK (prize_amount >= 0),
  tx_id          UUID REFERENCES transactions(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_bws_user_created ON bonus_wheel_spins(user_id, created_at DESC);

-- ==================== MISSIONS ====================
CREATE TABLE missions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key            VARCHAR(50) UNIQUE NOT NULL,
  title          VARCHAR(120) NOT NULL,
  description    TEXT NOT NULL,
  kind           mission_kind NOT NULL,
  target_count   INT NOT NULL DEFAULT 1,
  reward_usdt    NUMERIC(18,8) NOT NULL DEFAULT 0,
  reward_xp      INT NOT NULL DEFAULT 0,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order     INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_missions (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mission_id     UUID NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  progress       INT NOT NULL DEFAULT 0,
  day            DATE NOT NULL DEFAULT CURRENT_DATE,
  completed_at   TIMESTAMPTZ,
  claimed_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, mission_id, day)
);
CREATE INDEX idx_um_user_day  ON user_missions(user_id, day);
CREATE INDEX idx_um_claimable ON user_missions(user_id, completed_at)
  WHERE completed_at IS NOT NULL AND claimed_at IS NULL;

INSERT INTO missions (key, title, description, kind, target_count, reward_usdt, reward_xp, sort_order) VALUES
  ('daily_login',    'Daily Login',    'Log in today to claim your reward',  'login',          1,  0.02, 5,  1),
  ('bets_3',         'Place 3 Bets',   'Place any 3 bets across games',      'bets_count',     3,  0.05, 10, 2),
  ('wager_10',       'Wager 10 USDT',  'Wager a total of 10 USDT today',     'wager_amount',   10, 0.10, 15, 3),
  ('share_referral', 'Share Referral', 'Copy and share your referral link',  'referral_share', 1,  0.03, 5,  4)
ON CONFLICT (key) DO NOTHING;

-- ==================== NOTIFICATIONS ====================
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  title       VARCHAR(150) NOT NULL,
  body        TEXT NOT NULL,
  type        notification_type NOT NULL DEFAULT 'info',
  category    VARCHAR(40) NOT NULL DEFAULT 'general',
  link        VARCHAR(200),
  is_read     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_notif_user         ON notifications(user_id);
CREATE INDEX idx_notif_user_created ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notif_unread       ON notifications(user_id, is_read) WHERE is_read = FALSE;

-- ==================== AIRDROPS ====================
CREATE TABLE airdrops (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_usdt  NUMERIC(18,8) NOT NULL,
  reason       VARCHAR(100) NOT NULL,
  tx_id        UUID REFERENCES transactions(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_airdrops_user         ON airdrops(user_id);
CREATE INDEX idx_airdrops_user_created ON airdrops(user_id, created_at DESC);
CREATE INDEX idx_airdrops_reason       ON airdrops(reason, created_at DESC);

-- ==================== LEADERBOARD ====================
CREATE TABLE leaderboard_snapshots (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  period_type    VARCHAR(20) NOT NULL DEFAULT 'weekly',
  period_start   TIMESTAMPTZ NOT NULL,
  period_end     TIMESTAMPTZ NOT NULL,
  rankings       JSONB NOT NULL,
  distributed    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_lb_period ON leaderboard_snapshots(period_type, period_start DESC);

-- ==================== AUDIT LOG ====================
CREATE TABLE audit_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  admin_email     VARCHAR(255),
  action          VARCHAR(80) NOT NULL,
  target_type     VARCHAR(40),
  target_id       UUID,
  before_state    JSONB,
  after_state     JSONB,
  ip_address      VARCHAR(45),
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_created       ON audit_log(created_at DESC);
CREATE INDEX idx_audit_admin_created ON audit_log(admin_id, created_at DESC);
CREATE INDEX idx_audit_action        ON audit_log(action, created_at DESC);
CREATE INDEX idx_audit_target        ON audit_log(target_type, target_id);

-- ==================== FAQ ====================
CREATE TABLE faq_entries (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  category    VARCHAR(40) NOT NULL,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO faq_entries (category, question, answer, sort_order) VALUES
  ('provably_fair','How do I verify my dice rolls?','Go to Provably Fair page. Copy your Server Seed Hash, Client Seed, and Nonce. When you rotate the seed, the Server Seed is revealed. Use our built-in verifier to compute HMAC-SHA512(server_seed, client_seed:nonce) and confirm the exact roll you received.',1),
  ('provably_fair','What is Provably Fair?','Every roll uses HMAC-SHA512 with a server_seed that is committed (via SHA-256 hash) BEFORE you bet. This cryptographically guarantees we cannot change outcomes after seeing your bet. When you rotate the seed, the secret is revealed so you can verify.',2),
  ('packages','How do MLM commissions work?','Buy a package ($5, $10, $20, $50). You earn L1 commissions (8%-18%) and L2 (5%) on every referral purchase. Activity bonuses (2.5%-7.5%) apply to L1 wagering. Upgrade to unlock higher rates — full price required, no discount.',3),
  ('packages','Do old referrals use the old rates?','Yes. When each referral joined, your package level was snapshotted. Commissions on their purchases always use that snapshot. New referrals use your CURRENT package level.',4),
  ('withdrawals','Why is my withdrawal blocked?','You need: (1) balance >= 10 USDT, (2) at least 3 active referrals (they paid a package), (3) a valid BEP-20 wallet address. Daily limit: $500. Monthly limit: $5,000. Only one pending withdrawal at a time.',5),
  ('demo','How does Demo Mode work?','Demo Mode gives you 1,000 free DEMO USDT to practice. Demo results do NOT affect your real balance, referrals, missions, or withdrawals. Demo resets every 24 hours. Higher win rates are used in demo to make practice fun.',6),
  ('wallet','Which network should I use?','BSC (Binance Smart Chain) with USDT BEP-20 only. Sending any other token or using another network will result in permanent loss. Always double-check the contract address and recipient.',7);

-- ==================== PLATFORM SETTINGS ====================
CREATE TABLE platform_settings (
  key         VARCHAR(80) PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO platform_settings (key, value) VALUES
  ('admin_wallet','{"address":"0x0000000000000000000000000000000000000000","chain_id":56}'::jsonb),
  ('min_withdrawal','{"amount":10}'::jsonb),
  ('min_active_refs','{"count":3}'::jsonb),
  ('withdrawal_fee','{"pct":0.03,"min":1,"max":10}'::jsonb),
  ('withdrawal_limits','{"daily_max":500,"monthly_max":5000,"min_ticket":10}'::jsonb),
  ('lottery_platform_cut','{"pct":0.15}'::jsonb),
  ('vip_house_edges','{
    "none":  {"dice":0.15,"prediction":0.15,"boxes":0.30},
    "p1_5":  {"dice":0.12,"prediction":0.13,"boxes":0.25},
    "p2_10": {"dice":0.10,"prediction":0.11,"boxes":0.22},
    "p3_20": {"dice":0.08,"prediction":0.09,"boxes":0.20},
    "p4_50": {"dice":0.06,"prediction":0.07,"boxes":0.18}
  }'::jsonb),
  ('package_rates','{
    "none":  {"price":0,  "l1":0,    "l2":0,    "activity":0},
    "p1_5":  {"price":5,  "l1":0.08, "l2":0.05, "activity":0.025},
    "p2_10": {"price":10, "l1":0.10, "l2":0.05, "activity":0.03},
    "p3_20": {"price":20, "l1":0.13, "l2":0.05, "activity":0.05},
    "p4_50": {"price":50, "l1":0.18, "l2":0.05, "activity":0.075}
  }'::jsonb),
  ('bonus_wheel','{
    "cooldown_hours": 24,
    "segments": [
      {"label":"Better luck","prize":0,    "weight":60, "color":"#242433"},
      {"label":"$0.01",      "prize":0.01, "weight":20, "color":"#1a1a26"},
      {"label":"$0.05",      "prize":0.05, "weight":12, "color":"#3b82f6"},
      {"label":"$0.10",      "prize":0.10, "weight":5,  "color":"#22c55e"},
      {"label":"$0.25",      "prize":0.25, "weight":2,  "color":"#f5b301"},
      {"label":"$0.50",      "prize":0.50, "weight":0.7,"color":"#f59e0b"},
      {"label":"$1.00",      "prize":1.00, "weight":0.2,"color":"#ef4444"},
      {"label":"$5.00",      "prize":5.00, "weight":0.1,"color":"#a855f7"}
    ]
  }'::jsonb),
  ('streak_rewards','{"daily":[0.02,0.03,0.05,0.07,0.10,0.15,0.25]}'::jsonb),
  ('games_enabled','{"dice":true,"boxes":true,"prediction":true,"bonus_wheel":true,"lottery":true}'::jsonb),
  ('demo_mode','{"enabled":true,"starting_balance":1000,"reset_hours":24,"house_edge_multiplier":0.4}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ==================== VIEWS ====================
CREATE OR REPLACE VIEW v_daily_ggr AS
SELECT
  DATE(created_at) AS day,
  COUNT(*) FILTER (WHERE status IN ('won','lost')) AS total_bets,
  COALESCE(SUM(bet_amount) FILTER (WHERE status IN ('won','lost')),0) AS total_wagered,
  COALESCE(SUM(payout) FILTER (WHERE status IN ('won','lost')),0) AS total_payout,
  COALESCE(SUM(bet_amount - payout) FILTER (WHERE status IN ('won','lost')),0) AS ggr,
  COUNT(*) FILTER (WHERE status='won') AS wins,
  COUNT(*) FILTER (WHERE status='lost') AS losses
FROM casino_bets
WHERE is_demo = FALSE
GROUP BY DATE(created_at)
ORDER BY day DESC;

-- ==================== TRIGGERS ====================
CREATE OR REPLACE FUNCTION apply_transaction_to_balance()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'confirmed'
     AND (OLD.status IS NULL OR OLD.status <> 'confirmed') THEN
    IF NEW.type IN ('deposit','referral_l1','referral_l2','referral_activity',
                    'bet_win','airdrop','leaderboard_reward','admin_credit',
                    'competition_win','bonus_wheel','mission_reward',
                    'streak_reward','lottery_win') THEN
      UPDATE users SET balance = balance + NEW.amount_usdt, updated_at = NOW()
       WHERE id = NEW.user_id;
    ELSIF NEW.type IN ('withdrawal','bet_loss','admin_debit',
                       'competition_entry','lottery_ticket') THEN
      UPDATE users SET balance = balance - NEW.amount_usdt, updated_at = NOW()
       WHERE id = NEW.user_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_apply_transaction ON transactions;
CREATE TRIGGER trg_apply_transaction
AFTER INSERT OR UPDATE ON transactions
FOR EACH ROW EXECUTE FUNCTION apply_transaction_to_balance();

CREATE OR REPLACE FUNCTION sync_prediction_market_totals()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.side='up' THEN UPDATE prediction_markets SET total_up=total_up+NEW.amount WHERE id=NEW.market_id;
    ELSE UPDATE prediction_markets SET total_down=total_down+NEW.amount WHERE id=NEW.market_id; END IF;
    RETURN NEW;
  ELSIF TG_OP='DELETE' THEN
    IF OLD.side='up' THEN UPDATE prediction_markets SET total_up=GREATEST(total_up-OLD.amount,0) WHERE id=OLD.market_id;
    ELSE UPDATE prediction_markets SET total_down=GREATEST(total_down-OLD.amount,0) WHERE id=OLD.market_id; END IF;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_prediction_totals ON prediction_bets;
CREATE TRIGGER trg_sync_prediction_totals
AFTER INSERT OR DELETE ON prediction_bets
FOR EACH ROW EXECUTE FUNCTION sync_prediction_market_totals();

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at=NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_tx_updated ON transactions;
CREATE TRIGGER trg_tx_updated BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_box_updated ON mystery_boxes;
CREATE TRIGGER trg_box_updated BEFORE UPDATE ON mystery_boxes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_deposits_updated ON deposits;
CREATE TRIGGER trg_deposits_updated BEFORE UPDATE ON deposits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_um_updated ON user_missions;
CREATE TRIGGER trg_um_updated BEFORE UPDATE ON user_missions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION check_withdrawal_counters()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.daily_withdrawn_date IS NULL OR NEW.daily_withdrawn_date < CURRENT_DATE THEN
    NEW.daily_withdrawn_total = 0;
    NEW.daily_withdrawn_date  = CURRENT_DATE;
  END IF;
  IF NEW.monthly_withdrawn_month IS NULL
     OR NEW.monthly_withdrawn_month <> TO_CHAR(CURRENT_DATE, 'YYYY-MM') THEN
    NEW.monthly_withdrawn_total = 0;
    NEW.monthly_withdrawn_month = TO_CHAR(CURRENT_DATE, 'YYYY-MM');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wd_counters ON users;
CREATE TRIGGER trg_wd_counters
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION check_withdrawal_counters();

-- =========================================================
--  END OF FILE 1 (schema.sql)
--  START OF FILE 2 (backend.ts)
-- =========================================================
