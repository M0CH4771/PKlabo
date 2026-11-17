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
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active, sort, id);
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

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
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
