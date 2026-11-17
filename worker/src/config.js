// 管理画面から変更できるショップ設定
// 優先順位: DEFAULTS < wrangler.toml の vars < 管理画面で保存した設定(D1 settings テーブル)

import { int, str, HttpError } from './util.js';

export const DEFAULTS = {
  shopName: 'ポケカ買取ラボ',
  tagline: 'ポケモンカード シングル・PSA鑑定品・オリパ通販',
  logoText: 'PK',
  accentColor: '#e3262f',
  notice: '',              // サイト上部のお知らせ（空なら非表示）
  noticeLink: '',
  kobutsu: '東京都公安委員会 第304362220808号',

  shippingFee: 230,
  freeShippingOver: 10000,
  shipCutoffHour: 13,
  shipDays: [1, 2, 3, 4, 5, 6],
  pickupEnabled: false,
  pickupInfo: '',
  bankInfo: '',
  paymentDays: 3,
  maxQtyPerItem: 10,
  buybackUrl: '',

  features: {
    deck: true,           // デッキリスト一括購入
    favorites: true,      // お気に入り
    ranking: true,        // 売れ筋ランキング
    recent: true,         // 最近チェックした商品
    saleStrip: true,      // 値下げ・セール欄
    priceHistory: true,   // 価格推移グラフ
    siblings: true,       // 状態違いの切り替え表示
    groupVariants: true,  // 一覧で状態違いを1件にまとめる
    buyback: true,        // 買取価格の表示
    restock: true,        // 入荷通知
    phoneVerify: false,   // 電話番号（SMS）認証。TWILIO_* の設定が必要
    coins: true,          // オリパをコインで引く（コインを購入 → 即抽選 → 当選品は発送依頼）。OFFなら注文ごとの購入
    coupons: true,        // クーポン
    members: true,        // 会員登録・ログイン
    points: true,         // ポイント制度（会員登録が必要）
    oripa: true,          // オリパ
    shipbar: true,        // 即日発送カウントダウン
    guestCheckout: true,  // 会員登録なしでの購入
    bankPayment: true,    // 銀行振込
    cardPayment: true,    // カード決済（STRIPE_SECRET_KEY が必要）
  },

  points: {
    rate: 1,              // 購入金額に対する付与率(%)
    signupBonus: 300,     // 新規登録ボーナス
    expireDays: 365,      // 最後にポイントが動いてから失効までの日数（0=失効なし）
    minUse: 1,            // 1回に使える最小ポイント
    grantOn: 'shipped',   // 付与タイミング shipped=発送時 / paid=入金時
    oripaEarn: false,     // オリパ購入分にもポイントを付与する
    oripaUse: false,      // オリパにポイントを使える
  },

  coin: {
    name: 'コイン',
    expireMonths: 6,      // 購入から失効までの月数（6以内なら資金決済法の前払式支払手段の対象外。0=期限なし）
    shipFee: 0,           // 当選品の発送依頼1回あたりの送料（コイン）
    packs: [              // 購入パック（価格円 → 付与コイン）
      { price: 1000, coins: 1000 },
      { price: 3000, coins: 3000 },
      { price: 5000, coins: 5000 },
      { price: 10000, coins: 10000 },
      { price: 30000, coins: 30000 },
    ],
  },

  phone: {
    forBonus: true,       // 登録ボーナスを電話番号認証後に付与（SMS認証を有効にした場合）
    forOripa: true,       // オリパ購入に電話番号認証を必須にする（SMS認証を有効にした場合）
  },

  oripa: {
    requireLogin: true,
    showRecent: true,     // 最近の当選を公開する
    showQty: false,       // 賞ごとの封入数・封入率を公開する
    showValue: false,     // 賞ごとの参考価格を公開する
    maxPerOrder: 50,
    ageNotice: '18歳未満の方はご購入いただけません。',
    notice: '当選したカードは実物を発送します。ポイントや現金への交換はできません。封入内容は販売ページで公開しています。',
    // 販売ページの【重要事項】。1行に1項目
    important: `当選したカードは実物をお届けします。コイン・ポイント・現金への交換はできません。
抽選後のキャンセル・返品・交換はお受けできません（配送中の破損や、当店の発送間違いを除きます）。
オリパには、傷や汚れのあるカードが含まれる場合があります。商品画像はイメージで、実際のカードの状態を保証するものではありません。
「SAR 1枚」のように種類を書いていない賞は、届くカードの種類を指定できません。
鑑定済みカード（PSAなど）は鑑定機関のグレードに基づいてお届けします。ケース内部の傷・ほこり・異物を理由とする返品・交換はお受けできません。
未開封品（BOX・パックなど）は、外装の小さな傷や凹み、シュリンクの小さな破れ、シール跡、梱包による外袋の跡がある場合があります。
未開封品は入念に検品していますが、商品が届いてから開封するまでの様子を動画で撮影しておくことをおすすめします。偽造品であることが動画で確認できた場合に限り、返品・交換をお受けします。撮影の際は、届いた梱包物がすべて映るようにしてください。
1st Edition などのエディションは、賞品名に書かれている場合を除き指定できません。画像にエディションの表記が見えていても、賞品名に書かれていない場合は対象外です。
残り口数や封入状況は購入のタイミングによって変わります。表示は購入を保証するものではありません。
開封時の演出はお楽しみのためのものです。演出の途中の色や長さは、最終的な賞を保証するものではありません。
抽選の結果はサーバーで確定します。通信が途切れたり画面を閉じたりしても、結果はマイページの「獲得カード」に保存されます。
当選したカードは、マイページの「獲得カード」から発送を依頼してください。
お一人で複数のアカウントを使ってのご購入はご遠慮ください。`,
  },

  categories: [
    { key: 'single', label: 'シングル' },
    { key: 'psa', label: 'PSA鑑定品' },
    { key: 'box', label: 'BOX・パック' },
    { key: 'supply', label: 'サプライ' },
  ],

  condGuide: [
    ['S', '未使用に近い美品。目立つ傷・白欠けなし'],
    ['A', 'わずかな擦れ程度。プレイ・コレクションどちらにもおすすめ'],
    ['B', '小傷・白欠け・軽い反りあり。プレイ用に最適'],
    ['C', '目立つ傷・折れ・凹みあり。とにかく安く揃えたい方向け'],
    ['PSA10', 'PSA社の鑑定で最高評価 GEM MINT'],
  ],

  legal: {
    seller: '', manager: '', address: '', phone: '', hours: '', email: '',
    delivery: '', returns: '商品の性質上、お客様都合による返品・交換はお受けしておりません。\n商品間違い・破損など当店の不備による場合は、商品到着後7日以内にご連絡ください。送料当店負担にて交換または返金いたします。',
    extra: '',
  },
};

const ENV_MAP = {
  SHOP_NAME: ['shopName', 's'], SHIPPING_FEE: ['shippingFee', 'n'], FREE_SHIPPING_OVER: ['freeShippingOver', 'n'],
  PAYMENT_DAYS: ['paymentDays', 'n'], MAX_QTY_PER_ITEM: ['maxQtyPerItem', 'n'], SHIP_CUTOFF_HOUR: ['shipCutoffHour', 'n'],
  PICKUP_INFO: ['pickupInfo', 's'], BUYBACK_URL: ['buybackUrl', 's'], BANK_INFO: ['bankInfo', 's'], KOBUTSU: ['kobutsu', 's'],
};

const clone = o => JSON.parse(JSON.stringify(o));

// 入力を DEFAULTS と同じ形・型にそろえる（知らないキーは捨てる）
function sanitize(shape, input) {
  if (Array.isArray(shape)) return Array.isArray(input) ? input : shape;
  if (shape && typeof shape === 'object') {
    const out = {};
    for (const k of Object.keys(shape)) out[k] = input && typeof input === 'object' && k in input ? sanitize(shape[k], input[k]) : clone(shape[k]);
    return out;
  }
  if (typeof shape === 'number') return int(input, shape);
  if (typeof shape === 'boolean') return input === true || input === 1 || input === '1' || input === 'true' || input === 'on';
  return str(input, 5000);
}

function finalize(c) {
  c.shipDays = [...new Set((c.shipDays || []).map(n => int(n, -1)).filter(n => n >= 0 && n <= 6))].sort();
  c.shipCutoffHour = Math.min(24, Math.max(0, c.shipCutoffHour));
  c.shippingFee = Math.max(0, c.shippingFee);
  c.freeShippingOver = Math.max(0, c.freeShippingOver);
  c.paymentDays = Math.min(30, Math.max(1, c.paymentDays));
  c.maxQtyPerItem = Math.min(99, Math.max(1, c.maxQtyPerItem));
  c.points.rate = Math.min(100, Math.max(0, c.points.rate));
  c.points.signupBonus = Math.max(0, c.points.signupBonus);
  c.points.expireDays = Math.max(0, c.points.expireDays);
  c.points.minUse = Math.max(1, c.points.minUse);
  if (!['shipped', 'paid'].includes(c.points.grantOn)) c.points.grantOn = 'shipped';
  c.oripa.maxPerOrder = Math.min(500, Math.max(1, c.oripa.maxPerOrder));
  c.coin.expireMonths = Math.min(120, Math.max(0, c.coin.expireMonths));
  c.coin.shipFee = Math.max(0, c.coin.shipFee);
  c.coin.packs = (c.coin.packs || []).map(p => ({ price: int(p?.price), coins: int(p?.coins) }))
    .filter(p => p.price >= 100 && p.coins > 0 && p.coins <= p.price * 2).slice(0, 10);
  if (!c.coin.packs.length) c.coin.packs = clone(DEFAULTS.coin.packs);
  if (!c.features.members || !c.features.oripa) c.features.coins = false;
  if (!/^#[0-9a-fA-F]{6}$/.test(c.accentColor)) c.accentColor = DEFAULTS.accentColor;
  c.categories = (c.categories || []).map(x => ({ key: str(x?.key, 20).toLowerCase(), label: str(x?.label, 30) }))
    .filter(x => /^[a-z0-9_-]{1,20}$/.test(x.key) && x.label).slice(0, 30);
  if (!c.categories.length) c.categories = clone(DEFAULTS.categories);
  c.condGuide = (c.condGuide || []).filter(x => Array.isArray(x)).map(([k, v]) => [str(k, 20), str(v, 200)]).filter(([k]) => k).slice(0, 20);
  if (!c.features.members) c.features.points = false; // ポイントは会員機能が前提
  if (!c.features.bankPayment && !c.features.cardPayment) c.features.bankPayment = true;
  return c;
}

export async function loadConfig(env, force) {
  if (env.__cfg && !force) return env.__cfg;
  let c = clone(DEFAULTS);
  for (const [k, [key, t]] of Object.entries(ENV_MAP)) if (env[k] !== undefined && env[k] !== '') c[key] = t === 'n' ? int(env[k], c[key]) : String(env[k]).trim();
  if (env.SHIP_DAYS) c.shipDays = String(env.SHIP_DAYS).split(',').map(s => int(s, -1));
  if (env.PICKUP_ENABLED !== undefined) c.pickupEnabled = env.PICKUP_ENABLED === '1' || env.PICKUP_ENABLED === 'true';
  try {
    const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = 'site'`).first();
    if (row) c = sanitize(DEFAULTS, { ...c, ...JSON.parse(row.value), features: { ...c.features, ...(JSON.parse(row.value).features || {}) } });
  } catch (e) { /* settings テーブルがまだ無い場合など */ }
  c = finalize(sanitize(DEFAULTS, c));
  c.cardEnabled = c.features.cardPayment && Boolean(env.STRIPE_SECRET_KEY);
  c.bankEnabled = c.features.bankPayment || !c.cardEnabled;
  c.mailEnabled = Boolean(env.RESEND_API_KEY && env.MAIL_FROM);
  c.smsReady = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_VERIFY_SID);
  c.phoneEnabled = c.features.phoneVerify && c.features.members && c.smsReady;
  env.__cfg = c;
  return c;
}

export const cfg = env => {
  if (!env.__cfg) throw new Error('config not loaded');
  return env.__cfg;
};

export function publicConfig(c) {
  const { bankInfo, ...rest } = c;
  return rest;
}

export async function saveSettings(env, input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, '設定が不正です');
  const merged = finalize(sanitize(DEFAULTS, input));
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('site', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(JSON.stringify(merged)).run();
  return loadConfig(env, true);
}
