-- =========================================================================
--  Migration 002 — Progressive Jackpots + Per-Game Edges + Admin Lottery
-- =========================================================================

-- 1. جدول أحواض الجوائز التراكمية
CREATE TABLE IF NOT EXISTS game_pools (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  game              VARCHAR(30) UNIQUE NOT NULL,
  current_pool      NUMERIC(18,8) NOT NULL DEFAULT 0,
  total_contributed NUMERIC(18,8) NOT NULL DEFAULT 0,
  total_paid_out    NUMERIC(18,8) NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_pool_nn CHECK (current_pool >= 0)
);

INSERT INTO game_pools (game) VALUES ('dice'), ('boxes'), ('wheel')
ON CONFLICT (game) DO NOTHING;

-- 2. حدود الرهان لكل لعبة
CREATE TABLE IF NOT EXISTS game_limits (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  game              VARCHAR(30) UNIQUE NOT NULL,
  min_bet           NUMERIC(18,8) NOT NULL DEFAULT 0.5,
  max_bet           NUMERIC(18,8) NOT NULL DEFAULT 100,
  jackpot_pct       NUMERIC(5,4) NOT NULL DEFAULT 0.02,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO game_limits (game, min_bet, max_bet, jackpot_pct) VALUES 
  ('dice',  0.5, 100, 0.02),
  ('boxes', 1.0, 50,  0.05),
  ('wheel', 1.0, 10,  0.03)
ON CONFLICT (game) DO NOTHING;

-- 3. House Edge لكل لعبة لكل باقة
INSERT INTO platform_settings (key, value) VALUES
  ('per_game_edge',
   '{
      "dice":       {"none":0.15,"p1_5":0.12,"p2_10":0.10,"p3_20":0.08,"p4_50":0.06},
      "boxes":      {"none":0.25,"p1_5":0.22,"p2_10":0.20,"p3_20":0.18,"p4_50":0.15},
      "wheel":      {"none":0.20,"p1_5":0.18,"p2_10":0.16,"p3_20":0.14,"p4_50":0.12},
      "prediction": {"none":0.10,"p1_5":0.09,"p2_10":0.08,"p3_20":0.07,"p4_50":0.05}
    }'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

-- 4. عجلة الحظ الجديدة (10 قطاعات + JACKPOT)
INSERT INTO platform_settings (key, value) VALUES
  ('bonus_wheel',
   '{
      "min_bet": 1,
      "max_bet": 10,
      "free_spin_value": 1,
      "cooldown_hours": 24,
      "segments": [
        {"label":"0.1x",   "multiplier":0.001, "weight":50,  "color":"#242433"},
        {"label":"1x",     "multiplier":0.01,  "weight":20,  "color":"#1a1a26"},
        {"label":"5x",     "multiplier":0.05,  "weight":12,  "color":"#3b82f6"},
        {"label":"10x",    "multiplier":0.10,  "weight":8,   "color":"#06b6d4"},
        {"label":"25x",    "multiplier":0.25,  "weight":5,   "color":"#22c55e"},
        {"label":"50x",    "multiplier":0.50,  "weight":3,   "color":"#f5b301"},
        {"label":"100x",   "multiplier":1.00,  "weight":1.2, "color":"#f59e0b"},
        {"label":"200x",   "multiplier":2.00,  "weight":0.5, "color":"#ef4444"},
        {"label":"500x",   "multiplier":5.00,  "weight":0.2, "color":"#a855f7"},
        {"label":"JACKPOT","multiplier":0,     "weight":0.1, "color":"#eab308","isJackpot":true}
      ]
    }'::jsonb)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

-- 5. تعديل جدول اليانصيب
ALTER TABLE weekly_lottery_rounds
  ADD COLUMN IF NOT EXISTS is_admin_controlled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS current_prize_pool NUMERIC(18,8) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_sales NUMERIC(18,8) DEFAULT 0;

-- 6. فهارس
CREATE INDEX IF NOT EXISTS idx_pools_game ON game_pools(game);
CREATE INDEX IF NOT EXISTS idx_limits_game ON game_limits(game);

-- 7. Triggers
DROP TRIGGER IF EXISTS trg_pool_updated ON game_pools;
CREATE TRIGGER trg_pool_updated BEFORE UPDATE ON game_pools
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS trg_limits_updated ON game_limits;
CREATE TRIGGER trg_limits_updated BEFORE UPDATE ON game_limits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =========================================================================
--  END OF MIGRATION 002
-- =========================================================================
