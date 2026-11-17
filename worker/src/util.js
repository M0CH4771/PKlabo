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

export function requireAdmin(req, env) {
  const key = req.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_KEY || !timingSafeEqual(key, env.ADMIN_KEY)) throw new HttpError(401, '管理キーが違います');
}

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
