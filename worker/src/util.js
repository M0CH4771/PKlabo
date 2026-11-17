// 共通ユーティリティ

export const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });
}

export const int = (v, d = 0) => {
  const n = parseInt(String(v ?? '').replace(/[,，¥円\s]/g, ''), 10);
  return Number.isFinite(n) ? n : d;
};
export const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
export const toSql = d => d.toISOString().replace('T', ' ').slice(0, 19); // D1 の datetime('now') と同じ形式(UTC)
export const nowIso = () => toSql(new Date());
export const addMinutesIso = min => toSql(new Date(Date.now() + min * 60000));
export const yen = n => '¥' + Number(n).toLocaleString('ja-JP');
export const parseImages = s => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; } catch { return []; } };
export const truthy = v => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on') ? 1 : 0;
export const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function readJson(req) {
  try { return await req.json(); } catch { throw new HttpError(400, 'JSONが不正です'); }
}

export const clientIp = req => req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For')?.split(',')[0].trim() || 'unknown';

// 回数制限：windowSec 秒の間に limit 回を超えたら 429。1回の問い合わせで数える
export async function rateLimit(env, key, limit, windowSec, message) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET count = CASE WHEN reset_at <= ?3 THEN 1 ELSE count + 1 END,
                                    reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END
     RETURNING count`
  ).bind(key, now + windowSec, now).first();
  if (row && row.count > limit) throw new HttpError(429, message || 'しばらく時間をおいてからお試しください');
  return row ? row.count : 1;
}
// 数えずに、上限を超えているかだけ見る（失敗回数のチェック用）
export async function overLimit(env, key, limit) {
  const row = await env.DB.prepare('SELECT count, reset_at FROM rate_limits WHERE key = ?').bind(key).first();
  return Boolean(row && row.reset_at > Math.floor(Date.now() / 1000) && row.count >= limit);
}

// 2段階認証（TOTP / RFC 6238）
function base32Decode(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const ch of clean) { val = (val << 5) | alpha.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}
export async function totpCode(secret, step) {
  const key = await crypto.subtle.importKey('raw', base32Decode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, step);
  new DataView(msg.buffer).setUint32(0, Math.floor(step / 0x100000000));
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
// 前後30秒のずれまで許容。使った時刻ステップを返す（再利用防止用）
export async function verifyTotp(secret, code) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) if (timingSafeEqual(await totpCode(secret, step + d), code)) return step + d;
  return null;
}

// CSV の数式インジェクション対策（Excel で開いたときに =… が実行されないように）
export const csvSafe = v => /^[=+\-@\t\r]/.test(String(v ?? '')) && !/^-?\d+(\.\d+)?$/.test(String(v)) ? "'" + v : v;

export function randomInt(n) {
  // 0..n-1 の偏りのない乱数
  if (n <= 1) return 0;
  const max = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= max);
  return buf[0] % n;
}

export async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── メール（任意: Resend） ──
export async function sendMail(env, to, subject, text) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM || !to) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, reply_to: env.ADMIN_EMAIL || undefined }),
    });
  } catch (e) { console.error('mail failed', e); }
}

export async function notifyAdmin(env, subject, text) {
  if (env.ADMIN_EMAIL) await sendMail(env, env.ADMIN_EMAIL, subject, text || subject);
  if (env.DISCORD_WEBHOOK_URL) {
    try {
      await fetch(env.DISCORD_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: subject }) });
    } catch (e) { console.error('discord failed', e); }
  }
}
