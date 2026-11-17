// 管理画面の2段階認証用の秘密鍵を作る
// 使い方: node scripts/totp-secret.mjs
// 表示された「秘密鍵」を Google Authenticator などの認証アプリに「セットアップキーを入力」で登録し、
// 同じ値を  npx wrangler secret put ADMIN_TOTP_SECRET  で Worker に登録します。
import { randomBytes } from 'node:crypto';

const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const bytes = randomBytes(20);
let bits = 0, val = 0, out = '';
for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += alpha[(val >>> (bits - 5)) & 31]; bits -= 5; } }
if (bits > 0) out += alpha[(val << (5 - bits)) & 31];

const label = encodeURIComponent('PKlabo 管理画面');
console.log('\n秘密鍵（認証アプリと Worker の両方に登録）:\n');
console.log('  ' + out.match(/.{1,4}/g).join(' '));
console.log('\n認証アプリ用URI（QRコードにしたい場合）:\n');
console.log(`  otpauth://totp/${label}?secret=${out}&issuer=PKlabo&digits=6&period=30\n`);
console.log('この値は他人に見せず、GitHub にも保存しないでください。\n');
