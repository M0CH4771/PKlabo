-- コイン機能を追加する前に schema.sql を実行済みのデータベース用（新しく作る場合は不要）
-- 実行したあとに schema.sql をもう一度実行しても問題ありません（足りない表だけ作られます）
--   npx wrangler d1 execute pklabo-db --remote --file=./migrations/001_coins.sql
ALTER TABLE orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE orders ADD COLUMN coins INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN coins INTEGER NOT NULL DEFAULT 0;

CREATE TABLE oripa_draws_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  oripa_id     INTEGER NOT NULL,
  order_id     INTEGER,
  customer_id  INTEGER,
  prize_id     INTEGER NOT NULL,
  is_last_one  INTEGER NOT NULL DEFAULT 0,
  revealed_at  TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO oripa_draws_new (id, oripa_id, order_id, prize_id, is_last_one, revealed_at, created_at)
  SELECT id, oripa_id, order_id, prize_id, is_last_one, revealed_at, created_at FROM oripa_draws;
DROP TABLE oripa_draws;
ALTER TABLE oripa_draws_new RENAME TO oripa_draws;
CREATE INDEX IF NOT EXISTS idx_draws_order ON oripa_draws(order_id);
CREATE INDEX IF NOT EXISTS idx_draws_customer ON oripa_draws(customer_id, order_id);
CREATE INDEX IF NOT EXISTS idx_draws_oripa ON oripa_draws(oripa_id, revealed_at);

-- コイン（オリパ用の前払いポイント）。購入ごとに有効期限つきのロットで管理
CREATE TABLE IF NOT EXISTS coin_lots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER NOT NULL,
  amount       INTEGER NOT NULL,
  remaining    INTEGER NOT NULL,
  paid         INTEGER NOT NULL DEFAULT 1,  -- 1=お金で購入 / 0=無償付与
  expires_at   TEXT,                        -- NULL=期限なし
  order_id     INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_coin_lots ON coin_lots(customer_id, remaining, expires_at);

CREATE TABLE IF NOT EXISTS coin_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER NOT NULL,
  delta        INTEGER NOT NULL,
  reason       TEXT    NOT NULL,
  order_id     INTEGER,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_coin_ledger ON coin_ledger(customer_id, id);
