// PKlabo EC  Cloudflare Worker (API)
// 画面(GitHub Pages) から呼ばれる API。データは D1 (binding: DB)、画像は R2 (binding: IMAGES, 任意)。

import {
  HttpError, json, int, str, toSql, nowIso, addMinutesIso, yen, parseImages, truthy, isEmail,
  timingSafeEqual, readJson, sendMail, notifyAdmin, clientIp, rateLimit, overLimit, verifyTotp, sha256hex,
} from './util.js';
import { loadConfig, cfg, publicConfig, saveSettings } from './config.js';
import { getCustomer, memberRoutes, adminMemberRoutes, usePoints, addPoints, grantOrderPoints, reverseOrderPoints, expirePoints } from './members.js';
import { oripaPublicRoutes, adminOripaRoutes, priceOripaItems, drawForItems, undoDraws, releaseOrderDraws, orderDraws, revealOrder } from './oripa.js';
import { coinRoutes, adminCoinRoutes, addCoins, spendCoins, refundCoins, revokeCoins, expireCoins } from './coins.js';

const STATUSES = ['awaiting_payment', 'paid', 'shipped', 'cancelled', 'expired'];
const STATUS_LABEL = { awaiting_payment: '入金待ち', paid: '入金確認済み', shipped: '発送済み', cancelled: 'キャンセル', expired: '期限切れ' };
const CARRIERS = {
  japanpost: { label: '日本郵便', url: n => `https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=${encodeURIComponent(n)}` },
  yamato: { label: 'ヤマト運輸', url: n => `https://toi.kuronekoyamato.co.jp/cgi-bin/tneko?number01=${encodeURIComponent(n)}` },
  sagawa: { label: '佐川急便', url: n => `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${encodeURIComponent(n)}` },
};

function cors(env, req) {
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map(s => s.trim());
  const origin = req.headers.get('Origin') || '';
  const allow = allowed.includes('*') ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Key,X-Admin-Session,Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// ───────────────────────── 商品 ─────────────────────────

const PRODUCT_FIELDS = ['name', 'set_name', 'card_no', 'rarity', 'condition', 'category', 'price', 'compare_price', 'buy_price',
  'stock', 'image_url', 'images', 'real_photo', 'description', 'active', 'sort', 'group_key'];
const SHARED_FIELDS = ['name', 'set_name', 'card_no', 'rarity']; // カテゴリ・説明は状態ごと（PSA鑑定品は別カテゴリなど）
const PUBLIC_COLS = 'p.id, p.name, p.set_name, p.card_no, p.rarity, p.condition, p.category, p.price, p.compare_price, p.buy_price, p.stock, p.image_url, p.images, p.real_photo, p.description, p.group_key, p.created_at';
const normKey = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\u3041-\u3096]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/[\s・　]/g, '');
const autoGroupKey = p => `${normKey(p.name)}|${normKey(p.card_no)}`.slice(0, 120);

function cleanProduct(p) {
  const imgs = (Array.isArray(p.images) ? p.images : parseImages(p.images)).map(s => str(s, 1000)).filter(s => /^https?:\/\//.test(s)).slice(0, 8);
  const out = {
    name: str(p.name, 200), set_name: str(p.set_name, 200), card_no: str(p.card_no, 50), rarity: str(p.rarity, 30),
    condition: str(p.condition, 30) || 'A', category: str(p.category, 30) || 'single',
    price: Math.max(0, int(p.price)), compare_price: Math.max(0, int(p.compare_price)), buy_price: Math.max(0, int(p.buy_price)),
    stock: Math.max(0, int(p.stock)), image_url: str(p.image_url, 1000), images: JSON.stringify(imgs),
    real_photo: truthy(p.real_photo), description: str(p.description, 3000),
    active: p.active === undefined ? 1 : truthy(p.active), sort: int(p.sort),
    group_key: str(p.group_key, 120),
  };
  if (!out.name) throw new HttpError(400, '商品名は必須です');
  if (!out.group_key) out.group_key = autoGroupKey(out);
  if (out.image_url && !/^https?:\/\//.test(out.image_url)) throw new HttpError(400, '画像URLは http(s):// で始めてください');
  if (!out.image_url && imgs.length) { out.image_url = imgs.shift(); out.images = JSON.stringify(imgs); }
  return out;
}

const publicProduct = p => ({ ...p, images: parseImages(p.images) });

const SOLD_SUBQUERY = `
  LEFT JOIN (
    SELECT oi.product_id, SUM(oi.qty) AS sold FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.product_id > 0 AND o.status IN ('awaiting_payment','paid','shipped') AND o.created_at > datetime('now','-30 days')
     GROUP BY oi.product_id
  ) s ON s.product_id = p.id`;

async function listPublicProducts(env) {
  const { results } = await env.DB.prepare(
    `SELECT ${PUBLIC_COLS}, COALESCE(s.sold, 0) AS sold FROM products p ${SOLD_SUBQUERY} WHERE p.active = 1 ORDER BY p.sort DESC, p.id DESC`
  ).all();
  return results.map(publicProduct);
}

async function recordPrice(env, productId, price) {
  await env.DB.prepare('INSERT INTO price_history (product_id, price) VALUES (?, ?)').bind(productId, price).run();
}

async function notifyRestock(env, productId) {
  const c = cfg(env);
  if (!c.mailEnabled || !c.features.restock || !productId) return 0;
  const p = await env.DB.prepare('SELECT id, name, card_no, condition, price, stock FROM products WHERE id = ? AND active = 1').bind(productId).first();
  if (!p || p.stock <= 0) return 0;
  const { results } = await env.DB.prepare('SELECT id, email FROM restock_requests WHERE product_id = ? AND notified_at IS NULL LIMIT 200').bind(productId).all();
  const site = (env.SITE_URL || '').replace(/\/$/, '');
  for (const r of results) {
    await sendMail(env, r.email, `【${c.shopName}】入荷のお知らせ：${p.name}`,
      `ご登録いただいた商品が入荷しました。\n\n${p.name} ${p.card_no} 状態${p.condition}\n${yen(p.price)}（在庫${p.stock}点）\n\n${site}/#/p/${p.id}\n\n※在庫が少ないため、売り切れの際はご容赦ください。\n${c.shopName}`);
    await env.DB.prepare(`UPDATE restock_requests SET notified_at = datetime('now') WHERE id = ?`).bind(r.id).run();
  }
  return results.length;
}

// ───────────────────────── 在庫 ─────────────────────────

async function reserveStock(env, items) {
  if (!items.length) return;
  const res = await env.DB.batch(items.map(it =>
    env.DB.prepare(`UPDATE products SET stock = stock - ?1, updated_at = datetime('now') WHERE id = ?2 AND active = 1 AND stock >= ?1`).bind(it.qty, it.product_id)
  ));
  const failed = [], ok = [];
  res.forEach((r, i) => (r.meta.changes === 1 ? ok : failed).push(items[i]));
  if (failed.length) {
    await restoreStock(env, ok);
    const err = new HttpError(409, '在庫が足りない商品があります。カートを確認してください');
    err.failed = failed.map(f => f.product_id);
    throw err;
  }
}

async function restoreStock(env, items) {
  items = items.filter(it => it.product_id > 0);
  if (!items.length) return;
  await env.DB.batch(items.map(it =>
    env.DB.prepare(`UPDATE products SET stock = stock + ?1, updated_at = datetime('now') WHERE id = ?2`).bind(it.qty, it.product_id)
  ));
}

// 注文を取り消して在庫・抽選・クーポン・ポイント・コインを戻す（fromStatuses のときだけ）
async function releaseOrder(env, orderId, newStatus, fromStatuses) {
  const before = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();
  if (!before) return false;
  const placeholders = fromStatuses.map((_, i) => `?${i + 3}`).join(',');
  const upd = await env.DB.prepare(`UPDATE orders SET status = ?1 WHERE id = ?2 AND status IN (${placeholders})`).bind(newStatus, orderId, ...fromStatuses).run();
  if (upd.meta.changes !== 1) return false;
  const order = before;
  if (order.kind === 'coin') {
    // 付与済みのコインを取り消す
    if (['paid', 'shipped'].includes(before.status) && order.customer_id) await revokeCoins(env, order.customer_id, order.coins, `コイン購入の取消（${order.order_no}）`, order.id);
    return true;
  }
  if (order.kind === 'ship') {
    // 当選品の発送依頼のキャンセル：当選品は会員の獲得カードBOXに戻す（山には戻さない）
    await env.DB.prepare('UPDATE oripa_draws SET order_id = NULL WHERE order_id = ?').bind(orderId).run();
    if (order.coins > 0 && order.customer_id) await addCoins(env, order.customer_id, order.coins, `発送料の返却（${order.order_no}）`, { orderId: order.id });
    return true;
  }
  const { results } = await env.DB.prepare('SELECT product_id, qty FROM order_items WHERE order_id = ?').bind(orderId).all();
  await restoreStock(env, results);
  await releaseOrderDraws(env, orderId);
  if (order.coupon_code) await env.DB.prepare('UPDATE coupons SET used = MAX(0, used - 1) WHERE code = ?').bind(order.coupon_code).run();
  await reverseOrderPoints(env, order);
  const pids = results.map(r => r.product_id).filter(Boolean);
  if (pids.length && cfg(env).mailEnabled && cfg(env).features.restock) {
    const { results: w } = await env.DB.prepare(`SELECT DISTINCT product_id FROM restock_requests WHERE notified_at IS NULL AND product_id IN (${pids.map(() => '?').join(',')})`).bind(...pids).all();
    for (const r of w.slice(0, 5)) await notifyRestock(env, r.product_id);
  }
  return true;
}

async function expireOverdueOrders(env, limit = 5) {
  // 1回の処理での D1 問い合わせ回数に上限があるので、少しずつ処理する（残りは次回のcronで）
  const { results } = await env.DB.prepare(
    `SELECT id FROM orders WHERE status = 'awaiting_payment' AND expires_at IS NOT NULL AND expires_at < ? ORDER BY id LIMIT ?`
  ).bind(nowIso(), limit).all();
  let count = 0;
  for (const o of results) if (await releaseOrder(env, o.id, 'expired', ['awaiting_payment'])) count++;
  return count;
}

async function markPaid(env, order) {
  if (order.kind === 'coin') {
    // コイン購入：入金・決済の確認と同時にコインを付与して完了
    const r = await env.DB.prepare(`UPDATE orders SET status = 'shipped', paid_at = datetime('now'), shipped_at = datetime('now') WHERE id = ? AND status = 'awaiting_payment'`).bind(order.id).run();
    if (r.meta.changes === 1 && order.customer_id) await addCoins(env, order.customer_id, order.coins, `${cfg(env).coin.name}購入（${order.order_no}）`, { orderId: order.id });
    return r.meta.changes === 1;
  }
  const r = await env.DB.prepare(`UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'awaiting_payment'`).bind(order.id).run();
  if (r.meta.changes === 1 && cfg(env).points.grantOn === 'paid') await grantOrderPoints(env, order);
  return r.meta.changes === 1;
}

// ───────────────────────── クーポン ─────────────────────────

async function evaluateCoupon(env, rawCode, subtotal) {
  const code = str(rawCode, 40).toUpperCase();
  if (!code) return null;
  if (!cfg(env).features.coupons) throw new HttpError(400, 'クーポンは現在ご利用いただけません');
  const c = await env.DB.prepare('SELECT * FROM coupons WHERE code = ?').bind(code).first();
  if (!c || !c.active) throw new HttpError(400, 'このクーポンは使えません');
  if (c.ends_at && c.ends_at < nowIso()) throw new HttpError(400, 'クーポンの有効期限が切れています');
  if (c.max_uses > 0 && c.used >= c.max_uses) throw new HttpError(400, 'このクーポンは上限に達しました');
  if (subtotal <= 0) throw new HttpError(400, 'クーポンは通常商品にご利用いただけます（オリパは対象外）');
  if (subtotal < c.min_subtotal) throw new HttpError(400, `このクーポンは${yen(c.min_subtotal)}以上のご注文で使えます（オリパは対象外）`);
  const discount = Math.min(subtotal, c.type === 'percent' ? Math.floor(subtotal * Math.min(c.value, 100) / 100) : c.value);
  return { code, discount, label: c.type === 'percent' ? `${c.value}%OFF` : `${yen(c.value)}引き` };
}

// ───────────────────────── 注文 ─────────────────────────

async function newOrderNo(env) {
  for (let i = 0; i < 10; i++) {
    const n = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    const no = 'PK' + n;
    if (!(await env.DB.prepare('SELECT 1 FROM orders WHERE order_no = ?').bind(no).first())) return no;
  }
  throw new HttpError(500, '注文番号の発行に失敗しました');
}

async function priceCart(env, rawItems) {
  const c = cfg(env);
  const merged = new Map();
  for (const it of rawItems) { const id = int(it.product_id); const q = int(it.qty); if (id > 0 && q > 0) merged.set(id, (merged.get(id) || 0) + q); }
  if (!merged.size) return [];
  if (merged.size > 200) throw new HttpError(400, '一度に注文できるのは200種類までです');
  const ids = [...merged.keys()];
  const { results: prods } = await env.DB.prepare(
    `SELECT id, name, card_no, condition, price, stock, active FROM products WHERE id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).all();
  const byId = new Map(prods.map(p => [p.id, p]));
  return [...merged].map(([id, qty]) => {
    const p = byId.get(id);
    if (!p || !p.active) throw new HttpError(409, '販売終了した商品がカートに含まれています');
    if (qty > c.maxQtyPerItem) throw new HttpError(400, `1商品あたり${c.maxQtyPerItem}点までです`);
    return { product_id: id, oripa_id: 0, qty, name: p.name, card_no: p.card_no, condition: p.condition, price: p.price };
  });
}

// カート金額の計算（注文確定と見積もりで共通）
async function quote(env, body, customer) {
  const c = cfg(env);
  const raw = Array.isArray(body.items) ? body.items : [];
  const productItems = await priceCart(env, raw.filter(i => int(i.product_id) > 0));
  const oripaItems = await priceOripaItems(env, raw.filter(i => int(i.oripa_id) > 0));
  if (!productItems.length && !oripaItems.length) throw new HttpError(400, 'カートが空です');
  const productSubtotal = productItems.reduce((s, it) => s + it.price * it.qty, 0);
  const oripaSubtotal = oripaItems.reduce((s, it) => s + it.price * it.qty, 0);
  const subtotal = productSubtotal + oripaSubtotal;
  const coupon = body.coupon_code ? await evaluateCoupon(env, body.coupon_code, productSubtotal) : null;
  const discount = coupon ? coupon.discount : 0;

  const usePts = c.features.points && customer;
  const pointsBase = productSubtotal - discount + (c.points.oripaUse ? oripaSubtotal : 0);
  let pointsUse = Math.max(0, int(body.points_use));
  if (pointsUse > 0) {
    if (!usePts) throw new HttpError(400, 'ポイントを使うにはログインしてください');
    if (pointsUse < c.points.minUse) throw new HttpError(400, `ポイントは${c.points.minUse}ポイントから使えます`);
    if (pointsUse > customer.points) throw new HttpError(400, `ご利用可能なポイントは${customer.points}ポイントです`);
    if (pointsUse > pointsBase) pointsUse = pointsBase;
  }
  const pickup = body.shipping_method === 'pickup' && c.pickupEnabled;
  const shipping = pickup || subtotal >= c.freeShippingOver ? 0 : c.shippingFee;
  const total = subtotal - discount - pointsUse + shipping;
  const earnBase = productSubtotal - discount + (c.points.oripaEarn ? oripaSubtotal : 0) - pointsUse;
  const pointsEarn = usePts ? Math.max(0, Math.floor(earnBase * c.points.rate / 100)) : 0;
  return { productItems, oripaItems, productSubtotal, oripaSubtotal, subtotal, coupon, discount, pointsUse, pointsBase: usePts ? Math.min(pointsBase, customer.points) : 0, shipping, total, pointsEarn, pickup };
}

async function createOrder(req, env) {
  const c = cfg(env);
  await rateLimit(env, `order:${clientIp(req)}`, 15, 3600, '短時間にご注文が続いています。しばらくしてからお試しください');
  const body = await readJson(req);
  const customer = await getCustomer(req, env);
  if (!c.features.guestCheckout && !customer) throw new HttpError(401, 'ご購入には会員登録（ログイン）が必要です');

  const cu = body.customer || {};
  const info = {
    name: str(cu.name, 100), kana: str(cu.kana, 100), email: str(cu.email, 200) || customer?.email || '',
    phone: str(cu.phone, 30), zip: str(cu.zip, 10), address: str(cu.address, 300), note: str(cu.note, 1000),
  };
  if (c.features.coins && (Array.isArray(body.items) ? body.items : []).some(i => int(i.oripa_id) > 0)) throw new HttpError(400, `オリパはオリパのページから${c.coin.name}でお引きください`);
  const q = await quote(env, body, customer);
  if (q.oripaItems.length) {
    if (c.oripa.requireLogin && !customer) throw new HttpError(401, 'オリパのご購入には会員登録（ログイン）が必要です');
    if (c.phoneEnabled && c.phone.forOripa && !customer?.phone_e164) throw new HttpError(403, 'オリパのご購入には電話番号認証が必要です（マイページから認証できます）');
    if (!body.oripa_agree) throw new HttpError(400, 'オリパの注意事項への同意が必要です');
  }
  if (!info.name || !info.email || !info.phone) throw new HttpError(400, 'お名前・メール・電話番号は必須です');
  if (!q.pickup && (!info.zip || !info.address)) throw new HttpError(400, '郵便番号と住所を入力してください');
  if (!isEmail(info.email)) throw new HttpError(400, 'メールアドレスの形式が正しくありません');

  let method = body.payment_method === 'card' ? 'card' : 'bank';
  if (q.total > 0) {
    if (method === 'card' && !c.cardEnabled) throw new HttpError(400, 'カード決済は現在ご利用いただけません');
    if (method === 'bank' && !c.bankEnabled) throw new HttpError(400, '銀行振込は現在ご利用いただけません');
  } else method = 'points';
  if (method === 'bank') {
    // 未入金の注文で在庫を押さえ続けられないように
    const pend = await env.DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'awaiting_payment' AND payment_method = 'bank' AND (lower(email) = lower(?) OR customer_id = ?)`)
      .bind(info.email, customer ? customer.id : -1).first();
    if (pend.n >= 3) throw new HttpError(429, 'お支払い待ちのご注文が3件あります。お支払いまたは期限切れの後にご注文ください');
  }

  // 確保 → 失敗したら逆順に戻す
  const undo = [];
  const rollback = async () => { for (const f of undo.reverse()) { try { await f(); } catch (e) { console.error('rollback', e); } } };
  let draws = [];
  try {
    await reserveStock(env, q.productItems);
    undo.push(() => restoreStock(env, q.productItems));
    draws = await drawForItems(env, q.oripaItems);
    undo.push(() => undoDraws(env, draws));
    if (q.coupon) {
      const u = await env.DB.prepare('UPDATE coupons SET used = used + 1 WHERE code = ? AND active = 1 AND (max_uses = 0 OR used < max_uses)').bind(q.coupon.code).run();
      if (u.meta.changes !== 1) throw new HttpError(400, 'このクーポンは上限に達しました');
      undo.push(() => env.DB.prepare('UPDATE coupons SET used = MAX(0, used - 1) WHERE code = ?').bind(q.coupon.code).run());
    }
    if (q.pointsUse > 0) {
      await usePoints(env, customer.id, q.pointsUse);
      undo.push(() => addPoints(env, customer.id, q.pointsUse, 'ポイント返却（注文エラー）'));
    }
  } catch (e) { await rollback(); throw e; }

  const orderNo = await newOrderNo(env).catch(async e => { await rollback(); throw e; });
  const token = crypto.randomUUID();
  const expiresAt = method === 'bank' ? addMinutesIso(c.paymentDays * 24 * 60) : addMinutesIso(35);
  const items = [...q.productItems, ...q.oripaItems.map(o => ({ ...o, product_id: 0, card_no: '', condition: 'オリパ' }))];
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO orders (order_no, token, status, payment_method, shipping_method, customer_id, name, kana, email, phone, zip, address, note,
                             subtotal, discount, coupon_code, points_used, points_earn, shipping_fee, total, expires_at)
         VALUES (?, ?, 'awaiting_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(orderNo, token, method, q.pickup ? 'pickup' : 'delivery', customer ? customer.id : null, info.name, info.kana, info.email, info.phone,
        q.pickup ? '' : info.zip, q.pickup ? '' : info.address, info.note,
        q.subtotal, q.discount, q.coupon ? q.coupon.code : '', q.pointsUse, q.pointsEarn, q.shipping, q.total, expiresAt),
      ...items.map(it => env.DB.prepare(
        `INSERT INTO order_items (order_id, product_id, oripa_id, name, card_no, condition, price, qty)
         VALUES ((SELECT id FROM orders WHERE order_no = ?), ?, ?, ?, ?, ?, ?, ?)`
      ).bind(orderNo, it.product_id, it.oripa_id || 0, it.name, it.card_no, it.condition, it.price, it.qty)),
      ...draws.map(d => env.DB.prepare(
        `INSERT INTO oripa_draws (oripa_id, order_id, prize_id, is_last_one) VALUES (?, (SELECT id FROM orders WHERE order_no = ?), ?, ?)`
      ).bind(d.oripa_id, orderNo, d.prize_id, d.is_last_one)),
    ]);
  } catch (e) { await rollback(); throw e; }

  let order = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(orderNo).first();
  if (customer && q.pointsUse > 0) await env.DB.prepare('UPDATE point_ledger SET order_id = ? WHERE customer_id = ? AND order_id IS NULL AND delta = ? AND id = (SELECT MAX(id) FROM point_ledger WHERE customer_id = ?)')
    .bind(order.id, customer.id, -q.pointsUse, customer.id).run();
  // 会員の住所を保存
  if (customer && body.save_address && !q.pickup) {
    await env.DB.prepare('UPDATE customers SET kana = ?, phone = ?, zip = ?, address = ? WHERE id = ?').bind(info.kana, info.phone, info.zip, info.address, customer.id).run();
  }
  const result = { order_no: orderNo, token, total: q.total, payment_method: method };

  if (method === 'points') {
    await markPaid(env, order);
    order = { ...order, status: 'paid' };
    await sendMail(env, info.email, `【${c.shopName}】ご注文ありがとうございます（${orderNo}）`, orderMailText(env, order, items, 'paid'));
  } else if (method === 'card') {
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
    await sendMail(env, info.email, `【${c.shopName}】ご注文ありがとうございます（${orderNo}）`, orderMailText(env, order, items, 'created'));
  }
  await notifyAdmin(env, `新規注文 ${orderNo}（${{ bank: '振込', card: 'カード', points: 'ポイント' }[method]}${q.pickup ? '・店頭受取' : ''}${q.oripaItems.length ? '・オリパ' : ''}）${yen(q.total)} / ${info.name}`, orderMailText(env, order, items, 'admin'));
  return json(result, 201);
}

// コインを購入する（カード決済ならすぐ付与、振込なら入金確認後に付与）
async function createCoinOrder(req, env) {
  const c = cfg(env);
  if (!c.features.coins) throw new HttpError(400, '現在ご利用いただけません');
  const customer = await getCustomer(req, env);
  if (!customer) throw new HttpError(401, 'ログインしてください');
  await rateLimit(env, `order:${clientIp(req)}`, 15, 3600, '短時間にご注文が続いています。しばらくしてからお試しください');
  const b = await readJson(req);
  const pack = c.coin.packs[int(b.pack, -1)];
  if (!pack) throw new HttpError(400, '購入する金額を選んでください');
  const method = b.payment_method === 'card' ? 'card' : 'bank';
  if (method === 'card' && !c.cardEnabled) throw new HttpError(400, 'カード決済は現在ご利用いただけません');
  if (method === 'bank' && !c.bankEnabled) throw new HttpError(400, '銀行振込は現在ご利用いただけません');
  if (method === 'bank') {
    const pend = await env.DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'awaiting_payment' AND payment_method = 'bank' AND customer_id = ?`).bind(customer.id).first();
    if (pend.n >= 3) throw new HttpError(429, 'お支払い待ちのご注文が3件あります。お支払いまたは期限切れの後にご注文ください');
  }
  const orderNo = await newOrderNo(env);
  const token = crypto.randomUUID();
  const label = `${c.coin.name} ${pack.coins.toLocaleString()}`;
  const expiresAt = method === 'bank' ? addMinutesIso(c.paymentDays * 24 * 60) : addMinutesIso(35);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO orders (order_no, token, status, kind, coins, payment_method, shipping_method, customer_id, name, kana, email, phone, zip, address, note, subtotal, shipping_fee, total, expires_at)
       VALUES (?, ?, 'awaiting_payment', 'coin', ?, ?, 'none', ?, ?, ?, ?, ?, '', '', '', ?, 0, ?, ?)`
    ).bind(orderNo, token, pack.coins, method, customer.id, customer.name, customer.kana || '', customer.email, customer.phone || '-', pack.price, pack.price, expiresAt),
    env.DB.prepare(`INSERT INTO order_items (order_id, product_id, oripa_id, name, card_no, condition, price, qty) VALUES ((SELECT id FROM orders WHERE order_no = ?), 0, 0, ?, '', '', ?, 1)`)
      .bind(orderNo, label, pack.price),
  ]);
  const order = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(orderNo).first();
  const items = [{ oripa_id: 0, product_id: 0, name: label, card_no: '', condition: '', price: pack.price, qty: 1 }];
  const result = { order_no: orderNo, token, total: pack.price, payment_method: method };
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
    await sendMail(env, order.email, `【${c.shopName}】${c.coin.name}のご購入ありがとうございます（${orderNo}）`, orderMailText(env, order, items, 'created'));
  }
  await notifyAdmin(env, `${c.coin.name}購入 ${orderNo}（${method === 'bank' ? '振込' : 'カード'}）${yen(pack.price)} / ${customer.name}`, '');
  return json(result, 201);
}

// 獲得カードBOXの当選品を発送依頼する
async function createShipRequest(req, env) {
  const c = cfg(env);
  const customer = await getCustomer(req, env);
  if (!customer) throw new HttpError(401, 'ログインしてください');
  await rateLimit(env, `ship:${customer.id}`, 20, 3600);
  const b = await readJson(req);
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(x => int(x)).filter(n => n > 0))].slice(0, 500);
  if (!ids.length) throw new HttpError(400, '発送するカードを選んでください');
  const { results: mine } = await env.DB.prepare(
    `SELECT id FROM oripa_draws WHERE customer_id = ? AND order_id IS NULL AND id IN (${ids.map(() => '?').join(',')})`
  ).bind(customer.id, ...ids).all();
  if (mine.length !== ids.length) throw new HttpError(409, '発送できないカードが含まれています。画面を更新してください');
  const pickup = b.shipping_method === 'pickup' && c.pickupEnabled;
  const cu = b.customer || {};
  const info = { name: str(cu.name, 100) || customer.name, phone: str(cu.phone, 30) || customer.phone, zip: str(cu.zip, 10), address: str(cu.address, 300), note: str(cu.note, 1000) };
  if (!info.name || !info.phone) throw new HttpError(400, 'お名前と電話番号を入力してください');
  if (!pickup && (!info.zip || !info.address)) throw new HttpError(400, '郵便番号と住所を入力してください');
  const fee = c.coin.shipFee;
  const used = fee > 0 ? await spendCoins(env, customer.id, fee, '当選品の発送料') : [];
  const orderNo = await newOrderNo(env);
  const token = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO orders (order_no, token, status, kind, coins, payment_method, shipping_method, customer_id, name, kana, email, phone, zip, address, note, subtotal, shipping_fee, total, paid_at)
       VALUES (?, ?, 'paid', 'ship', ?, 'coin', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, datetime('now'))`
    ).bind(orderNo, token, fee, pickup ? 'pickup' : 'delivery', customer.id, info.name, customer.kana || '', customer.email, info.phone, pickup ? '' : info.zip, pickup ? '' : info.address, info.note).run();
  } catch (e) { await refundCoins(env, customer.id, used, '発送料の返却（エラー）'); throw e; }
  const order = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(orderNo).first();
  const u = await env.DB.prepare(
    `UPDATE oripa_draws SET order_id = ? WHERE customer_id = ? AND order_id IS NULL AND id IN (${ids.map(() => '?').join(',')})`
  ).bind(order.id, customer.id, ...ids).run();
  if (u.meta.changes !== ids.length) {
    await env.DB.prepare('UPDATE oripa_draws SET order_id = NULL WHERE order_id = ?').bind(order.id).run();
    await env.DB.prepare(`UPDATE orders SET status = 'cancelled' WHERE id = ?`).bind(order.id).run();
    await refundCoins(env, customer.id, used, '発送料の返却（エラー）');
    throw new HttpError(409, '発送できないカードが含まれています。画面を更新してください');
  }
  if (b.save_address && !pickup) await env.DB.prepare('UPDATE customers SET phone = ?, zip = ?, address = ? WHERE id = ?').bind(info.phone, info.zip, info.address, customer.id).run();
  await sendMail(env, order.email, `【${c.shopName}】当選品の発送依頼を受け付けました（${orderNo}）`,
    `${order.name} 様\n\nオリパ当選品 ${ids.length}点の${pickup ? 'お受け取り' : '発送'}依頼を受け付けました。\n${pickup ? '準備ができ次第ご連絡します。' : '発送しましたら追跡番号をお知らせします。'}\n\nご依頼の確認: ${(env.SITE_URL || '').replace(/\/$/, '')}/#/order/${orderNo}?t=${token}\n\n${c.shopName}`);
  await notifyAdmin(env, `当選品の発送依頼 ${orderNo} ${ids.length}点 / ${order.name}`, '');
  return json({ order_no: orderNo, token }, 201);
}

async function findOrderByToken(env, orderNo, token) {
  const order = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(orderNo).first();
  if (!order || order.status === 'deleted' || !token || !timingSafeEqual(token, order.token)) throw new HttpError(404, '注文が見つかりません');
  return order;
}

async function getOrderPublic(env, order) {
  const c = cfg(env);
  const { results: items } = await env.DB.prepare('SELECT product_id, oripa_id, name, card_no, condition, price, qty FROM order_items WHERE order_id = ?').bind(order.id).all();
  const carrier = CARRIERS[order.carrier];
  const canOpen = ['paid', 'shipped'].includes(order.status);
  const out = {
    order_no: order.order_no, status: order.status, status_label: order.kind === 'coin' && order.status === 'shipped' ? '付与済み' : order.kind === 'ship' && order.status === 'paid' ? '発送準備中' : STATUS_LABEL[order.status],
    kind: order.kind, coins: order.coins,
    payment_method: order.payment_method, shipping_method: order.shipping_method,
    name: order.name, zip: order.zip, address: order.address,
    subtotal: order.subtotal, discount: order.discount, coupon_code: order.coupon_code,
    points_used: order.points_used, points_earn: order.points_earn, points_granted: order.points_granted,
    shipping_fee: order.shipping_fee, total: order.total,
    carrier_label: carrier ? carrier.label : '', tracking_no: order.tracking_no,
    tracking_url: carrier && order.tracking_no ? carrier.url(order.tracking_no) : '',
    expires_at: order.expires_at, created_at: order.created_at, paid_at: order.paid_at, shipped_at: order.shipped_at, items,
    draws: await orderDraws(env, order.id, canOpen), can_open: canOpen,
  };
  if (order.payment_method === 'bank' && order.status === 'awaiting_payment') out.bank_info = c.bankInfo || '（振込先は管理者が設定してください）';
  if (order.shipping_method === 'pickup') out.pickup_info = c.pickupInfo;
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
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idem ? { 'Idempotency-Key': idem } : {}) },
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
    price_data: { currency: 'jpy', unit_amount: it.price, product_data: { name: it.oripa_id ? `オリパ：${it.name}` : `${it.name}${it.card_no ? ' ' + it.card_no : ''}${it.condition ? '［' + it.condition + '］' : ''}` } },
  }));
  if (order.shipping_fee > 0) line_items.push({ quantity: 1, price_data: { currency: 'jpy', unit_amount: order.shipping_fee, product_data: { name: '送料' } } });
  const params = {
    mode: 'payment', customer_email: order.email, client_reference_id: order.order_no, metadata: { order_no: order.order_no },
    success_url: `${site}/#/order/${order.order_no}?t=${order.token}&new=1`, cancel_url: `${site}/#/cart`,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    line_items: Object.fromEntries(line_items.map((li, i) => [i, li])),
  };
  const off = order.discount + order.points_used;
  if (off > 0) {
    const coupon = await stripe(env, 'coupons', { amount_off: off, currency: 'jpy', duration: 'once', max_redemptions: 1, name: order.points_used ? 'クーポン・ポイント利用' : `クーポン ${order.coupon_code}` }, `coupon-${order.order_no}`);
    params.discounts = { 0: { coupon: coupon.id } };
  }
  return stripe(env, 'checkout/sessions', params, `checkout-${order.order_no}`);
}

async function verifyStripeSignature(payload, header, secret) {
  const pairs = (header || '').split(',').map(kv => kv.trim());
  const t = (pairs.find(kv => kv.startsWith('t=')) || '').slice(2);
  const sigs = pairs.filter(kv => kv.startsWith('v1=')).map(kv => kv.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return sigs.some(s => timingSafeEqual(s, hex));
}

async function stripeWebhook(req, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(400, 'webhook not configured');
  const payload = await req.text();
  if (!(await verifyStripeSignature(payload, req.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) throw new HttpError(400, 'invalid signature');
  const event = JSON.parse(payload);
  const session = event.data?.object || {};
  const orderNo = session.metadata?.order_no || session.client_reference_id;
  if (!orderNo) return json({ received: true });
  const order = await env.DB.prepare('SELECT * FROM orders WHERE order_no = ?').bind(orderNo).first();
  if (!order) return json({ received: true });
  if (event.type === 'checkout.session.completed' && session.payment_status === 'paid') {
    if (await markPaid(env, order)) {
      const { results: items } = await env.DB.prepare('SELECT oripa_id, name, card_no, condition, price, qty FROM order_items WHERE order_id = ?').bind(order.id).all();
      const c = cfg(env);
      await sendMail(env, order.email, `【${c.shopName}】ご注文ありがとうございます（${orderNo}）`, orderMailText(env, { ...order, status: 'paid' }, items, 'paid'));
      await notifyAdmin(env, `カード決済完了 ${orderNo} ${yen(order.total)}`, '');
    }
  } else if (event.type === 'checkout.session.expired') {
    await releaseOrder(env, order.id, 'expired', ['awaiting_payment']);
  }
  return json({ received: true });
}

// ───────────────────────── メール本文 ─────────────────────────

function orderMailText(env, order, items, kind) {
  const c = cfg(env);
  const site = (env.SITE_URL || '').replace(/\/$/, '');
  const lines = items.map(it => it.oripa_id ? `・オリパ「${it.name}」 ${yen(it.price)} × ${it.qty}口` : `・${it.name}${it.card_no ? ' ' + it.card_no : ''}${it.condition ? '［' + it.condition + '］' : ''}  ${yen(it.price)} × ${it.qty}`).join('\n');
  const hasOripa = items.some(it => it.oripa_id);
  const url = `${site}/#/order/${order.order_no}?t=${order.token}`;
  const pickup = order.shipping_method === 'pickup';
  if (order.kind === 'coin') {
    const d = order.order_no.replace('PK', '');
    if (kind === 'paid') return `${order.name} 様\n\n${c.coin.name} ${order.coins.toLocaleString()} を付与しました。オリパのページからすぐにお使いいただけます。${c.coin.expireMonths ? `\n有効期限は付与から${c.coin.expireMonths}か月です。` : ''}\n\n■ 注文番号: ${order.order_no}\n${c.shopName}`;
    if (kind === 'created') return `${order.name} 様\n\n${c.coin.name}のご購入ありがとうございます。\n■ 注文番号: ${order.order_no}\n${c.coin.name} ${order.coins.toLocaleString()}　お支払い金額 ${yen(order.total)}\n\n■ お振込先\n${c.bankInfo}\n\n※ 振込名義の前に注文番号の数字（${d}）を入れてください。\n※ お支払い期限: ご注文から${c.paymentDays}日以内。ご入金を確認次第、${c.coin.name}を付与します。\n\nご注文状況の確認: ${url}\n\n${c.shopName}`;
  }
  const head = {
    created: `${order.name} 様\n\nこの度は${c.shopName}をご利用いただきありがとうございます。\n以下の内容でご注文を承りました。`,
    paid: `${order.name} 様\n\n${order.payment_method === 'card' ? 'カード決済が完了しました。' : order.payment_method === 'points' ? 'ポイントでのお支払いが完了しました。' : 'ご入金を確認いたしました。'}${hasOripa ? '\nオリパは下記のページから開封できます。' : ''}${pickup ? '店頭でのお受け取り準備ができ次第ご案内します。' : '発送まで今しばらくお待ちください。'}`,
    shipped: `${order.name} 様\n\n${pickup ? 'ご注文の商品のお受け取り準備ができました。' : 'ご注文の商品を発送いたしました。'}`,
    admin: '新規注文が入りました。',
  }[kind];
  let body = `${head}\n\n■ 注文番号: ${order.order_no}\n${lines}\n小計: ${yen(order.subtotal)}\n`;
  if (order.discount) body += `クーポン(${order.coupon_code}): -${yen(order.discount)}\n`;
  if (order.points_used) body += `ポイント利用: -${yen(order.points_used)}\n`;
  body += `${pickup ? '店頭受取' : '送料'}: ${yen(order.shipping_fee)}\n合計: ${yen(order.total)}\n`;
  if (order.points_earn && kind !== 'admin') body += `獲得予定ポイント: ${order.points_earn}pt（${c.points.grantOn === 'paid' ? '入金確認時' : '発送時'}に付与）\n`;
  if (kind === 'created' && order.payment_method === 'bank') {
    const d = order.order_no.replace('PK', '');
    body += `\n■ お振込先\n${c.bankInfo}\n\n※ 振込名義の前に注文番号の数字（${d}）を入れてください。\n   例) ${d} ヤマダタロウ\n※ お支払い期限: ご注文から${c.paymentDays}日以内。期限を過ぎると自動でキャンセルされます。\n`;
    if (hasOripa) body += '※ オリパはご入金確認後に開封できます。\n';
  }
  if (pickup && c.pickupInfo && kind !== 'admin') body += `\n■ 店頭受け取り\n${c.pickupInfo}\n`;
  if (kind === 'shipped' && order.tracking_no) {
    const cr = CARRIERS[order.carrier];
    body += `\n■ 配送: ${cr ? cr.label : ''} 追跡番号 ${order.tracking_no}\n${cr ? cr.url(order.tracking_no) + '\n' : ''}`;
  }
  if (kind === 'admin') body += `\nお客様: ${order.name} / ${order.email} / ${order.phone}${order.customer_id ? `（会員ID ${order.customer_id}）` : ''}\n${pickup ? '店頭受け取り' : `〒${order.zip} ${order.address}`}\n備考: ${order.note || '-'}\n`;
  else body += `\nご注文状況の確認: ${url}\n\n${c.shopName}`;
  return body;
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

async function saveProduct(env, id, p, syncGroup) {
  const before = id ? await env.DB.prepare('SELECT price, stock FROM products WHERE id = ?').bind(id).first() : null;
  if (id && !before) throw new HttpError(404, '商品が見つかりません');
  let newId = id;
  if (id) {
    await env.DB.prepare(`UPDATE products SET ${PRODUCT_FIELDS.map(f => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .bind(...PRODUCT_FIELDS.map(f => p[f]), id).run();
  } else {
    const r = await env.DB.prepare(`INSERT INTO products (${PRODUCT_FIELDS.join(',')}) VALUES (${PRODUCT_FIELDS.map(() => '?').join(',')})`)
      .bind(...PRODUCT_FIELDS.map(f => p[f])).run();
    newId = r.meta.last_row_id;
  }
  if (!before || before.price !== p.price) await recordPrice(env, newId, p.price);
  // カード名など共通情報を同じカードの他の状態にも反映
  if (syncGroup && p.group_key) {
    await env.DB.prepare(`UPDATE products SET ${SHARED_FIELDS.map(f => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE group_key = ? AND id != ?`)
      .bind(...SHARED_FIELDS.map(f => p[f]), p.group_key, newId).run();
  }
  const notified = before && before.stock <= 0 && p.stock > 0 ? await notifyRestock(env, newId) : 0;
  return { id: newId, notified };
}

// CSV 取り込み（D1 への問い合わせ回数を抑えるため、まとめて batch で書き込む）
//  mode: 'upsert' = ID（または型番＋状態）が一致すれば更新・なければ追加 / 'update' = 一致した商品だけ更新（追加しない）
//  stock_mode: 'set' = 在庫を上書き / 'add' = 在庫に加算
//  match: 'id' = ID で照合 / 'card' = ID が無い行は 型番＋状態（＋商品名）で照合
async function importProducts(env, body) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const mode = body.mode === 'update' ? 'update' : 'upsert';
  const stockMode = body.stock_mode === 'add' ? 'add' : 'set';
  const matchCard = body.match === 'card';
  if (!rows.length) throw new HttpError(400, '取り込むデータがありません');
  if (rows.length > 300) throw new HttpError(400, '一度に送れるのは300行までです');
  const ids = [...new Set(rows.map(r => int(r.id)).filter(n => n > 0))];
  const byId = new Map();
  if (ids.length) {
    const { results } = await env.DB.prepare(`SELECT * FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    results.forEach(p => byId.set(p.id, p));
  }
  const byCard = new Map();
  if (matchCard) {
    const nos = [...new Set(rows.filter(r => !int(r.id) && r.card_no).map(r => str(r.card_no, 50)))];
    if (nos.length) {
      const { results } = await env.DB.prepare(`SELECT * FROM products WHERE card_no IN (${nos.map(() => '?').join(',')})`).bind(...nos).all();
      results.forEach(p => {
        byCard.set(`${normKey(p.card_no)}|${normKey(p.condition)}|${normKey(p.name)}`, p);
        const k2 = `${normKey(p.card_no)}|${normKey(p.condition)}|`;
        byCard.set(k2, byCard.has(k2) ? null : p); // 型番＋状態だけで一意なら照合に使う
      });
    }
  }
  const stmts = [], errors = [], restocked = [];
  let created = 0, updated = 0, skipped = 0;
  rows.forEach((r, i) => {
    try {
      let cur = int(r.id) ? byId.get(int(r.id)) : null;
      if (int(r.id) && !cur) throw new Error(`ID ${r.id} の商品が見つかりません`);
      if (!cur && matchCard && r.card_no) {
        cur = byCard.get(`${normKey(r.card_no)}|${normKey(r.condition || 'A')}|${normKey(r.name)}`) || byCard.get(`${normKey(r.card_no)}|${normKey(r.condition || 'A')}|`) || null;
      }
      if (!cur && mode === 'update') { skipped++; return; }
      const given = Object.fromEntries(Object.entries(r).filter(([k, v]) => PRODUCT_FIELDS.includes(k) && v !== undefined && v !== null && String(v).trim() !== ''));
      if (cur) {
        const merged = { ...cur, images: parseImages(cur.images), ...given };
        if ('stock' in given && stockMode === 'add') merged.stock = cur.stock + int(given.stock);
        if (!('group_key' in given) && ('name' in given || 'card_no' in given) && cur.group_key === autoGroupKey(cur)) merged.group_key = '';
        const p = cleanProduct(merged);
        stmts.push(env.DB.prepare(`UPDATE products SET ${PRODUCT_FIELDS.map(f => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).bind(...PRODUCT_FIELDS.map(f => p[f]), cur.id));
        if (p.price !== cur.price) stmts.push(env.DB.prepare('INSERT INTO price_history (product_id, price) VALUES (?, ?)').bind(cur.id, p.price));
        if (cur.stock <= 0 && p.stock > 0) restocked.push(cur.id);
        updated++;
      } else {
        const p = cleanProduct(given);
        stmts.push(env.DB.prepare(`INSERT INTO products (${PRODUCT_FIELDS.join(',')}) VALUES (${PRODUCT_FIELDS.map(() => '?').join(',')})`).bind(...PRODUCT_FIELDS.map(f => p[f])));
        stmts.push(env.DB.prepare('INSERT INTO price_history (product_id, price) VALUES (last_insert_rowid(), ?)').bind(p.price));
        created++;
      }
    } catch (e) { errors.push({ row: int(body.offset) + i + 2, message: e.message }); }
  });
  if (stmts.length) await env.DB.batch(stmts);
  let notified = 0;
  for (const id of restocked.slice(0, 5)) notified += await notifyRestock(env, id);
  return { created, updated, skipped, errors, notified };
}

async function adminOrders(env, url) {
  await expireOverdueOrders(env, 2);
  const status = url.searchParams.get('status');
  const q = status && STATUSES.includes(status)
    ? env.DB.prepare('SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT 500').bind(status)
    : env.DB.prepare(`SELECT * FROM orders WHERE status != 'deleted' ORDER BY id DESC LIMIT 500`);
  const { results: orders } = await q.all();
  if (orders.length) {
    const ph = orders.map(() => '?').join(',');
    const ids = orders.map(o => o.id);
    const [{ results: items }, { results: draws }] = await Promise.all([
      env.DB.prepare(`SELECT order_id, product_id, oripa_id, name, card_no, condition, price, qty FROM order_items WHERE order_id IN (${ph})`).bind(...ids).all(),
      env.DB.prepare(`SELECT d.order_id, d.prize_id, d.is_last_one, d.revealed_at, p.rank, p.name, p.value, o.title FROM oripa_draws d JOIN oripa_prizes p ON p.id = d.prize_id JOIN oripas o ON o.id = d.oripa_id WHERE d.order_id IN (${ph})`).bind(...ids).all(),
    ]);
    const gi = {}, gd = {};
    items.forEach(it => (gi[it.order_id] ||= []).push(it));
    draws.forEach(d => (gd[d.order_id] ||= []).push(d));
    orders.forEach(o => { o.items = gi[o.id] || []; o.draws = gd[o.id] || []; delete o.token; });
  }
  return json(orders);
}

// ───────────────────────── 管理者の認証 ─────────────────────────
// 1) 管理キー（＋2段階認証コード）で /api/admin/login → 12時間有効のセッションを発行
// 2) 以降は X-Admin-Session ヘッダーで認証。管理キーそのものはブラウザに残さない
const ADMIN_KEY_MIN = 20;
const randHex = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');

async function requireAdmin(req, env) {
  const sess = req.headers.get('X-Admin-Session') || '';
  if (/^[a-f0-9]{64}$/.test(sess)) {
    const row = await env.DB.prepare(`SELECT 1 FROM admin_sessions WHERE token_hash = ? AND expires_at > datetime('now')`).bind(await sha256hex(sess)).first();
    if (row) return;
    throw new HttpError(401, 'ログインの有効期限が切れました。もう一度ログインしてください');
  }
  // スクリプト用：2段階認証を設定していない場合だけ管理キーを直接使える
  const key = req.headers.get('X-Admin-Key') || '';
  if (key && !env.ADMIN_TOTP_SECRET) {
    const ip = clientIp(req);
    if (await overLimit(env, `adminfail:${ip}`, 5)) throw new HttpError(429, 'ログインの失敗が続いたため、15分間ロックしています');
    const adminKey = String(env.ADMIN_KEY || '').trim();
    if (adminKey.length >= ADMIN_KEY_MIN && timingSafeEqual(key.trim(), adminKey)) return;
    await rateLimit(env, `adminfail:${ip}`, 1000, 900);
  }
  throw new HttpError(401, '管理画面にログインしてください');
}

async function adminLogin(req, env) {
  const ip = clientIp(req);
  const adminKey = String(env.ADMIN_KEY || '').trim(); // コピペで紛れた前後の空白・改行は無視
  if (adminKey.length < ADMIN_KEY_MIN) throw new HttpError(503, `ADMIN_KEY が未設定か短すぎます（${ADMIN_KEY_MIN}文字以上にしてください）`);
  if (await overLimit(env, `adminfail:${ip}`, 5) || await overLimit(env, 'adminfail:all', 30)) throw new HttpError(429, 'ログインの失敗が続いたため、しばらくロックしています');
  const b = await readJson(req);
  let ok = timingSafeEqual(String(b.key || '').trim(), adminKey);
  if (ok && env.ADMIN_TOTP_SECRET) {
    const step = await verifyTotp(env.ADMIN_TOTP_SECRET, b.otp);
    ok = step !== null && (await rateLimit(env, `totp:${step}`, 1000, 120)) === 1; // 同じコードの使い回しを防ぐ
  }
  if (!ok) {
    await rateLimit(env, `adminfail:${ip}`, 1000, 900);
    await rateLimit(env, 'adminfail:all', 1000, 3600);
    await env.DB.prepare('INSERT INTO admin_log (ip, action) VALUES (?, ?)').bind(ip, 'ログイン失敗').run();
    throw new HttpError(401, env.ADMIN_TOTP_SECRET ? '管理キーか認証コードが違います' : '管理キーが違います');
  }
  const token = randHex();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO admin_sessions (token_hash, ip, expires_at) VALUES (?, ?, datetime('now', '+12 hours'))`).bind(await sha256hex(token), ip),
    env.DB.prepare('INSERT INTO admin_log (ip, action) VALUES (?, ?)').bind(ip, 'ログイン'),
  ]);
  return json({ session: token });
}

async function adminRoutes(req, env, path, url) {
  if (path === '/api/admin/auth-info' && req.method === 'GET') return json({ totp: Boolean(env.ADMIN_TOTP_SECRET), ready: String(env.ADMIN_KEY || '').trim().length >= ADMIN_KEY_MIN });
  if (path === '/api/admin/login' && req.method === 'POST') return adminLogin(req, env);
  if (path === '/api/admin/logout' && req.method === 'POST') {
    const sess = req.headers.get('X-Admin-Session') || '';
    if (sess) await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(await sha256hex(sess)).run();
    return json({ ok: true });
  }
  await requireAdmin(req, env);
  const res = await adminRoutesInner(req, env, path, url);
  if (req.method !== 'GET' && res.status < 400) {
    await env.DB.prepare('INSERT INTO admin_log (ip, action) VALUES (?, ?)').bind(clientIp(req), `${req.method} ${path.replace('/api/admin/', '')}`).run().catch(() => {});
  }
  return res;
}

async function adminRoutesInner(req, env, path, url) {
  const m = req.method;
  const c = cfg(env);

  if (path === '/api/admin/ping') return json({ ok: true });
  if (path === '/api/admin/log' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT at, ip, action FROM admin_log ORDER BY id DESC LIMIT 200').all();
    return json(results);
  }

  if (path === '/api/admin/settings' && m === 'GET') return json({ settings: c, env: { stripe: Boolean(env.STRIPE_SECRET_KEY), webhook: Boolean(env.STRIPE_WEBHOOK_SECRET), mail: c.mailEnabled, sms: c.smsReady, totp: Boolean(env.ADMIN_TOTP_SECRET), r2: Boolean(env.IMAGES), siteUrl: env.SITE_URL || '' } });
  if (path === '/api/admin/settings' && m === 'PUT') return json({ settings: await saveSettings(env, await readJson(req)) });

  if (path === '/api/admin/stats' && m === 'GET') {
    await expireOverdueOrders(env, 2);
    const sum = since => env.DB.prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS sales FROM orders WHERE status IN ('paid','shipped') AND COALESCE(paid_at, created_at) >= datetime('now', ?)`
    ).bind(since).first();
    const [today, week, month] = await Promise.all([sum('-1 day'), sum('-7 days'), sum('-30 days')]);
    const counts = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all();
    const { results: top } = await env.DB.prepare(`SELECT p.id, p.name, p.card_no, p.condition, p.stock, s.sold FROM products p ${SOLD_SUBQUERY} WHERE s.sold > 0 ORDER BY s.sold DESC LIMIT 10`).all();
    const { results: waiting } = await env.DB.prepare(
      `SELECT p.id, p.name, p.card_no, p.condition, p.stock, COUNT(r.id) AS waiting FROM restock_requests r JOIN products p ON p.id = r.product_id
        WHERE r.notified_at IS NULL GROUP BY p.id ORDER BY waiting DESC LIMIT 10`
    ).all();
    const { results: daily } = await env.DB.prepare(
      `SELECT date(COALESCE(paid_at, created_at), '+9 hours') AS d, COALESCE(SUM(total),0) AS sales, COUNT(*) AS orders
         FROM orders WHERE status IN ('paid','shipped') AND COALESCE(paid_at, created_at) >= datetime('now','-30 days') GROUP BY d ORDER BY d`
    ).all();
    const stock = await env.DB.prepare('SELECT COUNT(*) AS items, COALESCE(SUM(stock),0) AS units, COALESCE(SUM(stock*price),0) AS value FROM products WHERE active = 1').first();
    const members = await env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(points),0) AS points, SUM(created_at >= datetime('now','-30 days')) AS new30 FROM customers WHERE deleted = 0`).first();
    const oripa = await env.DB.prepare(
      `SELECT COALESCE(SUM(oi.price*oi.qty),0) AS sales, COALESCE(SUM(oi.qty),0) AS draws FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.oripa_id > 0 AND o.status IN ('paid','shipped') AND COALESCE(o.paid_at, o.created_at) >= datetime('now','-30 days')`
    ).first();
    const coins = await env.DB.prepare(
      `SELECT COALESCE(SUM(CASE WHEN paid = 1 THEN remaining END),0) AS paid_unused, COALESCE(SUM(remaining),0) AS unused FROM coin_lots WHERE remaining > 0 AND (expires_at IS NULL OR expires_at > datetime('now'))`
    ).first();
    const coinSales = await env.DB.prepare(`SELECT COALESCE(SUM(total),0) AS sales FROM orders WHERE kind = 'coin' AND status = 'shipped' AND paid_at >= datetime('now','-30 days')`).first();
    const prizeBox = await env.DB.prepare('SELECT COUNT(*) AS n FROM oripa_draws WHERE customer_id IS NOT NULL AND order_id IS NULL').first();
    const paidStatus = await env.DB.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' AND kind != 'coin'`).first();
    return json({ today, week, month, status: Object.fromEntries(counts.results.map(r => [r.status, r.n])), to_ship: paidStatus.n, top, waiting, daily, stock, members, oripa,
      coins: { ...coins, sales30: coinSales.sales, prize_box: prizeBox.n, expireMonths: c.coin.expireMonths } });
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
  if (path === '/api/admin/products' && m === 'POST') { const b = await readJson(req); return json(await saveProduct(env, 0, cleanProduct(b), truthy(b.sync_group)), 201); }
  if (path === '/api/admin/products/import' && m === 'POST') return json(await importProducts(env, await readJson(req)), 201);
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
  if (mm && m === 'PUT') { const b = await readJson(req); return json(await saveProduct(env, int(mm[1]), cleanProduct(b), truthy(b.sync_group))); }
  if (mm && m === 'DELETE') {
    const id = int(mm[1]);
    if (await env.DB.prepare('SELECT 1 FROM order_items WHERE product_id = ? LIMIT 1').bind(id).first()) {
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
  if (path === '/api/admin/orders' && m === 'GET') return adminOrders(env, url);
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
      const { results: items } = await env.DB.prepare('SELECT oripa_id, name, card_no, condition, price, qty FROM order_items WHERE order_id = ?').bind(id).all();
      const o2 = { ...order, tracking_no: tracking, carrier };
      if (to === 'paid') {
        if (order.status !== 'awaiting_payment') throw new HttpError(400, '入金待ちの注文だけ入金確認にできます');
        await markPaid(env, order);
        if (body.notify !== false) await sendMail(env, order.email, `【${c.shopName}】ご入金を確認しました（${order.order_no}）`, orderMailText(env, o2, items, 'paid'));
      } else if (to === 'shipped') {
        if (order.status !== 'paid') throw new HttpError(400, '入金確認済みの注文だけ発送済みにできます');
        await env.DB.prepare(`UPDATE orders SET status = 'shipped', shipped_at = datetime('now') WHERE id = ?`).bind(id).run();
        await grantOrderPoints(env, order);
        const subj = order.shipping_method === 'pickup' ? 'お受け取りの準備ができました' : '商品を発送しました';
        if (body.notify !== false) await sendMail(env, order.email, `【${c.shopName}】${subj}（${order.order_no}）`, orderMailText(env, o2, items, 'shipped'));
      } else if (to === 'cancelled') {
        const from = order.kind === 'coin' ? ['awaiting_payment', 'shipped'] : ['awaiting_payment', 'paid'];
        if (!(await releaseOrder(env, id, 'cancelled', from))) throw new HttpError(400, 'この注文はキャンセルできません');
      } else throw new HttpError(400, 'このステータスには変更できません');
    }
    return json({ ok: true });
  }

  // 注文の削除：進行中のものはキャンセルと同じく在庫・オリパ・ポイント・コインを戻してから、一覧・履歴・売上から外す
  if (mm && m === 'DELETE') {
    const id = int(mm[1]);
    const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
    if (!order || order.status === 'deleted') throw new HttpError(404, '注文が見つかりません');
    const active = order.kind === 'coin' ? ['awaiting_payment', 'shipped'] : order.kind === 'ship' ? ['paid'] : ['awaiting_payment', 'paid'];
    const released = active.includes(order.status) && await releaseOrder(env, id, 'deleted', active);
    if (!released) await env.DB.prepare(`UPDATE orders SET status = 'deleted' WHERE id = ?`).bind(id).run();
    return json({ ok: true, released: Boolean(released) });
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

  const r1 = await adminMemberRoutes(req, env, path, url);
  if (r1) return r1;
  const r3 = await adminCoinRoutes(req, env, path);
  if (r3) return r3;
  const r2 = await adminOripaRoutes(req, env, path);
  if (r2) return r2;
  throw new HttpError(404, 'not found');
}

// ───────────────────────── ルーティング ─────────────────────────

async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const c = cfg(env);
  const cache = { 'Cache-Control': 'public, max-age=15' };

  if (path === '/api/config' && req.method === 'GET') return json(publicConfig(c), 200, cache);
  if (path === '/api/products' && req.method === 'GET') return json(await listPublicProducts(env), 200, cache);
  let m = path.match(/^\/api\/products\/(\d+)$/);
  if (m && req.method === 'GET') {
    const p = await env.DB.prepare(`SELECT ${PUBLIC_COLS}, COALESCE(s.sold,0) AS sold FROM products p ${SOLD_SUBQUERY} WHERE p.id = ? AND p.active = 1`).bind(int(m[1])).first();
    if (!p) throw new HttpError(404, '商品が見つかりません');
    return json(publicProduct(p));
  }
  m = path.match(/^\/api\/products\/(\d+)\/history$/);
  if (m && req.method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT price, at FROM price_history WHERE product_id = ? AND at >= datetime('now','-365 days') ORDER BY at, id`).bind(int(m[1])).all();
    return json(results, 200, { 'Cache-Control': 'public, max-age=300' });
  }
  if (path === '/api/restock' && req.method === 'POST') {
    if (!c.features.restock) throw new HttpError(403, '入荷通知は現在ご利用いただけません');
    await rateLimit(env, `restock:${clientIp(req)}`, 20, 3600);
    const b = await readJson(req);
    const email = str(b.email, 200);
    if (!isEmail(email)) throw new HttpError(400, 'メールアドレスの形式が正しくありません');
    const p = await env.DB.prepare('SELECT id FROM products WHERE id = ? AND active = 1').bind(int(b.product_id)).first();
    if (!p) throw new HttpError(404, '商品が見つかりません');
    await env.DB.prepare(
      `INSERT INTO restock_requests (product_id, email) VALUES (?, ?) ON CONFLICT(product_id, email) DO UPDATE SET notified_at = NULL, created_at = datetime('now')`
    ).bind(p.id, email).run();
    return json({ ok: true }, 201);
  }
  if (path === '/api/quote' && req.method === 'POST') {
    await rateLimit(env, `quote:${clientIp(req)}`, 300, 600);
    const customer = await getCustomer(req, env);
    const b = await readJson(req);
    const q = await quote(env, b, customer);
    return json({
      subtotal: q.subtotal, product_subtotal: q.productSubtotal, oripa_subtotal: q.oripaSubtotal, discount: q.discount,
      coupon: q.coupon, points_use: q.pointsUse, points_max: q.pointsBase, shipping: q.shipping, total: q.total, points_earn: q.pointsEarn,
      points_balance: customer ? customer.points : null,
    });
  }
  if (path === '/api/coupon' && req.method === 'POST') {
    await rateLimit(env, `coupon:${clientIp(req)}`, 30, 600);
    const b = await readJson(req);
    const items = await priceCart(env, (Array.isArray(b.items) ? b.items : []).filter(i => int(i.product_id) > 0));
    const c2 = await evaluateCoupon(env, b.code, items.reduce((s, it) => s + it.price * it.qty, 0));
    if (!c2) throw new HttpError(400, 'クーポンコードを入力してください');
    return json(c2);
  }
  if (path === '/api/orders' && req.method === 'POST') return createOrder(req, env);
  if (path === '/api/coins/buy' && req.method === 'POST') return createCoinOrder(req, env);
  if (path === '/api/me/prizes/ship' && req.method === 'POST') return createShipRequest(req, env);
  const rc = await coinRoutes(req, env, path);
  if (rc) return rc;
  m = path.match(/^\/api\/orders\/(PK\d{6})$/);
  if (m && req.method === 'GET') return getOrderPublic(env, await findOrderByToken(env, m[1], url.searchParams.get('t')));
  m = path.match(/^\/api\/orders\/(PK\d{6})\/reveal$/);
  if (m && req.method === 'POST') {
    const order = await findOrderByToken(env, m[1], url.searchParams.get('t'));
    if (!['paid', 'shipped'].includes(order.status)) throw new HttpError(400, 'ご入金確認後に開封できます');
    await revealOrder(env, order.id);
    return getOrderPublic(env, order);
  }
  if (path === '/api/stripe/webhook' && req.method === 'POST') return stripeWebhook(req, env);
  m = path.match(/^\/img\/([a-f0-9-]{36}\.(?:webp|jpg|png))$/);
  if (m && req.method === 'GET') return serveImage(env, m[1]);
  if (path.startsWith('/api/admin/')) return adminRoutes(req, env, path, url);
  const r1 = await memberRoutes(req, env, path);
  if (r1) return r1;
  const r2 = await oripaPublicRoutes(req, env, path);
  if (r2) return r2;
  if (path === '/') return json({ ok: true, service: 'PKlabo EC API' });
  throw new HttpError(404, 'not found');
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
};

async function cleanup(env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(Math.floor(Date.now() / 1000)),
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`),
    env.DB.prepare(`DELETE FROM admin_sessions WHERE expires_at < datetime('now')`),
    env.DB.prepare(`DELETE FROM password_resets WHERE expires_at < datetime('now')`),
    env.DB.prepare(`DELETE FROM email_verifications WHERE expires_at < datetime('now')`),
    env.DB.prepare(`DELETE FROM admin_log WHERE at < datetime('now', '-180 days')`),
  ]);
}

export default {
  async fetch(req, baseEnv) {
    const headers = cors(baseEnv, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const env = Object.create(baseEnv); // リクエストごとに設定を持つ（同時リクエストで混ざらないように）
    try {
      await loadConfig(env);
      const res = await handle(req, env);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(headers)) if (!(k === 'Access-Control-Allow-Origin' && out.headers.has(k))) out.headers.set(k, v);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
      if (!out.headers.has('Cache-Control')) out.headers.set('Cache-Control', 'no-store'); // 個人情報を含む応答はキャッシュさせない
      return out;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      return json({ error: status === 500 ? 'サーバーエラーが発生しました' : e.message, failed: e.failed, failed_oripa: e.failed_oripa }, status, { ...headers, ...SECURITY_HEADERS, 'Cache-Control': 'no-store' });
    }
  },
  // 15分ごと：入金期限切れの注文を自動キャンセル、ポイント失効
  async scheduled(event, baseEnv, ctx) {
    const env = Object.create(baseEnv);
    ctx.waitUntil((async () => {
      await loadConfig(env);
      await expireOverdueOrders(env);
      await expirePoints(env);
      await expireCoins(env);
      await cleanup(env);
    })());
  },
};
