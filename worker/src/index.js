// PKlabo EC  Cloudflare Worker (API)
// 画面(GitHub Pages) から呼ばれる API。データは D1 (binding: DB)、画像は R2 (binding: IMAGES, 任意)。

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const STATUSES = ['awaiting_payment', 'paid', 'shipped', 'cancelled', 'expired'];
const STATUS_LABEL = {
  awaiting_payment: '入金待ち',
  paid: '入金確認済み',
  shipped: '発送済み',
  cancelled: 'キャンセル',
  expired: '期限切れ',
};
const CARRIERS = {
  japanpost: { label: '日本郵便', url: n => `https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=${encodeURIComponent(n)}` },
  yamato: { label: 'ヤマト運輸', url: n => `https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number01=${encodeURIComponent(n)}` },
  sagawa: { label: '佐川急便', url: n => `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${encodeURIComponent(n)}` },
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
  const n = parseInt(String(v ?? '').replace(/[,，¥円\s]/g, ''), 10);
  return Number.isFinite(n) ? n : d;
};
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const toSql = d => d.toISOString().replace('T', ' ').slice(0, 19); // D1 の datetime('now') と同じ形式(UTC)
const nowIso = () => toSql(new Date());
const addMinutesIso = min => toSql(new Date(Date.now() + min * 60000));
const yen = n => '¥' + Number(n).toLocaleString('ja-JP');
const parseImages = s => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch { return []; } };

function shopConfig(env) {
  return {
    shopName: env.SHOP_NAME || 'ポケカ買取ラボ',
    shippingFee: int(env.SHIPPING_FEE, 230),
    freeShippingOver: int(env.FREE_SHIPPING_OVER, 10000),
    paymentDays: int(env.PAYMENT_DAYS, 3),
    maxQtyPerItem: int(env.MAX_QTY_PER_ITEM, 10),
    cardEnabled: Boolean(env.STRIPE_SECRET_KEY),
    mailEnabled: Boolean(env.RESEND_API_KEY && env.MAIL_FROM),
    shipCutoffHour: int(env.SHIP_CUTOFF_HOUR, 13),                 // この時刻(JST)までの決済/入金確認で当日発送
    shipDays: String(env.SHIP_DAYS ?? '1,2,3,4,5,6').split(',').map(s => int(s, -1)).filter(n => n >= 0 && n <= 6), // 0=日
    pickupEnabled: env.PICKUP_ENABLED === '1' || env.PICKUP_ENABLED === 'true',
    pickupInfo: env.PICKUP_INFO || '',
    buybackUrl: env.BUYBACK_URL || '',
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

const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// ───────────────────────── 商品 ─────────────────────────

const PRODUCT_FIELDS = ['name', 'set_name', 'card_no', 'rarity', 'condition', 'category', 'price', 'compare_price', 'buy_price',
  'stock', 'image_url', 'images', 'real_photo', 'description', 'active', 'sort'];
const PUBLIC_COLS = 'p.id, p.name, p.set_name, p.card_no, p.rarity, p.condition, p.category, p.price, p.compare_price, p.buy_price, p.stock, p.image_url, p.images, p.real_photo, p.description, p.created_at';
const truthy = v => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on') ? 1 : 0;

function cleanProduct(p) {
  const imgs = (Array.isArray(p.images) ? p.images : parseImages(p.images)).map(s => str(s, 1000)).filter(s => /^https?:\/\//.test(s)).slice(0, 8);
  const out = {
    name: str(p.name, 200),
    set_name: str(p.set_name, 200),
    card_no: str(p.card_no, 50),
    rarity: str(p.rarity, 30),
    condition: str(p.condition, 30) || 'A',
    category: str(p.category, 30) || 'single',
    price: Math.max(0, int(p.price)),
    compare_price: Math.max(0, int(p.compare_price)),
    buy_price: Math.max(0, int(p.buy_price)),
    stock: Math.max(0, int(p.stock)),
    image_url: str(p.image_url, 1000),
    images: JSON.stringify(imgs),
    real_photo: truthy(p.real_photo),
    description: str(p.description, 3000),
    active: p.active === undefined ? 1 : truthy(p.active),
    sort: int(p.sort),
  };
  if (!out.name) throw new HttpError(400, '商品名は必須です');
  if (out.image_url && !/^https?:\/\//.test(out.image_url)) throw new HttpError(400, '画像URLは http(s):// で始めてください');
  if (!out.image_url && imgs.length) out.image_url = imgs.shift(), out.images = JSON.stringify(imgs);
  return out;
}

function publicProduct(p) {
  return { ...p, images: parseImages(p.images) };
}

const SOLD_SUBQUERY = `
  LEFT JOIN (
    SELECT oi.product_id, SUM(oi.qty) AS sold FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.status IN ('awaiting_payment','paid','shipped') AND o.created_at > datetime('now','-30 days')
     GROUP BY oi.product_id
  ) s ON s.product_id = p.id`;

async function listPublicProducts(env) {
  const { results } = await env.DB.prepare(
    `SELECT ${PUBLIC_COLS}, COALESCE(s.sold, 0) AS sold FROM products p ${SOLD_SUBQUERY}
      WHERE p.active = 1 ORDER BY p.sort DESC, p.id DESC`
  ).all();
  return results.map(publicProduct);
}

async function recordPrice(env, productId, price) {
  await env.DB.prepare('INSERT INTO price_history (product_id, price) VALUES (?, ?)').bind(productId, price).run();
}

// 在庫が 0 → 1以上 になったら入荷通知メールを送る
async function notifyRestock(env, productId) {
  const cfg = shopConfig(env);
  if (!cfg.mailEnabled) return 0;
  const p = await env.DB.prepare('SELECT id, name, card_no, condition, price, stock FROM products WHERE id = ? AND active = 1').bind(productId).first();
  if (!p || p.stock <= 0) return 0;
  const { results } = await env.DB.prepare('SELECT id, email FROM restock_requests WHERE product_id = ? AND notified_at IS NULL LIMIT 200').bind(productId).all();
  const site = (env.SITE_URL || '').replace(/\/$/, '');
  for (const r of results) {
    await sendMail(env, r.email, `【${cfg.shopName}】入荷のお知らせ：${p.name}`,
      `ご登録いただいた商品が入荷しました。\n\n${p.name} ${p.card_no} 状態${p.condition}\n${yen(p.price)}（在庫${p.stock}点）\n\n${site}/#/p/${p.id}\n\n※在庫が少ないため、売り切れの際はご容赦ください。\n${cfg.shopName}`);
    await env.DB.prepare(`UPDATE restock_requests SET notified_at = datetime('now') WHERE id = ?`).bind(r.id).run();
  }
  return results.length;
}

// ───────────────────────── 在庫の確保・解放 ─────────────────────────

async function reserveStock(env, items) {
  const stmts = items.map(it =>
    env.DB.prepare(`UPDATE products SET stock = stock - ?1, updated_at = datetime('now') WHERE id = ?2 AND active = 1 AND stock >= ?1`)
      .bind(it.qty, it.product_id)
  );
  const res = await env.DB.batch(stmts);
  const failed = [];
  const ok = [];
  res.forEach((r, i) => (r.meta.changes === 1 ? ok : failed).push(items[i]));
  if (failed.length) {
    if (ok.length) await restoreStock(env, ok);
    const err = new HttpError(409, '在庫が足りない商品があります。カートを確認してください');
    err.failed = failed.map(f => f.product_id);
    throw err;
  }
}

async function restoreStock(env, items) {
  if (!items.length) return;
  await env.DB.batch(items.map(it =>
    env.DB.prepare(`UPDATE products SET stock = stock + ?1, updated_at = datetime('now') WHERE id = ?2`).bind(it.qty, it.product_id)
  ));
}

// 注文の在庫・クーポンを戻してステータス変更（fromStatuses のときだけ）
async function releaseOrder(env, orderId, newStatus, fromStatuses) {
  const placeholders = fromStatuses.map((_, i) => `?${i + 3}`).join(',');
  const upd = await env.DB.prepare(
    `UPDATE orders SET status = ?1 WHERE id = ?2 AND status IN (${placeholders})`
  ).bind(newStatus, orderId, ...fromStatuses).run();
  if (upd.meta.changes !== 1) return false;
  const { results } = await env.DB.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').bind(orderId).all();
  await restoreStock(env, results);
  const o = await env.DB.prepare('SELECT coupon_code FROM orders WHERE id = ?').bind(orderId).first();
  if (o?.coupon_code) await env.DB.prepare('UPDATE coupons SET used = MAX(0, used - 1) WHERE code = ?').bind(o.coupon_code).run();
  for (const it of results) await notifyRestock(env, it.product_id);
  return true;
}

async function expireOverdueOrders(env) {
  const { results } = await env.DB.prepare(
    `SELECT id FROM orders WHERE status = 'awaiting_payment' AND expires_at IS NOT NULL AND expires_at < ?`
  ).bind(nowIso()).all();
  let count = 0;
  for (const o of results) if (await releaseOrder(env, o.id, 'expired', ['awaiting_payment'])) count++;
  return count;
}

// ───────────────────────── クーポン ─────────────────────────

async function evaluateCoupon(env, rawCode, subtotal) {
  const code = str(rawCode, 40).toUpperCase();
  if (!code) return null;
  const c = await env.DB.prepare('SELECT * FROM coupons WHERE code = ?').bind(code).first();
  if (!c || !c.active) throw new HttpError(400, 'このクーポンは使えません');
  if (c.ends_at && c.ends_at < nowIso()) throw new HttpError(400, 'クーポンの有効期限が切れています');
  if (c.max_uses > 0 && c.used >= c.max_uses) throw new HttpError(400, 'このクーポンは上限に達しました');
  if (subtotal < c.min_subtotal) throw new HttpError(400, `このクーポンは${yen(c.min_subtotal)}以上のご注文で使えます`);
  const discount = Math.min(subtotal, c.type === 'percent' ? Math.floor(subtotal * Math.min(c.value, 100) / 100) : c.value);
  const label = c.type === 'percent' ? `${c.value}%OFF` : `${yen(c.value)}引き`;
  return { code, discount, label };
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

async function priceCart(env, rawItems) {
  const cfg = shopConfig(env);
  const merged = new Map();
  for (const it of Array.isArray(rawItems) ? rawItems : []) {
    const id = int(it.product_id); const q = int(it.qty);
    if (id > 0 && q > 0) merged.set(id, (merged.get(id) || 0) + q);
  }
  if (!merged.size) throw new HttpError(400, 'カートが空です');
  if (merged.size > 200) throw new HttpError(400, '一度に注文できるのは200種類までです');
  const ids = [...merged.keys()];
  const { results: prods } = await env.DB.prepare(
    `SELECT id, name, card_no, condition, price, stock, active FROM products WHERE id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();
  const byId = new Map(prods.map(p => [p.id, p]));
  const items = [];
  for (const [id, qty] of merged) {
    const p = byId.get(id);
    if (!p || !p.active) throw new HttpError(409, '販売終了した商品がカートに含まれています');
    if (qty > cfg.maxQtyPerItem) throw new HttpError(400, `1商品あたり${cfg.maxQtyPerItem}点までです`);
    items.push({ product_id: id, qty, name: p.name, card_no: p.card_no, condition: p.condition, price: p.price });
  }
  return items;
}

async function createOrder(req, env) {
  const body = await readJson(req);
  const cfg = shopConfig(env);

  const shippingMethod = body.shipping_method === 'pickup' && cfg.pickupEnabled ? 'pickup' : 'delivery';
  const c = body.customer || {};
  const customer = {
    name: str(c.name, 100), kana: str(c.kana, 100), email: str(c.email, 200),
    phone: str(c.phone, 30), zip: str(c.zip, 10), address: str(c.address, 300), note: str(c.note, 1000),
  };
  if (!customer.name || !customer.email || !customer.phone) throw new HttpError(400, 'お名前・メール・電話番号は必須です');
  if (shippingMethod === 'delivery' && (!customer.zip || !customer.address)) throw new HttpError(400, '郵便番号と住所を入力してください');
  if (!isEmail(customer.email)) throw new HttpError(400, 'メールアドレスの形式が正しくありません');

  const method = body.payment_method === 'card' ? 'card' : 'bank';
  if (method === 'card' && !cfg.cardEnabled) throw new HttpError(400, 'カード決済は現在ご利用いただけません');

  const items = await priceCart(env, body.items);
  const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
  const coupon = await evaluateCoupon(env, body.coupon_code, subtotal);
  const discount = coupon ? coupon.discount : 0;
  const shipping = shippingMethod === 'pickup' || subtotal >= cfg.freeShippingOver ? 0 : cfg.shippingFee;
  const total = subtotal - discount + shipping;

  await reserveStock(env, items);

  if (coupon) {
    const u = await env.DB.prepare(
      'UPDATE coupons SET used = used + 1 WHERE code = ? AND active = 1 AND (max_uses = 0 OR used < max_uses)'
    ).bind(coupon.code).run();
    if (u.meta.changes !== 1) { await restoreStock(env, items); throw new HttpError(400, 'このクーポンは上限に達しました'); }
  }

  const orderNo = await newOrderNo(env);
  const token = crypto.randomUUID();
  const expiresAt = method === 'bank' ? addMinutesIso(cfg.paymentDays * 24 * 60) : addMinutesIso(35);

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO orders (order_no, token, status, payment_method, shipping_method, name, kana, email, phone, zip, address, note,
                             subtotal, discount, coupon_code, shipping_fee, total, expires_at)
         VALUES (?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(orderNo, token, method, shippingMethod, customer.name, customer.kana, customer.email, customer.phone,
        shippingMethod === 'pickup' ? '' : customer.zip, shippingMethod === 'pickup' ? '' : customer.address, customer.note,
        subtotal, discount, coupon ? coupon.code : '', shipping, total, expiresAt),
      ...items.map(it => env.DB.prepare(
        `INSERT INTO order_items (order_id, product_id, name, card_no, condition, price, qty)
         VALUES ((SELECT id FROM orders WHERE order_no = ?), ?, ?, ?, ?, ?, ?)`
      ).bind(orderNo, it.product_id, it.name, it.card_no, it.condition, it.price, it.qty)),
    ]);
  } catch (e) {
    await restoreStock(env, items);
    if (coupon) await env.DB.prepare('UPDATE coupons SET used = MAX(0, used - 1) WHERE code = ?').bind(coupon.code).run();
    throw e;
  }

  const order = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(orderNo).first();
  const result = { order_no: orderNo, token, total, payment_method: method };

  if (method === 'card') {
    try {
      const session = await createStripeSession(env, order, items);
      await env.DB.prepare('UPDATE orders SET stripe_session = ? WHERE id = ?').bind(session.id, order.id).run();
      result.checkout_url = session.url;
    } catch (e) {
      console.error(e);
      await releaseOrder(env, order.id, 'cancelled', ['awaiting_payment']);
      throw new HttpError(502, 'カード決済ページの作成に失敗しました。時間をおいて再度お試しください');
    }
  } else {
    await sendMail(env, customer.email, `【${cfg.shopName}】ご注文ありがとうございます（${orderNo}）`, orderMailText(env, order, items, 'created'));
  }
  await notifyAdmin(env, `新規注文 ${orderNo}（${method === 'bank' ? '振込' : 'カード'}${shippingMethod === 'pickup' ? '・店頭受取' : ''}）${yen(total)} / ${customer.name}`, orderMailText(env, order, items, 'admin'));

  return json(result, 201);
}

async function getOrderPublic(env, orderNo, token) {
  const order = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(orderNo).first();
  if (!order || !token || !timingSafeEqual(token, order.token)) throw new HttpError(404, '注文が見つかりません');
  const { results: items } = await env.DB.prepare('SELECT product_id, name, card_no, condition, price, qty FROM order_items WHERE order_id = ?').bind(order.id).all();
  const carrier = CARRIERS[order.carrier];
  const out = {
    order_no: order.order_no, status: order.status, status_label: STATUS_LABEL[order.status],
    payment_method: order.payment_method, shipping_method: order.shipping_method,
    name: order.name, zip: order.zip, address: order.address,
    subtotal: order.subtotal, discount: order.discount, coupon_code: order.coupon_code,
    shipping_fee: order.shipping_fee, total: order.total,
    carrier_label: carrier ? carrier.label : '', tracking_no: order.tracking_no,
    tracking_url: carrier && order.tracking_no ? carrier.url(order.tracking_no) : '',
    expires_at: order.expires_at, created_at: order.created_at, paid_at: order.paid_at, shipped_at: order.shipped_at, items,
  };
  if (order.payment_method === 'bank' && order.status === 'awaiting_payment') out.bank_info = env.BANK_INFO || '（振込先は管理者が設定してください）';
  if (order.shipping_method === 'pickup') out.pickup_info = shopConfig(env).pickupInfo;
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

async function stripe(env, path, params, idem) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(idem ? { 'Idempotency-Key': idem } : {}),
    },
    body: formEncode(params),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'stripe error');
  return data;
}

async function createStripeSession(env, order, items) {
  const site = (env.SITE_URL || '').replace(/\/$/, '');
  const line_items = items.map(it => ({
    quantity: it.qty,
    price_data: { currency: 'jpy', unit_amount: it.price, product_data: { name: `${it.name}${it.card_no ? ' ' + it.card_no : ''}${it.condition ? '［' + it.condition + '］' : ''}` } },
  }));
  if (order.shipping_fee > 0) {
    line_items.push({ quantity: 1, price_data: { currency: 'jpy', unit_amount: order.shipping_fee, product_data: { name: '送料' } } });
  }
  const params = {
    mode: 'payment',
    customer_email: order.email,
    client_reference_id: order.order_no,
    metadata: { order_no: order.order_no },
    success_url: `${site}/#/order/${order.order_no}?t=${order.token}&new=1`,
    cancel_url: `${site}/#/cart`,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    line_items: Object.fromEntries(line_items.map((li, i) => [i, li])),
  };
  if (order.discount > 0) {
    const coupon = await stripe(env, 'coupons', { amount_off: order.discount, currency: 'jpy', duration: 'once', max_redemptions: 1, name: `クーポン ${order.coupon_code}` }, `coupon-${order.order_no}`);
    params.discounts = { 0: { coupon: coupon.id } };
  }
  return stripe(env, 'checkout/sessions', params, `checkout-${order.order_no}`);
}

async function verifyStripeSignature(payload, header, secret) {
  const pairs = (header || '').split(',').map(kv => kv.trim());
  const t = (pairs.find(kv => kv.startsWith('t=')) || '').slice(2);
  const sigs = pairs.filter(kv => kv.startsWith('v1=')).map(kv => kv.slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return sigs.some(s => timingSafeEqual(s, hex));
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
      const { results: items } = await env.DB.prepare('SELECT name, card_no, condition, price, qty FROM order_items WHERE order_id = ?').bind(order.id).all();
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
  const lines = items.map(it => `・${it.name}${it.card_no ? ' ' + it.card_no : ''}${it.condition ? '［' + it.condition + '］' : ''}  ${yen(it.price)} × ${it.qty}`).join('\n');
  const url = `${site}/#/order/${order.order_no}?t=${order.token}`;
  const pickup = order.shipping_method === 'pickup';
  const head = {
    created: `${order.name} 様\n\nこの度は${cfg.shopName}をご利用いただきありがとうございます。\n以下の内容でご注文を承りました。`,
    paid: `${order.name} 様\n\n${order.payment_method === 'card' ? 'カード決済が完了しました。' : 'ご入金を確認いたしました。'}${pickup ? '店頭でのお受け取り準備ができ次第ご案内します。' : '発送まで今しばらくお待ちください。'}`,
    shipped: `${order.name} 様\n\n${pickup ? 'ご注文の商品のお受け取り準備ができました。' : 'ご注文の商品を発送いたしました。'}`,
    admin: '新規注文が入りました。',
  }[kind];
  let body = `${head}\n\n■ 注文番号: ${order.order_no}\n${lines}\n小計: ${yen(order.subtotal)}\n`;
  if (order.discount) body += `クーポン(${order.coupon_code}): -${yen(order.discount)}\n`;
  body += `${pickup ? '店頭受取' : '送料'}: ${yen(order.shipping_fee)}\n合計: ${yen(order.total)}\n`;
  if (kind === 'created' && order.payment_method === 'bank') {
    const d = order.order_no.replace('PK', '');
    body += `\n■ お振込先\n${env.BANK_INFO || ''}\n\n※ 振込名義の前に注文番号の数字（${d}）を入れてください。\n   例) ${d} ヤマダタロウ\n※ お支払い期限: ご注文から${cfg.paymentDays}日以内。期限を過ぎると自動でキャンセルされます。\n`;
  }
  if (pickup && cfg.pickupInfo && kind !== 'admin') body += `\n■ 店頭受け取り\n${cfg.pickupInfo}\n`;
  if (kind === 'shipped' && order.tracking_no) {
    const c = CARRIERS[order.carrier];
    body += `\n■ 配送: ${c ? c.label : ''} 追跡番号 ${order.tracking_no}\n${c ? c.url(order.tracking_no) + '\n' : ''}`;
  }
  if (kind === 'admin') body += `\nお客様: ${order.name} / ${order.email} / ${order.phone}\n${pickup ? '店頭受け取り' : `〒${order.zip} ${order.address}`}\n備考: ${order.note || '-'}\n`;
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
      await fetch(env.DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: subject }) });
    } catch (e) { console.error('discord failed', e); }
  }
}

// ───────────────────────── 画像 ─────────────────────────

const IMG_TYPES = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

async function uploadImage(req, env, url) {
  const type = (req.headers.get('Content-Type') || '').split(';')[0].trim();
  if (!IMG_TYPES[type]) throw new HttpError(400, '画像は webp / jpeg / png にしてください');
  const buf = await req.arrayBuffer();
  if (buf.byteLength > 1.5 * 1024 * 1024) throw new HttpError(400, '画像が大きすぎます（1.5MBまで）');
  const key = `${crypto.randomUUID()}.${IMG_TYPES[type]}`;
  if (env.IMAGES) await env.IMAGES.put(key, buf, { httpMetadata: { contentType: type } });
  else await env.DB.prepare('INSERT INTO images (key, content_type, data) VALUES (?, ?, ?)').bind(key, type, buf).run();
  return json({ url: `${url.origin}/img/${key}` }, 201);
}

async function serveImage(env, key) {
  const headers = { 'Cache-Control': 'public, max-age=31536000, immutable', 'Access-Control-Allow-Origin': '*' };
  if (env.IMAGES) {
    const obj = await env.IMAGES.get(key);
    if (obj) return new Response(obj.body, { headers: { ...headers, 'Content-Type': obj.httpMetadata?.contentType || 'image/webp' } });
  }
  const row = await env.DB.prepare('SELECT content_type, data FROM images WHERE key = ?').bind(key).first();
  if (!row) return new Response('not found', { status: 404 });
  return new Response(new Uint8Array(row.data), { headers: { ...headers, 'Content-Type': row.content_type } });
}

// ───────────────────────── 管理API ─────────────────────────

async function saveProduct(env, id, p) {
  const before = id ? await env.DB.prepare('SELECT price, stock FROM products WHERE id = ?').bind(id).first() : null;
  if (id && !before) throw new HttpError(404, '商品が見つかりません');
  let newId = id;
  if (id) {
    await env.DB.prepare(
      `UPDATE products SET ${PRODUCT_FIELDS.map(f => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
    ).bind(...PRODUCT_FIELDS.map(f => p[f]), id).run();
  } else {
    const r = await env.DB.prepare(
      `INSERT INTO products (${PRODUCT_FIELDS.join(',')}) VALUES (${PRODUCT_FIELDS.map(() => '?').join(',')})`
    ).bind(...PRODUCT_FIELDS.map(f => p[f])).run();
    newId = r.meta.last_row_id;
  }
  if (!before || before.price !== p.price) await recordPrice(env, newId, p.price);
  let notified = 0;
  if (before && before.stock <= 0 && p.stock > 0) notified = await notifyRestock(env, newId);
  return { id: newId, notified };
}

async function adminRoutes(req, env, path, url) {
  requireAdmin(req, env);
  const m = req.method;

  if (path === '/api/admin/ping') return json({ ok: true, config: shopConfig(env) });

  if (path === '/api/admin/stats' && m === 'GET') {
    await expireOverdueOrders(env);
    const sum = async (since) => env.DB.prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS sales FROM orders WHERE status IN ('paid','shipped') AND COALESCE(paid_at, created_at) >= datetime('now', ?)`
    ).bind(since).first();
    const [today, week, month] = await Promise.all([sum('-1 day'), sum('-7 days'), sum('-30 days')]);
    const counts = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all();
    const { results: top } = await env.DB.prepare(
      `SELECT p.id, p.name, p.card_no, p.condition, p.stock, s.sold FROM products p ${SOLD_SUBQUERY} WHERE s.sold > 0 ORDER BY s.sold DESC LIMIT 10`
    ).all();
    const { results: waiting } = await env.DB.prepare(
      `SELECT p.id, p.name, p.card_no, p.condition, p.stock, COUNT(r.id) AS waiting FROM restock_requests r JOIN products p ON p.id = r.product_id
        WHERE r.notified_at IS NULL GROUP BY p.id ORDER BY waiting DESC LIMIT 10`
    ).all();
    const { results: daily } = await env.DB.prepare(
      `SELECT date(COALESCE(paid_at, created_at), '+9 hours') AS d, COALESCE(SUM(total),0) AS sales, COUNT(*) AS orders
         FROM orders WHERE status IN ('paid','shipped') AND COALESCE(paid_at, created_at) >= datetime('now','-30 days') GROUP BY d ORDER BY d`
    ).all();
    const stock = await env.DB.prepare('SELECT COUNT(*) AS items, COALESCE(SUM(stock),0) AS units, COALESCE(SUM(stock*price),0) AS value FROM products WHERE active = 1').first();
    return json({ today, week, month, status: Object.fromEntries(counts.results.map(r => [r.status, r.n])), top, waiting, daily, stock });
  }

  // 商品
  if (path === '/api/admin/products' && m === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT p.*, COALESCE(s.sold,0) AS sold, COALESCE(w.waiting,0) AS waiting FROM products p ${SOLD_SUBQUERY}
         LEFT JOIN (SELECT product_id, COUNT(*) AS waiting FROM restock_requests WHERE notified_at IS NULL GROUP BY product_id) w ON w.product_id = p.id
        ORDER BY p.sort DESC, p.id DESC`
    ).all();
    return json(results.map(publicProduct));
  }
  if (path === '/api/admin/products' && m === 'POST') {
    return json(await saveProduct(env, 0, cleanProduct(await readJson(req))), 201);
  }
  if (path === '/api/admin/products/import' && m === 'POST') {
    const body = await readJson(req);
    const rows = (Array.isArray(body.rows) ? body.rows : []).map(cleanProduct);
    if (!rows.length) throw new HttpError(400, '取り込むデータがありません');
    if (rows.length > 2000) throw new HttpError(400, '一度に取り込めるのは2000件までです');
    for (const p of rows) await saveProduct(env, 0, p);
    return json({ imported: rows.length }, 201);
  }
  if (path === '/api/admin/images' && m === 'POST') return uploadImage(req, env, url);

  let mm = path.match(/^\/api\/admin\/products\/(\d+)\/stock$/);
  if (mm && m === 'POST') {
    const id = int(mm[1]);
    const delta = int((await readJson(req)).delta);
    const before = await env.DB.prepare('SELECT stock FROM products WHERE id = ?').bind(id).first();
    if (!before) throw new HttpError(404, '商品が見つかりません');
    await env.DB.prepare(`UPDATE products SET stock = MAX(0, stock + ?1), updated_at = datetime('now') WHERE id = ?2`).bind(delta, id).run();
    const p = await env.DB.prepare('SELECT stock FROM products WHERE id = ?').bind(id).first();
    const notified = before.stock <= 0 && p.stock > 0 ? await notifyRestock(env, id) : 0;
    return json({ stock: p.stock, notified });
  }
  mm = path.match(/^\/api\/admin\/products\/(\d+)$/);
  if (mm && m === 'PUT') return json(await saveProduct(env, int(mm[1]), cleanProduct(await readJson(req))));
  if (mm && m === 'DELETE') {
    const id = int(mm[1]);
    const used = await env.DB.prepare('SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1').bind(id).first();
    if (used) {
      await env.DB.prepare('UPDATE products SET active = 0 WHERE id = ?').bind(id).run();
      return json({ ok: true, note: '注文履歴があるため非公開にしました' });
    }
    await env.DB.batch([
      env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id),
      env.DB.prepare('DELETE FROM price_history WHERE product_id = ?').bind(id),
      env.DB.prepare('DELETE FROM restock_requests WHERE product_id = ?').bind(id),
    ]);
    return json({ ok: true });
  }

  // 注文
  if (path === '/api/admin/orders' && m === 'GET') {
    await expireOverdueOrders(env);
    const status = url.searchParams.get('status');
    const q = status && STATUSES.includes(status)
      ? env.DB.prepare('SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT 500').bind(status)
      : env.DB.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 500');
    const { results: orders } = await q.all();
    if (orders.length) {
      const { results: items } = await env.DB.prepare(
        `SELECT order_id, product_id, name, card_no, condition, price, qty FROM order_items WHERE order_id IN (${orders.map(() => '?').join(',')})`
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
    const carrier = body.carrier !== undefined ? (CARRIERS[body.carrier] ? body.carrier : '') : order.carrier;
    const memo = body.admin_memo !== undefined ? str(body.admin_memo, 2000) : order.admin_memo;
    await env.DB.prepare('UPDATE orders SET tracking_no = ?, carrier = ?, admin_memo = ? WHERE id = ?').bind(tracking, carrier, memo, id).run();

    if (to && to !== order.status) {
      const { results: items } = await env.DB.prepare('SELECT name, card_no, condition, price, qty FROM order_items WHERE order_id = ?').bind(id).all();
      const cfg = shopConfig(env);
      const o2 = { ...order, tracking_no: tracking, carrier };
      if (to === 'paid') {
        if (order.status !== 'awaiting_payment') throw new HttpError(400, '入金待ちの注文だけ入金確認にできます');
        await env.DB.prepare(`UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?`).bind(id).run();
        if (body.notify !== false) await sendMail(env, order.email, `【${cfg.shopName}】ご入金を確認しました（${order.order_no}）`, orderMailText(env, o2, items, 'paid'));
      } else if (to === 'shipped') {
        if (order.status !== 'paid') throw new HttpError(400, '入金確認済みの注文だけ発送済みにできます');
        await env.DB.prepare(`UPDATE orders SET status = 'shipped', shipped_at = datetime('now') WHERE id = ?`).bind(id).run();
        const subj = order.shipping_method === 'pickup' ? 'お受け取りの準備ができました' : '商品を発送しました';
        if (body.notify !== false) await sendMail(env, order.email, `【${cfg.shopName}】${subj}（${order.order_no}）`, orderMailText(env, o2, items, 'shipped'));
      } else if (to === 'cancelled') {
        const done = await releaseOrder(env, id, 'cancelled', ['awaiting_payment', 'paid']);
        if (!done) throw new HttpError(400, 'この注文はキャンセルできません');
      } else {
        throw new HttpError(400, 'このステータスには変更できません');
      }
    }
    return json({ ok: true });
  }

  // クーポン
  if (path === '/api/admin/coupons' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM coupons ORDER BY rowid DESC').all();
    return json(results);
  }
  if (path === '/api/admin/coupons' && m === 'POST') {
    const b = await readJson(req);
    const code = str(b.code, 40).toUpperCase().replace(/\s/g, '');
    if (!/^[A-Z0-9_-]{3,40}$/.test(code)) throw new HttpError(400, 'コードは英数字3文字以上にしてください');
    const type = b.type === 'amount' ? 'amount' : 'percent';
    const value = Math.max(1, int(b.value));
    if (type === 'percent' && value > 100) throw new HttpError(400, '割引率は100%までです');
    const endsAt = b.ends_at ? toSql(new Date(b.ends_at)) : null;
    await env.DB.prepare(
      `INSERT INTO coupons (code, type, value, min_subtotal, max_uses, ends_at, active, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET type=excluded.type, value=excluded.value, min_subtotal=excluded.min_subtotal,
         max_uses=excluded.max_uses, ends_at=excluded.ends_at, active=excluded.active, note=excluded.note`
    ).bind(code, type, value, Math.max(0, int(b.min_subtotal)), Math.max(0, int(b.max_uses)), endsAt, b.active === undefined ? 1 : truthy(b.active), str(b.note, 200)).run();
    return json({ ok: true, code });
  }
  mm = path.match(/^\/api\/admin\/coupons\/([A-Za-z0-9_-]+)$/);
  if (mm && m === 'DELETE') {
    await env.DB.prepare('DELETE FROM coupons WHERE code = ?').bind(mm[1].toUpperCase()).run();
    return json({ ok: true });
  }

  throw new HttpError(404, 'not found');
}

// ───────────────────────── ルーティング ─────────────────────────

async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const cache = { 'Cache-Control': 'public, max-age=15' };

  if (path === '/api/config' && req.method === 'GET') return json(shopConfig(env), 200, cache);
  if (path === '/api/products' && req.method === 'GET') return json(await listPublicProducts(env), 200, cache);
  let m = path.match(/^\/api\/products\/(\d+)$/);
  if (m && req.method === 'GET') {
    const p = await env.DB.prepare(`SELECT ${PUBLIC_COLS}, COALESCE(s.sold,0) AS sold FROM products p ${SOLD_SUBQUERY} WHERE p.id = ? AND p.active = 1`).bind(int(m[1])).first();
    if (!p) throw new HttpError(404, '商品が見つかりません');
    return json(publicProduct(p));
  }
  m = path.match(/^\/api\/products\/(\d+)\/history$/);
  if (m && req.method === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT price, at FROM price_history WHERE product_id = ? AND at >= datetime('now','-365 days') ORDER BY at, id`
    ).bind(int(m[1])).all();
    return json(results, 200, { 'Cache-Control': 'public, max-age=300' });
  }
  if (path === '/api/restock' && req.method === 'POST') {
    const b = await readJson(req);
    const email = str(b.email, 200);
    if (!isEmail(email)) throw new HttpError(400, 'メールアドレスの形式が正しくありません');
    const p = await env.DB.prepare('SELECT id FROM products WHERE id = ? AND active = 1').bind(int(b.product_id)).first();
    if (!p) throw new HttpError(404, '商品が見つかりません');
    await env.DB.prepare(
      `INSERT INTO restock_requests (product_id, email) VALUES (?, ?)
       ON CONFLICT(product_id, email) DO UPDATE SET notified_at = NULL, created_at = datetime('now')`
    ).bind(p.id, email).run();
    return json({ ok: true }, 201);
  }
  if (path === '/api/coupon' && req.method === 'POST') {
    const b = await readJson(req);
    const items = await priceCart(env, b.items);
    const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
    const c = await evaluateCoupon(env, b.code, subtotal);
    if (!c) throw new HttpError(400, 'クーポンコードを入力してください');
    return json(c);
  }
  if (path === '/api/orders' && req.method === 'POST') return createOrder(req, env);
  m = path.match(/^\/api\/orders\/(PK\d{6})$/);
  if (m && req.method === 'GET') return getOrderPublic(env, m[1], url.searchParams.get('t'));
  if (path === '/api/stripe/webhook' && req.method === 'POST') return stripeWebhook(req, env);
  m = path.match(/^\/img\/([a-f0-9-]{36}\.(?:webp|jpg|png))$/);
  if (m && req.method === 'GET') return serveImage(env, m[1]);
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
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(headers)) if (!out.headers.has(k) || k !== 'Access-Control-Allow-Origin') out.headers.set(k, v);
      return out;
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
