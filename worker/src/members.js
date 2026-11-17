// 会員登録・ログイン・ポイント

import { HttpError, json, int, str, isEmail, readJson, sha256hex, nowIso, toSql, sendMail, timingSafeEqual, clientIp, rateLimit, overLimit } from './util.js';
import { cfg } from './config.js';

const ITER = 100000; // Workers の PBKDF2 上限
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function pbkdf2(password, salt, iter = ITER) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(await pbkdf2(password, salt))}`;
}
async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2') return false;
  return timingSafeEqual(b64(await pbkdf2(password, unb64(salt), int(iter))), hash);
}
const randToken = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');

function requireMembers(env) {
  if (!cfg(env).features.members) throw new HttpError(403, '会員機能は現在ご利用いただけません');
}
function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) throw new HttpError(400, 'パスワードは8文字以上にしてください');
}

async function createSession(env, customerId) {
  const token = randToken();
  await env.DB.prepare(`INSERT INTO sessions (token_hash, customer_id, expires_at) VALUES (?, ?, datetime('now', '+90 days'))`)
    .bind(await sha256hex(token), customerId).run();
  return token;
}

export async function getCustomer(req, env) {
  const h = req.headers.get('Authorization') || '';
  const m = h.match(/^Bearer ([a-f0-9]{64})$/);
  if (!m || !cfg(env).features.members) return null;
  const row = await env.DB.prepare(
    `SELECT c.* FROM sessions s JOIN customers c ON c.id = s.customer_id WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND c.deleted = 0`
  ).bind(await sha256hex(m[1])).first();
  return row || null;
}

async function requireCustomer(req, env) {
  const c = await getCustomer(req, env);
  if (!c) throw new HttpError(401, 'ログインしてください');
  return c;
}

const profile = c => ({
  id: c.id, email: c.email, email_verified: Boolean(c.email_verified), phone_verified: Boolean(c.phone_e164),
  phone_verified_number: c.phone_e164 ? '0' + c.phone_e164.slice(3, 5) + '-****-' + c.phone_e164.slice(-4) : '', name: c.name, kana: c.kana, phone: c.phone, zip: c.zip, address: c.address,
  points: c.points, points_updated_at: c.points_updated_at, created_at: c.created_at,
});

// ── ポイント ──

export async function addPoints(env, customerId, delta, reason, orderId = null, allowNegative = false) {
  delta = int(delta);
  if (!delta) return true;
  const r = await env.DB.prepare(
    allowNegative
      ? `UPDATE customers SET points = MAX(0, points + ?1), points_updated_at = datetime('now') WHERE id = ?2`
      : `UPDATE customers SET points = points + ?1, points_updated_at = datetime('now') WHERE id = ?2 AND points + ?1 >= 0`
  ).bind(delta, customerId).run();
  if (r.meta.changes !== 1) return false;
  await env.DB.prepare('INSERT INTO point_ledger (customer_id, delta, reason, order_id) VALUES (?, ?, ?, ?)')
    .bind(customerId, delta, str(reason, 100), orderId).run();
  return true;
}

// 注文確定時：ポイント利用
export async function usePoints(env, customerId, amount) {
  if (amount <= 0) return;
  const ok = await addPoints(env, customerId, -amount, '注文でポイント利用');
  if (!ok) throw new HttpError(400, 'ポイントが足りません');
}

// 注文のポイントを付与（発送時 or 入金時）
export async function grantOrderPoints(env, order) {
  if (!order.customer_id || order.points_earn <= 0 || order.points_granted) return;
  const r = await env.DB.prepare('UPDATE orders SET points_granted = 1 WHERE id = ? AND points_granted = 0').bind(order.id).run();
  if (r.meta.changes === 1) await addPoints(env, order.customer_id, order.points_earn, `ご購入ポイント（${order.order_no}）`, order.id);
}

// キャンセル・期限切れ：使ったポイントを戻し、付与済みポイントを取り消す
export async function reverseOrderPoints(env, order) {
  if (!order.customer_id) return;
  if (order.points_used > 0) await addPoints(env, order.customer_id, order.points_used, `ポイント返却（${order.order_no} キャンセル）`, order.id);
  if (order.points_granted) {
    await env.DB.prepare('UPDATE orders SET points_granted = 0 WHERE id = ?').bind(order.id).run();
    await addPoints(env, order.customer_id, -order.points_earn, `付与ポイント取消（${order.order_no}）`, order.id, true);
  }
}

export async function expirePoints(env) {
  const days = cfg(env).points.expireDays;
  if (!days) return 0;
  const { results } = await env.DB.prepare(
    `SELECT id, points FROM customers WHERE points > 0 AND deleted = 0 AND points_updated_at < datetime('now', ?)`
  ).bind(`-${days} days`).all();
  for (const c of results) await addPoints(env, c.id, -c.points, '有効期限切れ', null, true);
  return results.length;
}

async function sendVerifyMail(env, id, email, name) {
  const c = cfg(env);
  const token = randToken();
  await env.DB.prepare(`INSERT INTO email_verifications (token_hash, customer_id, expires_at) VALUES (?, ?, datetime('now', '+3 days'))`).bind(await sha256hex(token), id).run();
  const site = (env.SITE_URL || '').replace(/\/$/, '');
  await sendMail(env, email, `【${c.shopName}】メールアドレスの確認`,
    `${name} 様\n\n${c.shopName}への会員登録ありがとうございます。\n以下のリンクを開いて、メールアドレスの確認を完了してください（3日以内）。\n${site}/#/verify?token=${token}\n${c.features.points && c.points.signupBonus ? `\n確認が完了すると、登録ボーナス${c.points.signupBonus}ポイントをお付けします。\n` : ''}\nお心当たりがない場合はこのメールを破棄してください。\n${c.shopName}`);
}

// 登録ボーナスは「メール確認（メール送信を設定している場合）」と「電話番号認証（SMS認証で必須にしている場合）」が済んでから
async function grantSignupBonus(env, id) {
  const c = cfg(env);
  const cust = await env.DB.prepare('SELECT email_verified, phone_e164 FROM customers WHERE id = ?').bind(id).first();
  if (!cust) return 0;
  if (c.mailEnabled && !cust.email_verified) return 0;
  if (c.phoneEnabled && c.phone.forBonus && !cust.phone_e164) return 0;
  const r = await env.DB.prepare('UPDATE customers SET bonus_granted = 1 WHERE id = ? AND bonus_granted = 0').bind(id).run();
  if (r.meta.changes !== 1 || !c.features.points || c.points.signupBonus <= 0) return 0;
  await addPoints(env, id, c.points.signupBonus, '新規会員登録ボーナス');
  return c.points.signupBonus;
}

// 日本の携帯番号だけ受け付ける（海外の高額番号へのSMS送信を使った不正を防ぐ）
export function normalizePhone(v) {
  let s = String(v ?? '').normalize('NFKC').replace(/[^\d+]/g, '');
  if (s.startsWith('+81')) s = '0' + s.slice(3);
  else if (s.startsWith('81') && s.length === 12) s = '0' + s.slice(2);
  return /^0[789]0\d{8}$/.test(s) ? '+81' + s.slice(1) : null;
}

async function twilio(env, path, params) {
  const res = await fetch(`https://verify.twilio.com/v2/Services/${env.TWILIO_VERIFY_SID}/${path}`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 404 && path === 'VerificationCheck') return { status: 'expired' };
  if (!res.ok) { console.error('twilio', res.status, data); throw new HttpError(502, 'SMSの送信に失敗しました。番号を確認して、しばらくしてからお試しください'); }
  return data;
}

// ── 公開API ──

export async function memberRoutes(req, env, path) {
  const m = req.method;
  const c = cfg(env);

  if (path === '/api/auth/register' && m === 'POST') {
    requireMembers(env);
    await rateLimit(env, `reg:${clientIp(req)}`, 5, 3600, '短時間に登録が続いています。しばらくしてからお試しください');
    const b = await readJson(req);
    const email = str(b.email, 200).toLowerCase();
    if (!isEmail(email)) throw new HttpError(400, 'メールアドレスの形式が正しくありません');
    checkPassword(b.password);
    const name = str(b.name, 100);
    if (!name) throw new HttpError(400, 'お名前を入力してください');
    const exists = await env.DB.prepare('SELECT 1 FROM customers WHERE email = ?').bind(email).first();
    if (exists) throw new HttpError(409, 'このメールアドレスは登録済みです。ログインしてください');
    const r = await env.DB.prepare(
      `INSERT INTO customers (email, password_hash, name, kana, phone, zip, address) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(email, await hashPassword(b.password), name, str(b.kana, 100), str(b.phone, 30), str(b.zip, 10), str(b.address, 300)).run();
    const id = r.meta.last_row_id;
    // メール確認（＋電話番号認証）が済んだら登録ボーナスを付与（ボーナス目当ての複数登録を防ぐ）
    if (c.mailEnabled) await sendVerifyMail(env, id, email, name);
    await grantSignupBonus(env, id);
    const token = await createSession(env, id);
    const cust = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
    return json({ token, customer: profile(cust), verify_sent: c.mailEnabled, phone_required: c.phoneEnabled }, 201);
  }

  if (path === '/api/auth/login' && m === 'POST') {
    requireMembers(env);
    const ip = clientIp(req);
    if (await overLimit(env, `loginfail:${ip}`, 20)) throw new HttpError(429, 'ログインの失敗が続いたため、しばらくしてからお試しください');
    const b = await readJson(req);
    const email = str(b.email, 200).toLowerCase();
    const cust = await env.DB.prepare('SELECT * FROM customers WHERE email = ? AND deleted = 0').bind(email).first();
    if (cust && cust.locked_until && cust.locked_until > nowIso()) throw new HttpError(429, 'ログインの失敗が続いたため、しばらくしてからお試しください');
    if (!cust || !(await verifyPassword(String(b.password || ''), cust.password_hash))) {
      if (cust) {
        const fails = cust.failed_logins + 1;
        await env.DB.prepare('UPDATE customers SET failed_logins = ?, locked_until = ? WHERE id = ?')
          .bind(fails >= 10 ? 0 : fails, fails >= 10 ? toSql(new Date(Date.now() + 15 * 60000)) : null, cust.id).run();
      }
      await rateLimit(env, `loginfail:${ip}`, 100000, 900);
      throw new HttpError(401, 'メールアドレスかパスワードが違います');
    }
    await env.DB.prepare(`UPDATE customers SET failed_logins = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?`).bind(cust.id).run();
    return json({ token: await createSession(env, cust.id), customer: profile(cust) });
  }

  if (path === '/api/auth/logout' && m === 'POST') {
    const h = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
    if (h) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256hex(h)).run();
    return json({ ok: true });
  }

  if (path === '/api/auth/reset-request' && m === 'POST') {
    requireMembers(env);
    await rateLimit(env, `reset:${clientIp(req)}`, 5, 3600);
    const b = await readJson(req);
    const email = str(b.email, 200).toLowerCase();
    await rateLimit(env, `reset:${email}`, 3, 3600);
    const cust = await env.DB.prepare('SELECT id, name FROM customers WHERE email = ? AND deleted = 0').bind(email).first();
    if (cust && c.mailEnabled) {
      const token = randToken();
      await env.DB.prepare(`INSERT INTO password_resets (token_hash, customer_id, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))`)
        .bind(await sha256hex(token), cust.id).run();
      const site = (env.SITE_URL || '').replace(/\/$/, '');
      await sendMail(env, email, `【${c.shopName}】パスワード再設定`, `${cust.name} 様\n\n以下のリンクから1時間以内にパスワードを再設定してください。\n${site}/#/reset?token=${token}\n\nお心当たりがない場合はこのメールを破棄してください。\n${c.shopName}`);
    }
    return json({ ok: true, mailEnabled: c.mailEnabled }); // 登録の有無は返さない
  }

  if (path === '/api/auth/reset' && m === 'POST') {
    const b = await readJson(req);
    checkPassword(b.password);
    const row = await env.DB.prepare(`SELECT * FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > datetime('now')`)
      .bind(await sha256hex(str(b.token, 100))).first();
    if (!row) throw new HttpError(400, 'リンクの有効期限が切れています。もう一度お試しください');
    await env.DB.batch([
      env.DB.prepare('UPDATE password_resets SET used = 1 WHERE token_hash = ?').bind(row.token_hash),
      env.DB.prepare('UPDATE customers SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').bind(await hashPassword(b.password), row.customer_id),
      env.DB.prepare('DELETE FROM sessions WHERE customer_id = ?').bind(row.customer_id),
    ]);
    return json({ token: await createSession(env, row.customer_id) });
  }

  if (path === '/api/auth/verify' && m === 'POST') {
    const b = await readJson(req);
    const row = await env.DB.prepare(`SELECT * FROM email_verifications WHERE token_hash = ? AND expires_at > datetime('now')`).bind(await sha256hex(str(b.token, 100))).first();
    if (!row) throw new HttpError(400, 'リンクの有効期限が切れています。マイページから確認メールを再送してください');
    await env.DB.batch([
      env.DB.prepare('UPDATE customers SET email_verified = 1 WHERE id = ?').bind(row.customer_id),
      env.DB.prepare('DELETE FROM email_verifications WHERE customer_id = ?').bind(row.customer_id),
    ]);
    const bonus = await grantSignupBonus(env, row.customer_id);
    return json({ ok: true, bonus });
  }

  if (path === '/api/auth/verify-resend' && m === 'POST') {
    const cust = await requireCustomer(req, env);
    if (cust.email_verified) return json({ ok: true });
    if (!c.mailEnabled) throw new HttpError(400, 'メール送信が設定されていません');
    await rateLimit(env, `verify:${cust.id}`, 3, 3600);
    await sendVerifyMail(env, cust.id, cust.email, cust.name);
    return json({ ok: true });
  }

  if (path === '/api/me/phone/send' && m === 'POST') {
    const cust = await requireCustomer(req, env);
    if (!c.phoneEnabled) throw new HttpError(400, '電話番号認証は現在ご利用いただけません');
    const e164 = normalizePhone((await readJson(req)).phone);
    if (!e164) throw new HttpError(400, '携帯電話番号（070・080・090）を入力してください');
    if (cust.phone_e164 === e164) return json({ ok: true, already: true });
    const used = await env.DB.prepare('SELECT 1 FROM customers WHERE phone_e164 = ? AND id != ?').bind(e164, cust.id).first();
    if (used) throw new HttpError(409, 'この電話番号は別のアカウントで認証済みです');
    // SMS の不正大量送信（料金の水増し）対策
    await rateLimit(env, `sms:c:${cust.id}`, 5, 3600, 'SMSの送信回数が上限に達しました。1時間ほどおいてお試しください');
    await rateLimit(env, `sms:ip:${clientIp(req)}`, 10, 3600, 'SMSの送信回数が上限に達しました。1時間ほどおいてお試しください');
    await rateLimit(env, `sms:p:${e164}`, 3, 3600, 'この番号へのSMS送信が続いています。1時間ほどおいてお試しください');
    await rateLimit(env, 'sms:all', 300, 3600, 'ただいまSMSを送信できません。しばらくしてからお試しください');
    await twilio(env, 'Verifications', { To: e164, Channel: 'sms', Locale: 'ja' });
    return json({ ok: true });
  }

  if (path === '/api/me/phone/verify' && m === 'POST') {
    const cust = await requireCustomer(req, env);
    if (!c.phoneEnabled) throw new HttpError(400, '電話番号認証は現在ご利用いただけません');
    const b = await readJson(req);
    const e164 = normalizePhone(b.phone);
    const code = String(b.code || '').replace(/\D/g, '');
    if (!e164 || !/^\d{4,10}$/.test(code)) throw new HttpError(400, '電話番号と認証コードを入力してください');
    await rateLimit(env, `smscheck:${cust.id}`, 10, 3600, '入力の失敗が続いています。しばらくしてからお試しください');
    const r = await twilio(env, 'VerificationCheck', { To: e164, Code: code });
    if (r.status !== 'approved') throw new HttpError(400, '認証コードが違うか、有効期限（10分）が切れています');
    try {
      await env.DB.prepare('UPDATE customers SET phone_e164 = ?, phone = ? WHERE id = ?').bind(e164, '0' + e164.slice(3), cust.id).run();
    } catch { throw new HttpError(409, 'この電話番号は別のアカウントで認証済みです'); }
    const bonus = await grantSignupBonus(env, cust.id);
    return json({ ok: true, bonus });
  }

  if (path === '/api/me' && m === 'GET') {
    const cust = await requireCustomer(req, env);
    const [{ results: ledger }, { results: orders }] = await Promise.all([
      env.DB.prepare('SELECT delta, reason, created_at FROM point_ledger WHERE customer_id = ? ORDER BY id DESC LIMIT 50').bind(cust.id).all(),
      env.DB.prepare('SELECT order_no, token, status, total, points_used, points_earn, points_granted, created_at FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 50').bind(cust.id).all(),
    ]);
    const expiresAt = c.points.expireDays && cust.points > 0 && cust.points_updated_at
      ? toSql(new Date(new Date(cust.points_updated_at.replace(' ', 'T') + 'Z').getTime() + c.points.expireDays * 864e5)) : null;
    return json({ customer: profile(cust), ledger, orders, points_expires_at: expiresAt });
  }

  if (path === '/api/me' && m === 'PUT') {
    const cust = await requireCustomer(req, env);
    const b = await readJson(req);
    if (b.new_password) {
      checkPassword(b.new_password);
      if (!(await verifyPassword(String(b.current_password || ''), cust.password_hash))) throw new HttpError(400, '現在のパスワードが違います');
      // パスワードを変えたら、この端末以外のログインを解除
      const cur = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
      await env.DB.batch([
        env.DB.prepare('UPDATE customers SET password_hash = ? WHERE id = ?').bind(await hashPassword(b.new_password), cust.id),
        env.DB.prepare('DELETE FROM sessions WHERE customer_id = ? AND token_hash != ?').bind(cust.id, await sha256hex(cur)),
      ]);
    }
    const name = str(b.name ?? cust.name, 100);
    if (!name) throw new HttpError(400, 'お名前を入力してください');
    await env.DB.prepare('UPDATE customers SET name = ?, kana = ?, phone = ?, zip = ?, address = ? WHERE id = ?')
      .bind(name, str(b.kana ?? cust.kana, 100), str(b.phone ?? cust.phone, 30), str(b.zip ?? cust.zip, 10), str(b.address ?? cust.address, 300), cust.id).run();
    const fresh = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(cust.id).first();
    return json({ customer: profile(fresh) });
  }

  if (path === '/api/me' && m === 'DELETE') {
    const cust = await requireCustomer(req, env);
    await env.DB.batch([
      env.DB.prepare(`UPDATE customers SET deleted = 1, email = ?, password_hash = '', name = '退会済み', kana = '', phone = '', zip = '', address = '', points = 0 WHERE id = ?`)
        .bind(`deleted-${cust.id}-${Date.now()}`, cust.id),
      env.DB.prepare('DELETE FROM sessions WHERE customer_id = ?').bind(cust.id),
    ]);
    return json({ ok: true });
  }

  return null;
}

// ── 管理API ──

export async function adminMemberRoutes(req, env, path, url) {
  const m = req.method;
  if (path === '/api/admin/members' && m === 'GET') {
    const q = str(url.searchParams.get('q'), 100);
    const like = `%${q}%`;
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.email, c.name, c.kana, c.phone, c.points, c.created_at, c.last_login_at, c.email_verified, c.phone_e164 IS NOT NULL AS phone_verified,
              COUNT(o.id) AS orders, COALESCE(SUM(CASE WHEN o.status IN ('paid','shipped') THEN o.total END), 0) AS spent
         FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
        WHERE c.deleted = 0 AND (? = '' OR c.email LIKE ? OR c.name LIKE ? OR c.kana LIKE ? OR c.phone LIKE ?)
        GROUP BY c.id ORDER BY c.id DESC LIMIT 300`
    ).bind(q, like, like, like, like).all();
    const tot = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(points),0) AS points FROM customers WHERE deleted = 0').first();
    return json({ members: results, total: tot });
  }
  let mm = path.match(/^\/api\/admin\/members\/(\d+)$/);
  if (mm && m === 'GET') {
    const id = int(mm[1]);
    const c = await env.DB.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
    if (!c) throw new HttpError(404, '会員が見つかりません');
    const { results: ledger } = await env.DB.prepare('SELECT * FROM point_ledger WHERE customer_id = ? ORDER BY id DESC LIMIT 200').bind(id).all();
    const { results: orders } = await env.DB.prepare('SELECT id, order_no, status, total, created_at FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 200').bind(id).all();
    return json({ customer: profile(c), ledger, orders });
  }
  mm = path.match(/^\/api\/admin\/members\/(\d+)\/points$/);
  if (mm && m === 'POST') {
    const b = await readJson(req);
    const delta = int(b.delta);
    if (!delta) throw new HttpError(400, 'ポイント数を入力してください');
    const ok = await addPoints(env, int(mm[1]), delta, str(b.reason, 100) || '管理者による調整');
    if (!ok) throw new HttpError(400, 'ポイントがマイナスになるため調整できません');
    return json({ ok: true });
  }
  return null;
}
