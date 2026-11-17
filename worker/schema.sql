-- PKlabo EC  D1 スキーマ
-- 適用: npx wrangler d1 execute pklabo-db --remote --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,              -- カード名
  set_name    TEXT    DEFAULT '',            -- 弾・セット名
  card_no     TEXT    DEFAULT '',            -- 型番 (例: 201/165)
  rarity      TEXT    DEFAULT '',            -- SAR / SR / AR など
  condition   TEXT    DEFAULT 'A',           -- 状態 (S / A / B / C / PSA10 など)
  category    TEXT    DEFAULT 'single',      -- single / psa / box / supply
  price       INTEGER NOT NULL,              -- 税込価格(円)
  stock       INTEGER NOT NULL DEFAULT 0,    -- 在庫数
  image_url   TEXT    DEFAULT '',
  description TEXT    DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1,    -- 1=公開 0=非公開
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active, sort, id);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no        TEXT    NOT NULL UNIQUE,   -- 例: PK2611170001
  token           TEXT    NOT NULL,          -- 注文確認ページ用の秘密トークン
  status          TEXT    NOT NULL,          -- awaiting_payment / paid / shipped / cancelled / expired
  payment_method  TEXT    NOT NULL,          -- bank / card
  name            TEXT    NOT NULL,
  kana            TEXT    DEFAULT '',
  email           TEXT    NOT NULL,
  phone           TEXT    NOT NULL,
  zip             TEXT    NOT NULL,
  address         TEXT    NOT NULL,
  note            TEXT    DEFAULT '',
  subtotal        INTEGER NOT NULL,
  shipping_fee    INTEGER NOT NULL,
  total           INTEGER NOT NULL,
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
  price       INTEGER NOT NULL,
  qty         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
