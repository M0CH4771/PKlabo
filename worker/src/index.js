// PKlabo EC  Cloudflare Worker (API)
// 画面(GitHub Pages) から呼ばれる API。データは D1 (binding: DB)。

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const STATUSES = ['awaiting_payment', 'paid', 'shipped', 'cancelled', 'expired'];
const STATUS_LABEL = {
  awaiting_payment: '入金待ち',
  paid: '入金確認済み',
  shipped: '発送済み',
  cancelled: 'キャンセル',
  expired: '期限切れ',
};

// ───────────────────────── 共通ユーティリティ ─────────────────────────

function cors(env, req) {
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
  const origin = req.headers.get('Origin') || '';
  const allow = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Key',
    'Vary': 'Origin',
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const int = (v, d = 0) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19); // D1の datetime('now') と同じ形式(UTC)
const addMinutesIso = (min) => new Date(Date.now() + min * 60000).toISOString().replace('T', ' ').slice(0, 19);
const yen = (n) => '¥' + Number(n).toLocaleString('ja-JP');

function shopConfig(env) {
  return {
    shopName: env.SHOP_NAME || 'ポケカ買取ラボ',
    shippingFee: int(env.SHIPPING_FEE, 230),
    freeShippingOver: int(env.FREE_SHIPPING_OVER, 10000),
    paymentDays: int(env.PAYMENT_DAYS, 3),
    cardEnabled: Boolean(env.STRIPE_SECRET_KEY),
    maxQtyPerItem: int(env.MAX_QTY_PER_ITEM, 10),
  };
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function requireAdmin(req, env) {
  const key = req.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_KEY || !timingSafeEqual(key, env.ADMIN_KEY)) throw new HttpError(401, '管理キーが違います');
}

async function readJson(req) {
  try { return await req.json(); } catch { throw new HttpError(400, 'JSONが不正です'); }
}

// ───────────────────────── 商品 ─────────────────────────

const PRODUCT_FIELDS = ['name', 'set_name', 'card_no', 'rarity', 'condition', 'category', 'price', 'stock', 'image_url', 'description', 'active', 'sort'];

function cleanProduct(p) {
  const out = {
    name: str(p.name, 200),
    set_name: str(p.set_name, 200),
    card_no: str(p.card_no, 50),
    rarity: str(p.rarity, 30),
    condition: str(p.condition, 30) || 'A',
    category: str(p.category, 30) || 'single',
    price: Math.max(0, int(p.price)),
    stock: Math.max(0, int(p.stock)),
    image_url: str(p.image_url, 1000),
    description: str(p.description, 3000),
    active: p.active === undefined ? 1 : (p.active === true || p.active === 1 || p.active === '1' || p.active === 'true' ? 1 : 0),
    sort: int(p.sort),
  };
  if (!out.name) throw new HttpError(400, '商品名は必須です');
  if (out.image_url && !/^https?:\/\//.test(out.image_url)) throw new HttpError(400, '画像URLは http(s):// で始めてください');
  return out;
}

async function listPublicProducts(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, set_name, card_no, rarity, condition, category, price, stock, image_url, description
       FROM products WHERE active = 1 ORDER BY sort DESC, id DESC`
  ).all();
  return results;
}

// ───────────────────────── 在庫の確保・解放 ─────────────────────────

// items: [{product_id, qty}]  在庫を確保できなければ全部戻して例外
async function reserveStock(env, items) {
  const stmts = items.map(it =>
    env.DB.prepare('UPDATE products SET stock = stock - ?1, updated_at = datetime(\'now\') WHERE id = ?2 AND active = 1 AND stock >= ?1')
      .bind(it.qty, it.product_id)
  );
  const res = await env.DB.batch(stmts);
  const failed = [];
  const ok = [];
  res.forEach((r, i) => (r.meta.changes === 1 ? ok : failed).push(items[i]));
  if (failed.length) {
    if (ok.length) {
      await env.DB.batch(ok.map(it =>
        env.DB.prepare('UPDATE products SET stock = stock + ?1 WHERE id = ?2').bind(it.qty, it.product_id)
      ));
    }
    const err = new HttpError(409, '在庫が足りない商品があります。カートを確認してください');
    err.failed = failed.map(f => f.product_id);
    throw err;
  }
}

// 注文の在庫を戻してステータス変更（fromStatuses のときだけ）
async function releaseOrder(env, orderId, newStatus, fromStatuses) {
  const placeholders = fromStatuses.map((_, i) => `?${i + 3}`).join(',');
  const upd = await env.DB.prepare(
    `UPDATE orders SET status = ?1 WHERE id = ?2 AND status IN (${placeholders})`
  ).bind(newStatus, orderId, ...fromStatuses).run();
  if (upd.meta.changes !== 1) return false;
  const { results } = await env.DB.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').bind(orderId).all();
  if (results.length) {
    await env.DB.batch(results.map(it =>
      env.DB.prepare('UPDATE products SET stock = stock + ?1, updated_at = datetime(\'now\') WHERE id = ?2').bind(it.qty, it.product_id)
    ));
  }
  return true;
}

async function expireOverdueOrders(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, order_no FROM orders WHERE status = 'awaiting_payment' AND expires_at IS NOT NULL AND expires_at < ?`
  ).bind(nowIso()).all();
  let count = 0;
  for (const o of results) {
    if (await releaseOrder(env, o.id, 'expired', ['awaiting_payment'])) count++;
  }
  return count;
}

// ───────────────────────── 注文 ─────────────────────────

async function newOrderNo(env) {
  for (let i = 0; i < 10; i++) {
    const n = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    const no = 'PK' + n;
    const hit = await env.DB.prepare('SELECT 1 FROM orders WHERE order_no = ?').bind(no).first();
    if (!hit) return no;
  }
  throw new HttpError(500, '注文番号の発行に失敗しました');
}

async function createOrder(req, env) {
  const body = await readJson(req);
  const cfg = shopConfig(env);

  // お客様情報
  const c = body.customer || {};
  const customer = {
    name: str(c.name, 100), kana: str(c.kana, 100), email: str(c.email, 200),
    phone: str(c.phone, 30), zip: str(c.zip, 10), address: str(c.address, 300), note: str(c.note, 1000),
  };
  if (!customer.name || !customer.email || !customer.phone || !customer.zip || !customer.address) {
    throw new HttpError(400, 'お名前・メール・電話番号・郵便番号・住所は必須です');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) throw new HttpError(400, 'メールアドレスの形式が正しくありません');

  const method = body.payment_method === 'card' ? 'card' : 'bank';
  if (method === 'card' && !cfg.cardEnabled) throw new HttpError(400, 'カード決済は現在ご利用いただけません');

  // カート（同じ商品はまとめる）
  const merged = new Map();
  for (const it of Array.isArray(body.items) ? body.items : []) {
    const id = int(it.product_id); const q = int(it.qty);
    if (id > 0 && q > 0) merged.set(id, (merged.get(id) || 0) + q);
  }
  if (!merged.size) throw new HttpError(400, 'カートが空です');
  if (merged.size > 100) throw new HttpError(400, '一度に注文できるのは100種類までです');

  const ids = [...merged.keys()];
  const { results: prods } = await env.DB.prepare(
    `SELECT id, name, price, stock, active FROM products WHERE id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();
  const byId = new Map(prods.map(p => [p.id, p]));

  const items = [];
  for (const [id, qty] of merged) {
    const p = byId.get(id);
    if (!p || !p.active) throw new HttpError(409, '販売終了した商品がカートに含まれています');
    if (qty > cfg.maxQtyPerItem) throw new HttpError(400, `1商品あたり${cfg.maxQtyPerItem}点までです`);
    items.push({ product_id: id, qty, name: p.name, price: p.price });
  }

  // 合計金額は必ずサーバー側で計算する
  const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
  const shipping = subtotal >= cfg.freeShippingOver ? 0 : cfg.shippingFee;
  const total = subtotal + shipping;

  await reserveStock(env, items);

  const orderNo = await newOrderNo(env);
  const token = crypto.randomUUID();
  // 振込: 支払期限(日数)  /  カード: Stripe決済ページの有効期限(30分)+余裕
  const expiresAt = method === 'bank' ? addMinutesIso(cfg.paymentDays * 24 * 60) : addMinutesIso(35);

  try {
    const stmts = [
      env.DB.prepare(
        `INSERT INTO orders (order_no, token, status, payment_method, name, kana, email, phone, zip, address, note,
                             subtotal, shipping_fee, total, expires_at)
         VALUES (?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(orderNo, token, method, customer.name, customer.kana, customer.email, customer.phone, customer.zip,
        customer.address, customer.note, subtotal, shipping, total, expiresAt),
      ...items.map(it => env.DB.prepare(
        `INSERT INTO order_items (order_id, product_id, name, price, qty)
         VALUES ((SELECT id FROM orders WHERE order_no = ?), ?, ?, ?, ?)`
      ).bind(orderNo, it.product_id, it.name, it.price, it.qty)),
    ];
    await env.DB.batch(stmts);
  } catch (e) {
    // 注文登録に失敗したら確保した在庫を戻す
    await env.DB.batch(items.map(it =>
      env.DB.prepare('UPDATE products SET stock = stock + ?1 WHERE id = ?2').bind(it.qty, it.product_id)
    ));
    throw e;
  }

  const order = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(orderNo).first();
  const result = { order_no: orderNo, token, total, payment_method: method };

  if (method === 'card') {
    try {
      const session = await createStripeSession(env, order, items, shipping);
      await env.DB.prepare('UPDATE orders SET stripe_session = ? WHERE id = ?').bind(session.id, order.id).run();
      result.checkout_url = session.url;
    } catch (e) {
      await releaseOrder(env, order.id, 'cancelled', ['awaiting_payment']);
      throw new HttpError(502, 'カード決済ページの作成に失敗しました。時間をおいて再度お試しください');
    }
  } else {
    await sendMail(env, customer.email, `【${cfg.shopName}】ご注文ありがとうございます（${orderNo}）`, orderMailText(env, order, items, 'created'));
  }
  await notifyAdmin(env, `新規注文 ${orderNo}（${method === 'bank' ? '振込' : 'カード'}）${yen(total)} / ${customer.name}`, orderMailText(env, order, items, 'admin'));

  return json(result, 201);
}

async function getOrderPublic(env, orderNo, token) {
  const order = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(orderNo).first();
  if (!order || !token || !timingSafeEqual(token, order.token)) throw new HttpError(404, '注文が見つかりません');
  const { results: items } = await env.DB.prepare('SELECT name, price, qty FROM order_items WHERE order_id = ?').bind(order.id).all();
  const out = {
    order_no: order.order_no, status: order.status, status_label: STATUS_LABEL[order.status],
    payment_method: order.payment_method, name: order.name, zip: order.zip, address: order.address,
    subtotal: order.subtotal, shipping_fee: order.shipping_fee, total: order.total,
    tracking_no: order.tracking_no, expires_at: order.expires_at, created_at: order.created_at, items,
  };
  if (order.payment_method === 'bank' && order.status === 'awaiting_payment') {
    out.bank_info = env.BANK_INFO || '（振込先は管理者が設定してください）';
  }
  return json(out);
}

// ───────────────────────── Stripe ─────────────────────────

function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(v));
  }
  return out.join('&');
}

async function createStripeSession(env, order, items, shipping) {
  const site = (env.SITE_URL || '').replace(/\/$/, '');
  const line_items = items.map(it => ({
    quantity: it.qty,
    price_data: { currency: 'jpy', unit_amount: it.price, product_data: { name: it.name } },
  }));
  if (shipping > 0) {
    line_items.push({ quantity: 1, price_data: { currency: 'jpy', unit_amount: shipping, product_data: { name: '送料' } } });
  }
  const params = {
    mode: 'payment',
    customer_email: order.email,
    client_reference_id: order.order_no,
    metadata: { order_no: order.order_no },
    success_url: `${site}/#/order/${order.order_no}?t=${order.token}`,
    cancel_url: `${site}/#/cart`,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    line_items: Object.fromEntries(line_items.map((li, i) => [i, li])),
  };
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `checkout-${order.order_no}`,
    },
    body: formEncode(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'stripe error');
  return data;
}

async function verifyStripeSignature(payload, header, secret) {
  const parts = Object.fromEntries((header || '').split(',').map(kv => kv.split('=')));
  const t = parts.t; const sig = (header || '').split(',').filter(kv => kv.startsWith('v1=')).map(kv => kv.slice(3));
  if (!t || !sig.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // 5分以上前の署名は拒否
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return sig.some(s => timingSafeEqual(s, hex));
}

async function stripeWebhook(req, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(400, 'webhook not configured');
  const payload = await req.text();
  const ok = await verifyStripeSignature(payload, req.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) throw new HttpError(400, 'invalid signature');
  const event = JSON.parse(payload);
  const session = event.data?.object || {};
  const orderNo = session.metadata?.order_no || session.client_reference_id;
  if (!orderNo) return json({ received: true });
  const order = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(orderNo).first();
  if (!order) return json({ received: true });

  if (event.type === 'checkout.session.completed' && session.payment_status === 'paid') {
    const r = await env.DB.prepare(
      `UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'awaiting_payment'`
    ).bind(order.id).run();
    if (r.meta.changes === 1) {
      const { results: items } = await env.DB.prepare('SELECT name, price, qty FROM order_items WHERE order_id = ?').bind(order.id).all();
      const cfg = shopConfig(env);
      await sendMail(env, order.email, `【${cfg.shopName}】ご注文ありがとうございます（${orderNo}）`, orderMailText(env, { ...order, status: 'paid' }, items, 'paid'));
      await notifyAdmin(env, `カード決済完了 ${orderNo} ${yen(order.total)}`, '');
    }
  } else if (event.type === 'checkout.session.expired') {
    await releaseOrder(env, order.id, 'expired', ['awaiting_payment']);
  }
  return json({ received: true });
}

// ───────────────────────── メール（任意: Resend） ─────────────────────────

function orderMailText(env, order, items, kind) {
  const cfg = shopConfig(env);
  const site = (env.SITE_URL || '').replace(/\/$/, '');
  const lines = items.map(it => `・${it.name}  ${yen(it.price)} × ${it.qty}`).join('\n');
  const url = `${site}/#/order/${order.order_no}?t=${order.token}`;
  const head = {
    created: `${order.name} 様\n\nこの度は${cfg.shopName}をご利用いただきありがとうございます。\n以下の内容でご注文を承りました。`,
    paid: `${order.name} 様\n\nご入金を確認いたしました。発送まで今しばらくお待ちください。`,
    shipped: `${order.name} 様\n\nご注文の商品を発送いたしました。`,
    admin: `新規注文が入りました。`,
  }[kind];
  let body = `${head}\n\n■ 注文番号: ${order.order_no}\n${lines}\n小計: ${yen(order.subtotal)}\n送料: ${yen(order.shipping_fee)}\n合計: ${yen(order.total)}\n`;
  if (kind === 'created' && order.payment_method === 'bank') {
    body += `\n■ お振込先\n${env.BANK_INFO || ''}\n\n※ 振込名義の前に注文番号の数字（${order.order_no.replace('PK', '')}）を入れてください。\n   例) ${order.order_no.replace('PK', '')} ヤマダタロウ\n※ お支払い期限: ご注文から${cfg.paymentDays}日以内。期限を過ぎると自動でキャンセルされます。\n`;
  }
  if (kind === 'shipped' && order.tracking_no) body += `\n■ 追跡番号: ${order.tracking_no}\n`;
  if (kind === 'admin') body += `\nお客様: ${order.name} / ${order.email} / ${order.phone}\n〒${order.zip} ${order.address}\n備考: ${order.note || '-'}\n`;
  else body += `\nご注文状況の確認: ${url}\n\n${cfg.shopName}`;
  return body;
}

async function sendMail(env, to, subject, text) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM || !to) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, reply_to: env.ADMIN_EMAIL || undefined }),
    });
  } catch (e) { console.error('mail failed', e); }
}

async function notifyAdmin(env, subject, text) {
  if (env.ADMIN_EMAIL) await sendMail(env, env.ADMIN_EMAIL, subject, text || subject);
  if (env.DISCORD_WEBHOOK_URL) {
    try {
      await fetch(env.DISCORD_WEBHOOK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: subject }),
      });
    } catch (e) { console.error('discord failed', e); }
  }
}

// ───────────────────────── 管理API ─────────────────────────

async function adminRoutes(req, env, path, url) {
  requireAdmin(req, env);
  const m = req.method;

  if (path === '/api/admin/ping') return json({ ok: true });

  if (path === '/api/admin/products' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM products ORDER BY sort DESC, id DESC').all();
    return json(results);
  }
  if (path === '/api/admin/products' && m === 'POST') {
    const p = cleanProduct(await readJson(req));
    const r = await env.DB.prepare(
      `INSERT INTO products (${PRODUCT_FIELDS.join(',')}) VALUES (${PRODUCT_FIELDS.map(() => '?').join(',')})`
    ).bind(...PRODUCT_FIELDS.map(f => p[f])).run();
    return json({ id: r.meta.last_row_id }, 201);
  }
  if (path === '/api/admin/products/import' && m === 'POST') {
    const body = await readJson(req);
    const rows = (Array.isArray(body.rows) ? body.rows : []).map(cleanProduct);
    if (!rows.length) throw new HttpError(400, '取り込むデータがありません');
    if (rows.length > 1000) throw new HttpError(400, '一度に取り込めるのは1000件までです');
    const stmt = `INSERT INTO products (${PRODUCT_FIELDS.join(',')}) VALUES (${PRODUCT_FIELDS.map(() => '?').join(',')})`;
    for (let i = 0; i < rows.length; i += 50) {
      await env.DB.batch(rows.slice(i, i + 50).map(p => env.DB.prepare(stmt).bind(...PRODUCT_FIELDS.map(f => p[f]))));
    }
    return json({ imported: rows.length }, 201);
  }
  // 在庫の増減（差分で更新するので、同時に入った注文の在庫確保を上書きしない）
  let ms = path.match(/^\/api\/admin\/products\/(\d+)\/stock$/);
  if (ms && m === 'POST') {
    const delta = int((await readJson(req)).delta);
    await env.DB.prepare(
      `UPDATE products SET stock = MAX(0, stock + ?1), updated_at = datetime('now') WHERE id = ?2`
    ).bind(delta, int(ms[1])).run();
    const p = await env.DB.prepare('SELECT stock FROM products WHERE id = ?').bind(int(ms[1])).first();
    return json({ stock: p ? p.stock : 0 });
  }
  let mm = path.match(/^\/api\/admin\/products\/(\d+)$/);
  if (mm && m === 'PUT') {
    const p = cleanProduct(await readJson(req));
    await env.DB.prepare(
      `UPDATE products SET ${PRODUCT_FIELDS.map(f => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
    ).bind(...PRODUCT_FIELDS.map(f => p[f]), int(mm[1])).run();
    return json({ ok: true });
  }
  if (mm && m === 'DELETE') {
    const used = await env.DB.prepare('SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1').bind(int(mm[1])).first();
    if (used) {
      await env.DB.prepare('UPDATE products SET active = 0 WHERE id = ?').bind(int(mm[1])).run();
      return json({ ok: true, note: '注文履歴があるため非公開にしました' });
    }
    await env.DB.prepare('DELETE FROM products WHERE id = ?').bind(int(mm[1])).run();
    return json({ ok: true });
  }

  if (path === '/api/admin/orders' && m === 'GET') {
    await expireOverdueOrders(env);
    const status = url.searchParams.get('status');
    const q = status && STATUSES.includes(status)
      ? env.DB.prepare('SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT 300').bind(status)
      : env.DB.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 300');
    const { results: orders } = await q.all();
    if (orders.length) {
      const { results: items } = await env.DB.prepare(
        `SELECT order_id, product_id, name, price, qty FROM order_items WHERE order_id IN (${orders.map(() => '?').join(',')})`
      ).bind(...orders.map(o => o.id)).all();
      const g = {};
      items.forEach(it => (g[it.order_id] ||= []).push(it));
      orders.forEach(o => { o.items = g[o.id] || []; delete o.token; });
    }
    return json(orders);
  }

  mm = path.match(/^\/api\/admin\/orders\/(\d+)$/);
  if (mm && m === 'PUT') {
    const id = int(mm[1]);
    const body = await readJson(req);
    const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
    if (!order) throw new HttpError(404, '注文が見つかりません');
    const to = body.status;
    const tracking = body.tracking_no !== undefined ? str(body.tracking_no, 100) : order.tracking_no;
    const memo = body.admin_memo !== undefined ? str(body.admin_memo, 2000) : order.admin_memo;
    await env.DB.prepare('UPDATE orders SET tracking_no = ?, admin_memo = ? WHERE id = ?').bind(tracking, memo, id).run();

    if (to && to !== order.status) {
      const { results: items } = await env.DB.prepare('SELECT name, price, qty FROM order_items WHERE order_id = ?').bind(id).all();
      const cfg = shopConfig(env);
      if (to === 'paid') {
        if (order.status !== 'awaiting_payment') throw new HttpError(400, '入金待ちの注文だけ入金確認にできます');
        await env.DB.prepare(`UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?`).bind(id).run();
        if (body.notify !== false) await sendMail(env, order.email, `【${cfg.shopName}】ご入金を確認しました（${order.order_no}）`, orderMailText(env, order, items, 'paid'));
      } else if (to === 'shipped') {
        if (order.status !== 'paid') throw new HttpError(400, '入金確認済みの注文だけ発送済みにできます');
        await env.DB.prepare(`UPDATE orders SET status = 'shipped', shipped_at = datetime('now') WHERE id = ?`).bind(id).run();
        if (body.notify !== false) await sendMail(env, order.email, `【${cfg.shopName}】商品を発送しました（${order.order_no}）`, orderMailText(env, { ...order, tracking_no: tracking }, items, 'shipped'));
      } else if (to === 'cancelled') {
        const done = await releaseOrder(env, id, 'cancelled', ['awaiting_payment', 'paid']);
        if (!done) throw new HttpError(400, 'この注文はキャンセルできません');
      } else {
        throw new HttpError(400, 'このステータスには変更できません');
      }
    }
    return json({ ok: true });
  }

  throw new HttpError(404, 'not found');
}

// ───────────────────────── ルーティング ─────────────────────────

async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/api/config' && req.method === 'GET') return json(shopConfig(env));
  if (path === '/api/products' && req.method === 'GET') return json(await listPublicProducts(env));
  let m = path.match(/^\/api\/products\/(\d+)$/);
  if (m && req.method === 'GET') {
    const p = await env.DB.prepare(
      'SELECT id, name, set_name, card_no, rarity, condition, category, price, stock, image_url, description FROM products WHERE id = ? AND active = 1'
    ).bind(int(m[1])).first();
    if (!p) throw new HttpError(404, '商品が見つかりません');
    return json(p);
  }
  if (path === '/api/orders' && req.method === 'POST') return createOrder(req, env);
  m = path.match(/^\/api\/orders\/(PK\d{6})$/);
  if (m && req.method === 'GET') return getOrderPublic(env, m[1], url.searchParams.get('t'));
  if (path === '/api/stripe/webhook' && req.method === 'POST') return stripeWebhook(req, env);
  if (path.startsWith('/api/admin/')) return adminRoutes(req, env, path, url);
  if (path === '/') return json({ ok: true, service: 'PKlabo EC API' });
  throw new HttpError(404, 'not found');
}

export default {
  async fetch(req, env) {
    const headers = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    try {
      const res = await handle(req, env);
      for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
      return res;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return json({ error: status === 500 ? 'サーバーエラーが発生しました' : e.message, failed: e.failed }, status, headers);
    }
  },
  // 入金期限切れの注文を自動キャンセルして在庫を戻す（wrangler.toml の crons）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(expireOverdueOrders(env));
  },
};
