-- PKlabo EC  D1 スキーマ
-- 適用: npx wrangler d1 execute pklabo-db --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,              -- カード名
  set_name      TEXT    DEFAULT '',            -- 弾・セット名
  card_no       TEXT    DEFAULT '',            -- 型番 (例: 201/165)
  rarity        TEXT    DEFAULT '',            -- SAR / SR / AR など
  condition     TEXT    DEFAULT 'A',           -- 状態 (S / A / B / C / PSA10 など)
  category      TEXT    DEFAULT 'single',      -- single / psa / box / supply
  price         INTEGER NOT NULL,              -- 税込価格(円)
  compare_price INTEGER NOT NULL DEFAULT 0,    -- 値下げ前の価格（>price ならセール表示）
  buy_price     INTEGER NOT NULL DEFAULT 0,    -- 買取価格（>0 なら商品ページに表示）
  stock         INTEGER NOT NULL DEFAULT 0,    -- 在庫数
  image_url     TEXT    DEFAULT '',            -- メイン画像
  images        TEXT    NOT NULL DEFAULT '[]', -- 追加画像 (JSON配列)
  real_photo    INTEGER NOT NULL DEFAULT 0,    -- 1=実物写真
  description   TEXT    DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,    -- 1=公開 0=非公開
  sort          INTEGER NOT NULL DEFAULT 0,
  group_key     TEXT    NOT NULL DEFAULT '',   -- 同じカードの状態違いをまとめるキー
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active, sort, id);
CREATE INDEX IF NOT EXISTS idx_products_group ON products(group_key);
CREATE INDEX IF NOT EXISTS idx_products_card ON products(card_no);

CREATE TABLE IF NOT EXISTS price_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL,
  price       INTEGER NOT NULL,
  at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ph_product ON price_history(product_id, at);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no        TEXT    NOT NULL UNIQUE,   -- 例: PK123456
  token           TEXT    NOT NULL,          -- 注文確認ページ用の秘密トークン
  status          TEXT    NOT NULL,          -- awaiting_payment / paid / shipped / cancelled / expired
  payment_method  TEXT    NOT NULL,          -- bank / card
  shipping_method TEXT    NOT NULL DEFAULT 'delivery', -- delivery / pickup
  customer_id     INTEGER,                   -- 会員の場合
  name            TEXT    NOT NULL,
  kana            TEXT    DEFAULT '',
  email           TEXT    NOT NULL,
  phone           TEXT    NOT NULL,
  zip             TEXT    DEFAULT '',
  address         TEXT    DEFAULT '',
  note            TEXT    DEFAULT '',
  subtotal        INTEGER NOT NULL,
  discount        INTEGER NOT NULL DEFAULT 0,
  coupon_code     TEXT    DEFAULT '',
  points_used     INTEGER NOT NULL DEFAULT 0,
  points_earn     INTEGER NOT NULL DEFAULT 0, -- 付与予定ポイント
  points_granted  INTEGER NOT NULL DEFAULT 0,
  shipping_fee    INTEGER NOT NULL,
  total           INTEGER NOT NULL,
  carrier         TEXT    DEFAULT '',        -- japanpost / yamato / sagawa
  tracking_no     TEXT    DEFAULT '',
  admin_memo      TEXT    DEFAULT '',
  stripe_session  TEXT    DEFAULT '',
  expires_at      TEXT,                      -- 入金期限 (UTC)
  paid_at         TEXT,
  shipped_at      TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL,
  product_id  INTEGER NOT NULL DEFAULT 0,      -- オリパの場合は 0
  oripa_id    INTEGER NOT NULL DEFAULT 0,
  name        TEXT    NOT NULL,              -- 注文時点の商品名スナップショット
  card_no     TEXT    DEFAULT '',
  condition   TEXT    DEFAULT '',
  price       INTEGER NOT NULL,
  qty         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_product ON order_items(product_id);

CREATE TABLE IF NOT EXISTS restock_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL,
  email       TEXT    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  notified_at TEXT,
  UNIQUE(product_id, email)
);

CREATE TABLE IF NOT EXISTS coupons (
  code          TEXT    PRIMARY KEY,         -- 大文字で保存
  type          TEXT    NOT NULL,            -- percent / amount
  value         INTEGER NOT NULL,
  min_subtotal  INTEGER NOT NULL DEFAULT 0,
  max_uses      INTEGER NOT NULL DEFAULT 0,  -- 0=無制限
  used          INTEGER NOT NULL DEFAULT 0,
  ends_at       TEXT,                        -- UTC。NULL=期限なし
  active        INTEGER NOT NULL DEFAULT 1,
  note          TEXT    DEFAULT ''
);

-- R2 を使わない場合の画像置き場
CREATE TABLE IF NOT EXISTS images (
  key           TEXT    PRIMARY KEY,
  content_type  TEXT    NOT NULL,
  data          BLOB    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 管理画面で変更する設定（key='site' に JSON で保存）
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 会員
CREATE TABLE IF NOT EXISTS customers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT    NOT NULL UNIQUE,
  password_hash      TEXT    NOT NULL,
  name               TEXT    NOT NULL,
  kana               TEXT    DEFAULT '',
  phone              TEXT    DEFAULT '',
  zip                TEXT    DEFAULT '',
  address            TEXT    DEFAULT '',
  points             INTEGER NOT NULL DEFAULT 0,
  points_updated_at  TEXT,
  failed_logins      INTEGER NOT NULL DEFAULT 0,
  locked_until       TEXT,
  last_login_at      TEXT,
  email_verified     INTEGER NOT NULL DEFAULT 0,
  phone_e164         TEXT,                 -- SMS認証済みの電話番号（+8190…）。1番号1アカウント
  bonus_granted      INTEGER NOT NULL DEFAULT 0,
  deleted            INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone_e164) WHERE phone_e164 IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  customer_id  INTEGER NOT NULL,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_customer ON sessions(customer_id);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash   TEXT PRIMARY KEY,
  customer_id  INTEGER NOT NULL,
  expires_at   TEXT NOT NULL,
  used         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS point_ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER NOT NULL,
  delta        INTEGER NOT NULL,
  reason       TEXT    NOT NULL,
  order_id     INTEGER,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_customer ON point_ledger(customer_id, id);

-- オリパ
CREATE TABLE IF NOT EXISTS oripas (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT    NOT NULL,
  image_url      TEXT    DEFAULT '',
  description    TEXT    DEFAULT '',
  price          INTEGER NOT NULL,               -- 1口の価格
  total          INTEGER NOT NULL DEFAULT 0,     -- 総口数（ラストワン賞を除く賞品数の合計）
  sold           INTEGER NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL DEFAULT 'draft', -- draft / live / ended
  max_per_order  INTEGER NOT NULL DEFAULT 10,
  starts_at      TEXT,
  ends_at        TEXT,
  sort           INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS oripa_prizes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  oripa_id     INTEGER NOT NULL,
  rank         TEXT    DEFAULT '',     -- S賞 / A賞 など
  name         TEXT    NOT NULL,
  image_url    TEXT    DEFAULT '',
  qty          INTEGER NOT NULL,       -- 封入数
  remaining    INTEGER NOT NULL,
  value        INTEGER NOT NULL DEFAULT 0, -- 参考価格
  is_last_one  INTEGER NOT NULL DEFAULT 0, -- 1=ラストワン賞（最後の1口を引いた人に追加でプレゼント）
  sort         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prizes_oripa ON oripa_prizes(oripa_id);

CREATE TABLE IF NOT EXISTS oripa_draws (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  oripa_id     INTEGER NOT NULL,
  order_id     INTEGER NOT NULL,
  prize_id     INTEGER NOT NULL,
  is_last_one  INTEGER NOT NULL DEFAULT 0,
  revealed_at  TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_draws_order ON oripa_draws(order_id);
CREATE INDEX IF NOT EXISTS idx_draws_oripa ON oripa_draws(oripa_id, revealed_at);

-- メールアドレス確認
CREATE TABLE IF NOT EXISTS email_verifications (
  token_hash   TEXT PRIMARY KEY,
  customer_id  INTEGER NOT NULL,
  expires_at   TEXT NOT NULL
);

-- 回数制限（ログイン失敗・登録・注文など）
CREATE TABLE IF NOT EXISTS rate_limits (
  key       TEXT PRIMARY KEY,
  count     INTEGER NOT NULL,
  reset_at  INTEGER NOT NULL      -- UNIX秒
);

-- 管理画面のログイン（12時間で失効）
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash  TEXT PRIMARY KEY,
  ip          TEXT,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 管理画面の操作履歴
CREATE TABLE IF NOT EXISTS admin_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL DEFAULT (datetime('now')),
  ip      TEXT,
  action  TEXT NOT NULL
);
