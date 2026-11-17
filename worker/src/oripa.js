// オリパ（オリジナルパック）
// 方針: 口数・封入数・残数を常に公開 / 当選品は実物を発送（ポイント等への交換なし）/ 抽選は注文時にサーバーで行い、入金確認後に開封

import { HttpError, json, int, str, readJson, randomInt, truthy, toSql } from './util.js';
import { cfg } from './config.js';

const PUBLIC_PRIZE = 'id, rank, name, image_url, qty, remaining, value, is_last_one, sort';

function requireOripa(env) {
  if (!cfg(env).features.oripa) throw new HttpError(403, 'オリパは現在販売していません');
}

// 公開する賞ごとの残り数は「支払い済みの抽選」だけを反映する。
// 未入金の注文の抽選結果まで反映すると、残り数の減り方から入金前に中身を推測でき、
// ハズレなら払わずに期限切れにする「引き直し」ができてしまうため。
async function prizesFor(env, ids) {
  if (!ids.length) return {};
  const { results } = await env.DB.prepare(
    `SELECT p.oripa_id, p.id, p.rank, p.name, p.image_url, p.qty, p.value, p.is_last_one, p.sort, p.qty - COALESCE(d.n, 0) AS remaining
       FROM oripa_prizes p
       LEFT JOIN (SELECT dr.prize_id, COUNT(*) AS n FROM oripa_draws dr JOIN orders o ON o.id = dr.order_id
                   WHERE o.status IN ('paid','shipped') GROUP BY dr.prize_id) d ON d.prize_id = p.id
      WHERE p.oripa_id IN (${ids.map(() => '?').join(',')}) ORDER BY p.is_last_one DESC, p.sort, p.value DESC, p.id`
  ).bind(...ids).all();
  const g = {};
  results.forEach(p => (g[p.oripa_id] ||= []).push(p));
  return g;
}

const isOpen = o => o.status === 'live' && (!o.starts_at || o.starts_at <= toSql(new Date())) && (!o.ends_at || o.ends_at > toSql(new Date()));

function publicOripa(o, prizes) {
  const confirmed = (prizes || []).filter(p => !p.is_last_one).reduce((s, p) => s + (p.qty - p.remaining), 0);
  return {
    pending: Math.max(0, o.sold - confirmed), // お支払い待ちの口数
    id: o.id, title: o.title, image_url: o.image_url, description: o.description, price: o.price,
    total: o.total, sold: o.sold, remaining: o.total - o.sold, max_per_order: o.max_per_order,
    status: o.status, open: isOpen(o) && o.sold < o.total, starts_at: o.starts_at, ends_at: o.ends_at, prizes: prizes || [],
  };
}

export async function oripaPublicRoutes(req, env, path) {
  if (path === '/api/oripas' && req.method === 'GET') {
    requireOripa(env);
    const { results } = await env.DB.prepare(
      `SELECT * FROM oripas WHERE status = 'live' OR (status = 'ended' AND updated_at > datetime('now','-14 days')) ORDER BY status = 'live' DESC, sort DESC, id DESC`
    ).all();
    const pz = await prizesFor(env, results.map(o => o.id));
    return json(results.map(o => publicOripa(o, pz[o.id])), 200, { 'Cache-Control': 'public, max-age=5' });
  }
  const m = path.match(/^\/api\/oripas\/(\d+)$/);
  if (m && req.method === 'GET') {
    requireOripa(env);
    const o = await env.DB.prepare(`SELECT * FROM oripas WHERE id = ? AND status IN ('live','ended')`).bind(int(m[1])).first();
    if (!o) throw new HttpError(404, 'オリパが見つかりません');
    const pz = await prizesFor(env, [o.id]);
    const { results: recent } = await env.DB.prepare(
      `SELECT p.rank, p.name, p.image_url, p.value, d.is_last_one, d.revealed_at FROM oripa_draws d JOIN oripa_prizes p ON p.id = d.prize_id
        WHERE d.oripa_id = ? AND d.revealed_at IS NOT NULL ORDER BY d.revealed_at DESC LIMIT 20`
    ).bind(o.id).all();
    return json({ ...publicOripa(o, pz[o.id]), recent }, 200, { 'Cache-Control': 'public, max-age=5' });
  }
  return null;
}

// 注文用：オリパの価格チェック
export async function priceOripaItems(env, rawItems) {
  const merged = new Map();
  for (const it of rawItems) { const id = int(it.oripa_id); const q = int(it.qty); if (id > 0 && q > 0) merged.set(id, (merged.get(id) || 0) + q); }
  if (!merged.size) return [];
  requireOripa(env);
  const ids = [...merged.keys()];
  const { results } = await env.DB.prepare(`SELECT * FROM oripas WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
  const byId = new Map(results.map(o => [o.id, o]));
  const out = [];
  for (const [id, qty] of merged) {
    const o = byId.get(id);
    if (!o || !isOpen(o)) throw new HttpError(409, '販売期間外のオリパがカートに含まれています');
    const limit = Math.min(o.max_per_order || 9999, cfg(env).oripa.maxPerOrder);
    if (qty > limit) throw new HttpError(400, `「${o.title}」は1回の注文で${limit}口までです`);
    if (o.total - o.sold < qty) { const e = new HttpError(409, `「${o.title}」の残りが${o.total - o.sold}口です`); e.failed_oripa = [id]; throw e; }
    out.push({ oripa_id: id, qty, name: o.title, price: o.price });
  }
  return out;
}

// n口をまとめて抽選する。確率は残り封入数に比例（＝実際の山から引くのと同じ）。D1 への問い合わせ回数は口数によらず一定
async function drawBatch(env, oripaId, n) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const up = await env.DB.prepare(
      `UPDATE oripas SET sold = sold + ?1, updated_at = datetime('now') WHERE id = ?2 AND status = 'live' AND sold + ?1 <= total`
    ).bind(n, oripaId).run();
    if (up.meta.changes !== 1) { const e = new HttpError(409, 'オリパの残り口数が足りません'); e.failed_oripa = [oripaId]; throw e; }
    const { results } = await env.DB.prepare('SELECT id, remaining FROM oripa_prizes WHERE oripa_id = ? AND is_last_one = 0 AND remaining > 0').bind(oripaId).all();
    const left = results.map(p => ({ id: p.id, left: p.remaining, take: 0 }));
    let sum = left.reduce((s, p) => s + p.left, 0);
    const draws = [];
    if (sum >= n) {
      for (let i = 0; i < n; i++) {
        let r = randomInt(sum);
        const p = left.find(x => (r -= x.left) < 0);
        p.left--; p.take++; sum--;
        draws.push({ oripa_id: oripaId, prize_id: p.id, is_last_one: 0 });
      }
      const taken = left.filter(p => p.take > 0);
      const res = await env.DB.batch(taken.map(p => env.DB.prepare('UPDATE oripa_prizes SET remaining = remaining - ?1 WHERE id = ?2 AND remaining >= ?1').bind(p.take, p.id)));
      const okRows = taken.filter((p, i) => res[i].meta.changes === 1);
      if (okRows.length === taken.length) {
        const o = await env.DB.prepare('SELECT sold, total FROM oripas WHERE id = ?').bind(oripaId).first();
        if (o.sold >= o.total) {
          const lo = await env.DB.prepare('UPDATE oripa_prizes SET remaining = 0 WHERE oripa_id = ? AND is_last_one = 1 AND remaining > 0 RETURNING id').bind(oripaId).first();
          if (lo) draws.push({ oripa_id: oripaId, prize_id: lo.id, is_last_one: 1 });
        }
        return draws;
      }
      // 同時購入と競合した → 戻してやり直し
      if (okRows.length) await env.DB.batch(okRows.map(p => env.DB.prepare('UPDATE oripa_prizes SET remaining = remaining + ? WHERE id = ?').bind(p.take, p.id)));
    }
    await env.DB.prepare('UPDATE oripas SET sold = MAX(0, sold - ?) WHERE id = ?').bind(n, oripaId).run();
    if (sum < n) throw new HttpError(409, 'オリパの在庫に不整合があります。お店にお問い合わせください');
  }
  throw new HttpError(409, 'ただいま購入が集中しています。もう一度お試しください');
}

async function undoDraws(env, draws) {
  if (!draws.length) return;
  const byPrize = {}, byOripa = {};
  for (const d of draws) {
    byPrize[d.prize_id] = (byPrize[d.prize_id] || 0) + 1;
    if (!d.is_last_one) byOripa[d.oripa_id] = (byOripa[d.oripa_id] || 0) + 1;
  }
  await env.DB.batch([
    ...Object.entries(byPrize).map(([id, k]) => env.DB.prepare('UPDATE oripa_prizes SET remaining = remaining + ? WHERE id = ?').bind(k, +id)),
    ...Object.entries(byOripa).map(([id, k]) => env.DB.prepare(`UPDATE oripas SET sold = MAX(0, sold - ?), updated_at = datetime('now') WHERE id = ?`).bind(k, +id)),
  ]);
}

export async function drawForItems(env, items) {
  const all = [];
  try {
    for (const it of items) all.push(...await drawBatch(env, it.oripa_id, it.qty));
  } catch (e) {
    await undoDraws(env, all);
    throw e;
  }
  return all;
}
export { undoDraws };

// キャンセル・期限切れ：抽選結果を山に戻す
export async function releaseOrderDraws(env, orderId) {
  const { results } = await env.DB.prepare('SELECT oripa_id, prize_id, is_last_one FROM oripa_draws WHERE order_id = ?').bind(orderId).all();
  if (!results.length) return;
  await undoDraws(env, results);
  await env.DB.prepare('DELETE FROM oripa_draws WHERE order_id = ?').bind(orderId).run();
}

export async function orderDraws(env, orderId, reveal) {
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.oripa_id, o.title, d.is_last_one, d.revealed_at, p.rank, p.name, p.image_url, p.value
       FROM oripa_draws d JOIN oripa_prizes p ON p.id = d.prize_id JOIN oripas o ON o.id = d.oripa_id
      WHERE d.order_id = ? ORDER BY d.id`
  ).bind(orderId).all();
  if (reveal) return results;
  return results.map(d => ({ id: d.id, oripa_id: d.oripa_id, title: d.title, hidden: true }));
}

export async function revealOrder(env, orderId) {
  await env.DB.prepare(`UPDATE oripa_draws SET revealed_at = datetime('now') WHERE order_id = ? AND revealed_at IS NULL`).bind(orderId).run();
}

// ── 管理 ──

function cleanPrize(p) {
  return {
    id: int(p.id) || null, rank: str(p.rank, 30), name: str(p.name, 200), image_url: str(p.image_url, 1000),
    qty: Math.max(0, int(p.qty)), value: Math.max(0, int(p.value)), is_last_one: truthy(p.is_last_one), sort: int(p.sort),
  };
}

export async function adminOripaRoutes(req, env, path) {
  const m = req.method;
  if (path === '/api/admin/oripas' && m === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM oripas ORDER BY id DESC').all();
    const ids = results.map(o => o.id);
    const pz = {};
    if (ids.length) {
      const { results: ps } = await env.DB.prepare(`SELECT * FROM oripa_prizes WHERE oripa_id IN (${ids.map(() => '?').join(',')}) ORDER BY is_last_one DESC, sort, value DESC, id`).bind(...ids).all();
      ps.forEach(p => (pz[p.oripa_id] ||= []).push(p));
    }
    return json(results.map(o => ({ ...o, prizes: pz[o.id] || [] })));
  }

  if (path === '/api/admin/oripas' && m === 'POST') {
    const b = await readJson(req);
    const id = int(b.id);
    const meta = {
      title: str(b.title, 200), image_url: str(b.image_url, 1000), description: str(b.description, 5000),
      price: Math.max(0, int(b.price)), max_per_order: Math.max(1, int(b.max_per_order, 10)),
      status: ['draft', 'live', 'ended'].includes(b.status) ? b.status : 'draft',
      starts_at: b.starts_at ? toSql(new Date(b.starts_at)) : null, ends_at: b.ends_at ? toSql(new Date(b.ends_at)) : null, sort: int(b.sort),
    };
    if (!meta.title) throw new HttpError(400, 'タイトルを入力してください');
    if (meta.price <= 0) throw new HttpError(400, '1口の価格を入力してください');
    const prizes = (Array.isArray(b.prizes) ? b.prizes : []).map(cleanPrize).filter(p => p.name);
    const total = prizes.filter(p => !p.is_last_one).reduce((s, p) => s + p.qty, 0);
    if (meta.status === 'live' && total <= 0) throw new HttpError(400, '賞品（封入数）を登録してから公開してください');
    if (prizes.filter(p => p.is_last_one).length > 1) throw new HttpError(400, 'ラストワン賞は1つまでです');

    if (!id) {
      const r = await env.DB.prepare(
        `INSERT INTO oripas (title, image_url, description, price, total, sold, status, max_per_order, starts_at, ends_at, sort) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
      ).bind(meta.title, meta.image_url, meta.description, meta.price, total, meta.status, meta.max_per_order, meta.starts_at, meta.ends_at, meta.sort).run();
      const oid = r.meta.last_row_id;
      if (prizes.length) await env.DB.batch(prizes.map(p => env.DB.prepare(
        'INSERT INTO oripa_prizes (oripa_id, rank, name, image_url, qty, remaining, value, is_last_one, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(oid, p.rank, p.name, p.image_url, p.is_last_one ? 1 : p.qty, p.is_last_one ? 1 : p.qty, p.value, p.is_last_one, p.sort)));
      return json({ id: oid }, 201);
    }

    const cur = await env.DB.prepare('SELECT * FROM oripas WHERE id = ?').bind(id).first();
    if (!cur) throw new HttpError(404, 'オリパが見つかりません');
    const drawn = await env.DB.prepare('SELECT COUNT(*) AS n FROM oripa_draws WHERE oripa_id = ?').bind(id).first();
    const { results: curPrizes } = await env.DB.prepare('SELECT * FROM oripa_prizes WHERE oripa_id = ?').bind(id).all();
    if (drawn.n > 0) {
      // 販売開始後は封入内容（数）を変えられない。名前・画像・ランク・参考価格だけ変更可
      const same = prizes.length === curPrizes.length && prizes.every(p => {
        const c = curPrizes.find(x => x.id === p.id);
        return c && c.is_last_one === p.is_last_one && (p.is_last_one || c.qty === p.qty);
      });
      if (!same) throw new HttpError(400, '販売が始まったオリパは、賞品の追加・削除・封入数の変更ができません（公平性のため）');
      await env.DB.batch([
        env.DB.prepare(`UPDATE oripas SET title=?, image_url=?, description=?, price=?, status=?, max_per_order=?, starts_at=?, ends_at=?, sort=?, updated_at=datetime('now') WHERE id=?`)
          .bind(meta.title, meta.image_url, meta.description, cur.price, meta.status, meta.max_per_order, meta.starts_at, meta.ends_at, meta.sort, id),
        ...prizes.map(p => env.DB.prepare('UPDATE oripa_prizes SET rank=?, name=?, image_url=?, value=?, sort=? WHERE id=? AND oripa_id=?').bind(p.rank, p.name, p.image_url, p.value, p.sort, p.id, id)),
      ]);
      return json({ id, note: cur.price !== meta.price ? '販売開始後のため価格は変更していません' : undefined });
    }
    await env.DB.batch([
      env.DB.prepare(`UPDATE oripas SET title=?, image_url=?, description=?, price=?, total=?, sold=0, status=?, max_per_order=?, starts_at=?, ends_at=?, sort=?, updated_at=datetime('now') WHERE id=?`)
        .bind(meta.title, meta.image_url, meta.description, meta.price, total, meta.status, meta.max_per_order, meta.starts_at, meta.ends_at, meta.sort, id),
      env.DB.prepare('DELETE FROM oripa_prizes WHERE oripa_id = ?').bind(id),
      ...prizes.map(p => env.DB.prepare(
        'INSERT INTO oripa_prizes (oripa_id, rank, name, image_url, qty, remaining, value, is_last_one, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(id, p.rank, p.name, p.image_url, p.is_last_one ? 1 : p.qty, p.is_last_one ? 1 : p.qty, p.value, p.is_last_one, p.sort)),
    ]);
    return json({ id });
  }

  let mm = path.match(/^\/api\/admin\/oripas\/(\d+)$/);
  if (mm && m === 'DELETE') {
    const id = int(mm[1]);
    const drawn = await env.DB.prepare('SELECT COUNT(*) AS n FROM oripa_draws WHERE oripa_id = ?').bind(id).first();
    if (drawn.n > 0) throw new HttpError(400, '販売実績があるため削除できません。終了にしてください');
    await env.DB.batch([env.DB.prepare('DELETE FROM oripa_prizes WHERE oripa_id = ?').bind(id), env.DB.prepare('DELETE FROM oripas WHERE id = ?').bind(id)]);
    return json({ ok: true });
  }
  mm = path.match(/^\/api\/admin\/oripas\/(\d+)\/draws$/);
  if (mm && m === 'GET') {
    const { results } = await env.DB.prepare(
      `SELECT d.id, d.is_last_one, d.created_at, d.revealed_at, p.rank, p.name, p.value, o.order_no, o.status, o.name AS customer
         FROM oripa_draws d JOIN oripa_prizes p ON p.id = d.prize_id JOIN orders o ON o.id = d.order_id
        WHERE d.oripa_id = ? ORDER BY d.id DESC LIMIT 1000`
    ).bind(int(mm[1])).all();
    return json(results);
  }
  return null;
}
