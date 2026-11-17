// コイン（オリパ用の前払いポイント）
// ・購入ごとに有効期限つきの「ロット」で管理し、期限の近いものから使う
// ・有効期限を購入から6か月以内にしておけば、資金決済法の前払式支払手段の対象外
// ・当選カードをコインに戻す機能は作らない（換金性の問題を避けるため。当選品は実物発送のみ）

import { HttpError, json, int, str, readJson, rateLimit } from './util.js';
import { cfg } from './config.js';
import { getCustomer } from './members.js';
import { drawForItems, undoDraws, prizeTiers, publicDraw } from './oripa.js';

const expiresSql = months => months > 0 ? `datetime('now', '+${int(months)} months')` : 'NULL';

// コインを付与（購入・無償付与・返却）
export async function addCoins(env, customerId, amount, reason, { paid = 1, orderId = null } = {}) {
  amount = int(amount);
  if (amount <= 0) return;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO coin_lots (customer_id, amount, remaining, paid, expires_at, order_id) VALUES (?, ?, ?, ?, ${expiresSql(cfg(env).coin.expireMonths)}, ?)`)
      .bind(customerId, amount, amount, paid ? 1 : 0, orderId),
    env.DB.prepare('UPDATE customers SET coins = coins + ? WHERE id = ?').bind(amount, customerId),
    env.DB.prepare('INSERT INTO coin_ledger (customer_id, delta, reason, order_id) VALUES (?, ?, ?, ?)').bind(customerId, amount, str(reason, 100), orderId),
  ]);
}

// コインを使う。残高チェックは1文で行うので同時に使われても残高がマイナスにならない
export async function spendCoins(env, customerId, amount, reason, orderId = null) {
  amount = int(amount);
  if (amount <= 0) return [];
  const r = await env.DB.prepare('UPDATE customers SET coins = coins - ?1 WHERE id = ?2 AND coins >= ?1').bind(amount, customerId).run();
  if (r.meta.changes !== 1) throw new HttpError(400, `${cfg(env).coin.name}が足りません`);
  const { results: lots } = await env.DB.prepare(
    `SELECT id, remaining FROM coin_lots WHERE customer_id = ? AND remaining > 0 AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY expires_at IS NULL, expires_at, id`
  ).bind(customerId).all();
  let need = amount; const used = [];
  for (const l of lots) { if (need <= 0) break; const take = Math.min(l.remaining, need); used.push({ id: l.id, take }); need -= take; }
  await env.DB.batch([
    ...used.map(u => env.DB.prepare('UPDATE coin_lots SET remaining = remaining - ? WHERE id = ?').bind(u.take, u.id)),
    env.DB.prepare('INSERT INTO coin_ledger (customer_id, delta, reason, order_id) VALUES (?, ?, ?, ?)').bind(customerId, -amount, str(reason, 100), orderId),
  ]);
  return used;
}

// 使ったコインを同じロットに戻す（抽選エラー時など）
export async function refundCoins(env, customerId, used, reason) {
  const total = used.reduce((s, u) => s + u.take, 0);
  if (!total) return;
  await env.DB.batch([
    ...used.map(u => env.DB.prepare('UPDATE coin_lots SET remaining = remaining + ? WHERE id = ?').bind(u.take, u.id)),
    env.DB.prepare('UPDATE customers SET coins = coins + ? WHERE id = ?').bind(total, customerId),
    env.DB.prepare('INSERT INTO coin_ledger (customer_id, delta, reason) VALUES (?, ?, ?)').bind(customerId, total, str(reason, 100)),
  ]);
}

// 付与済みのコインを取り消す（コイン購入のキャンセル・管理者による減算）。足りない分は0で止める
export async function revokeCoins(env, customerId, amount, reason, orderId = null) {
  amount = int(amount);
  if (amount <= 0) return 0;
  const { results: lots } = await env.DB.prepare(
    `SELECT id, remaining FROM coin_lots WHERE customer_id = ? AND remaining > 0 ORDER BY (order_id = ?) DESC, expires_at IS NULL, expires_at, id`
  ).bind(customerId, orderId ?? -1).all();
  let need = amount; const used = [];
  for (const l of lots) { if (need <= 0) break; const take = Math.min(l.remaining, need); used.push({ id: l.id, take }); need -= take; }
  const taken = amount - need;
  await env.DB.batch([
    ...used.map(u => env.DB.prepare('UPDATE coin_lots SET remaining = remaining - ? WHERE id = ?').bind(u.take, u.id)),
    env.DB.prepare('UPDATE customers SET coins = MAX(0, coins - ?) WHERE id = ?').bind(taken, customerId),
    env.DB.prepare('INSERT INTO coin_ledger (customer_id, delta, reason, order_id) VALUES (?, ?, ?, ?)').bind(customerId, -taken, str(reason, 100), orderId),
  ]);
  return taken;
}

// 期限切れのコインを失効させる（cron）
export async function expireCoins(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, customer_id, remaining FROM coin_lots WHERE remaining > 0 AND expires_at IS NOT NULL AND expires_at <= datetime('now') LIMIT 40`
  ).all();
  if (!results.length) return 0;
  await env.DB.batch(results.flatMap(l => [
    env.DB.prepare('UPDATE coin_lots SET remaining = 0 WHERE id = ?').bind(l.id),
    env.DB.prepare('UPDATE customers SET coins = MAX(0, coins - ?) WHERE id = ?').bind(l.remaining, l.customer_id),
    env.DB.prepare('INSERT INTO coin_ledger (customer_id, delta, reason) VALUES (?, ?, ?)').bind(l.customer_id, -l.remaining, '有効期限切れ'),
  ]));
  return results.length;
}

export async function coinSummary(env, customerId) {
  const [next, { results: ledger }, box] = await Promise.all([
    env.DB.prepare(`SELECT expires_at, SUM(remaining) AS amount FROM coin_lots WHERE customer_id = ? AND remaining > 0 AND expires_at IS NOT NULL AND expires_at > datetime('now') GROUP BY expires_at ORDER BY expires_at LIMIT 1`).bind(customerId).first(),
    env.DB.prepare('SELECT delta, reason, created_at FROM coin_ledger WHERE customer_id = ? ORDER BY id DESC LIMIT 50').bind(customerId).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM oripa_draws WHERE customer_id = ? AND order_id IS NULL').bind(customerId).first(),
  ]);
  return { next_expire: next || null, ledger, prize_box: box.n };
}

// ── 公開API ──

export async function coinRoutes(req, env, path) {
  const c = cfg(env);

  // コインでオリパを引く（その場で結果が出る）
  const m = path.match(/^\/api\/oripas\/(\d+)\/draw$/);
  if (m && req.method === 'POST') {
    if (!c.features.coins) throw new HttpError(400, 'オリパはご注文から購入してください');
    const cust = await getCustomer(req, env);
    if (!cust) throw new HttpError(401, 'ログインしてください');
    if (c.phoneEnabled && c.phone.forOripa && !cust.phone_e164) throw new HttpError(403, 'オリパのご購入には電話番号認証が必要です（マイページから認証できます）');
    const b = await readJson(req);
    if (!b.agree) throw new HttpError(400, 'オリパの注意事項への同意が必要です');
    await rateLimit(env, `draw:${cust.id}`, 120, 600, '短時間に抽選が続いています。少しおいてからお試しください');
    const o = await env.DB.prepare('SELECT * FROM oripas WHERE id = ?').bind(int(m[1])).first();
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    if (!o || o.status !== 'live' || (o.starts_at && o.starts_at > now) || (o.ends_at && o.ends_at <= now)) throw new HttpError(409, 'このオリパは販売期間外です');
    // ボード形式：選んだパックの番号（重複なし・1〜総口数・まだ開けられていないもの）
    const slots = o.pick_mode ? [...new Set((Array.isArray(b.slots) ? b.slots : []).map(n => int(n)))].filter(n => n >= 1 && n <= o.total) : null;
    if (o.pick_mode && (!slots.length || slots.length !== (Array.isArray(b.slots) ? b.slots.length : 0))) throw new HttpError(400, '開けるパックを選んでください');
    const qty = o.pick_mode ? slots.length : int(b.qty);
    const limit = Math.min(o.max_per_order || 9999, c.oripa.maxPerOrder);
    if (qty < 1 || qty > limit) throw new HttpError(400, `1回に${o.pick_mode ? '開けられる' : '引ける'}のは${limit}口までです`);
    if (slots) {
      const taken = await env.DB.prepare(`SELECT slot FROM oripa_draws WHERE oripa_id = ? AND slot IN (${slots.map(() => '?').join(',')})`).bind(o.id, ...slots).all();
      if (taken.results.length) throw new HttpError(409, `${taken.results.map(r => r.slot).join('・')}番のパックは先に開けられました。別のパックを選んでください`);
    }
    const cost = o.price * qty;
    const used = await spendCoins(env, cust.id, cost, `オリパ「${o.title}」${qty}口`);
    let draws;
    try { draws = await drawForItems(env, [{ oripa_id: o.id, qty }]); }
    catch (e) { await refundCoins(env, cust.id, used, `返却：オリパ「${o.title}」（抽選できませんでした）`); throw e; }
    // 選んだ番号を、引いた順に割り当てる（ラストワン賞は番号なし）
    let si = 0;
    draws.forEach(d => { d.slot = slots && !d.is_last_one ? slots[si++] : null; });
    try {
      await env.DB.batch(draws.map(d => env.DB.prepare(
        `INSERT INTO oripa_draws (oripa_id, order_id, customer_id, prize_id, is_last_one, revealed_at, slot) VALUES (?, NULL, ?, ?, ?, datetime('now'), ?)`
      ).bind(d.oripa_id, cust.id, d.prize_id, d.is_last_one, d.slot)));
    } catch (e) {
      await undoDraws(env, draws);
      await refundCoins(env, cust.id, used, `返却：オリパ「${o.title}」（${/UNIQUE/i.test(String(e.message)) ? '同じパックが同時に開けられました' : 'エラー'}）`);
      if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, '選んだパックがほかの方と同時に開けられました。コインは戻しています。別のパックを選んでください');
      throw e;
    }
    const ids = [...new Set(draws.map(d => d.prize_id))];
    const { results: prizes } = await env.DB.prepare(`SELECT id, rank, name, image_url, value FROM oripa_prizes WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    const byId = new Map(prizes.map(p => [p.id, p]));
    const bal = await env.DB.prepare('SELECT coins FROM customers WHERE id = ?').bind(cust.id).first();
    const tiers = await prizeTiers(env, [o.id]);
    return json({
      draws: draws.map(d => publicDraw(env, { ...byId.get(d.prize_id), prize_id: d.prize_id, is_last_one: d.is_last_one, title: o.title, slot: d.slot }, tiers)),
      coins: bal.coins, cost,
    });
  }

  if (path === '/api/me/coins' && req.method === 'GET') {
    const cust = await getCustomer(req, env);
    if (!cust) throw new HttpError(401, 'ログインしてください');
    return json({ coins: cust.coins, ...(await coinSummary(env, cust.id)) });
  }

  // 獲得カードBOX（まだ発送依頼していない当選品）
  if (path === '/api/me/prizes' && req.method === 'GET') {
    const cust = await getCustomer(req, env);
    if (!cust) throw new HttpError(401, 'ログインしてください');
    const { results } = await env.DB.prepare(
      `SELECT d.id, d.is_last_one, d.created_at, p.rank, p.name, p.image_url, o.title
         FROM oripa_draws d JOIN oripa_prizes p ON p.id = d.prize_id JOIN oripas o ON o.id = d.oripa_id
        WHERE d.customer_id = ? AND d.order_id IS NULL ORDER BY d.id DESC LIMIT 500`
    ).bind(cust.id).all();
    return json(results);
  }
  return null;
}

// ── 管理：コインの付与・減算 ──
export async function adminCoinRoutes(req, env, path) {
  const g = path.match(/^\/api\/admin\/members\/(\d+)\/coins$/);
  if (g && req.method === 'GET') {
    const id = int(g[1]);
    const c = await env.DB.prepare('SELECT coins FROM customers WHERE id = ?').bind(id).first();
    const { results: ledger } = await env.DB.prepare('SELECT delta, reason, created_at FROM coin_ledger WHERE customer_id = ? ORDER BY id DESC LIMIT 200').bind(id).all();
    const box = await env.DB.prepare('SELECT COUNT(*) AS n FROM oripa_draws WHERE customer_id = ? AND order_id IS NULL').bind(id).first();
    return json({ coins: c ? c.coins : 0, ledger, prize_box: box.n });
  }
  const m = path.match(/^\/api\/admin\/members\/(\d+)\/coins$/);
  if (m && req.method === 'POST') {
    const b = await readJson(req);
    const delta = int(b.delta);
    if (!delta) throw new HttpError(400, 'コイン数を入力してください');
    const reason = str(b.reason, 100) || '管理者による調整';
    if (delta > 0) await addCoins(env, int(m[1]), delta, reason, { paid: 0 });
    else await revokeCoins(env, int(m[1]), -delta, reason);
    return json({ ok: true });
  }
  return null;
}
