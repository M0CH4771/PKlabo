// PKlabo ショップ画面
(() => {
  const CFG = window.PKLABO;
  const API = CFG.API_BASE.replace(/\/$/, '');
  const app = document.getElementById('app');
  const PAGE = 48;
  const COND_ORDER = ['PSA10', 'PSA9', 'PSA8', '未開封', '新品', 'S', 'A', 'A-', 'B', 'C'];

  // ─── ユーティリティ ───
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = n => '¥' + Number(n).toLocaleString('ja-JP');
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const norm = s => String(s ?? '').normalize('NFKC').toLowerCase()
    .replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/[\s・　]/g, '');
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
    set(k, v) { try { if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2400);
  }
  let token = store.get('pk_token', null);
  async function api(path, opts = {}) {
    const res = await fetch(API + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token && path.startsWith('/api/me')) { setToken(null); }
    if (!res.ok) { const e = new Error(data.error || '通信エラーが発生しました'); e.data = data; e.status = res.status; throw e; }
    return data;
  }
  const utcToDate = s => new Date(String(s).replace(' ', 'T') + 'Z');
  const jst = (utc, opt = { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) => utc ? utcToDate(utc).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', ...opt }) : '';
  const condRank = c => { const i = COND_ORDER.findIndex(x => norm(x) === norm(c)); return i < 0 ? 50 : i; };
  const offPct = p => p.compare_price > p.price ? Math.round((1 - p.price / p.compare_price) * 100) : 0;
  const imagesOf = p => [p.image_url, ...(p.images || [])].filter(Boolean);
  const isNew = p => p.created_at && Date.now() - utcToDate(p.created_at).getTime() < 7 * 864e5;
  const gkey = p => p.group_key || `${norm(p.name)}|${norm(p.card_no)}`;
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ─── 状態 ───
  let config = null;
  let F_ON = {};             // 機能ON/OFF
  let products = null;
  let byId = new Map();
  let oripas = null;
  let me = null;             // { customer, ledger, orders, points_expires_at }
  const defaultFilter = () => ({ q: '', cat: 'all', sort: 'new', inStock: true, sale: false, photo: false, sets: [], rarities: [], conds: [], min: '', max: '' });
  let F = { ...defaultFilter(), ...store.get('pk_filter', {}) };
  let shown = PAGE;

  function setToken(t) { token = t; store.set('pk_token', t); if (!t) me = null; updateBadges(); }

  const cart = {
    items: store.get('pk_cart', {}),           // { productId: qty }
    oripa: store.get('pk_cart_oripa', {}),     // { oripaId: qty }
    save() { store.set('pk_cart', this.items); store.set('pk_cart_oripa', this.oripa); updateBadges(); },
    add(id, qty = 1, silent) {
      const p = byId.get(id);
      const cur = this.items[id] || 0;
      const max = Math.min(p ? p.stock : 0, config?.maxQtyPerItem ?? 10);
      if (cur + qty > max) { if (!silent) toast(max ? `在庫は${max}点までです` : '在庫切れです'); return false; }
      this.items[id] = cur + qty; this.save(); return true;
    },
    set(id, qty) { if (qty <= 0) delete this.items[id]; else this.items[id] = qty; this.save(); },
    setOripa(id, qty) { if (qty <= 0) delete this.oripa[id]; else this.oripa[id] = qty; this.save(); },
    clear() { this.items = {}; this.oripa = {}; this.save(); },
    count() { return Object.values(this.items).reduce((a, b) => a + b, 0) + Object.values(this.oripa).reduce((a, b) => a + b, 0); },
    payload() { return [...Object.entries(this.items).map(([id, qty]) => ({ product_id: +id, qty })), ...Object.entries(this.oripa).map(([id, qty]) => ({ oripa_id: +id, qty }))]; },
  };
  const fav = {
    items: store.get('pk_fav', {}),
    has(id) { return id in this.items; },
    toggle(id) { const p = byId.get(id); if (this.has(id)) delete this.items[id]; else this.items[id] = p ? p.price : 0; store.set('pk_fav', this.items); updateBadges(); return this.has(id); },
    dropped() { return Object.entries(this.items).filter(([id, was]) => { const p = byId.get(+id); return p && p.price < was; }).length; },
  };
  function pushRecent(id) { const r = store.get('pk_recent', []).filter(x => x !== id); r.unshift(id); store.set('pk_recent', r.slice(0, 16)); }

  function updateBadges() {
    const b = $('#cart-count'); const n = cart.count();
    b.textContent = n; b.hidden = n === 0;
    $('#fav-dot').hidden = !(products && F_ON.favorites && fav.dropped() > 0);
    $('#nav-account-label').textContent = me ? (F_ON.points ? `${me.customer.points.toLocaleString()}pt` : 'マイページ') : 'ログイン';
  }

  function applyConfig() {
    F_ON = config.features;
    document.documentElement.style.setProperty('--accent', config.accentColor);
    document.title = `${config.shopName} オンラインショップ${config.tagline ? '｜' + config.tagline : ''}`;
    $('#shop-name').textContent = config.shopName;
    $('#logo-mark').textContent = config.logoText || 'PK';
    $('#kobutsu').textContent = config.kobutsu ? '古物商許可：' + config.kobutsu : '';
    $('#copy').textContent = '© ' + config.shopName;
    $('#nav-oripa').hidden = !F_ON.oripa;
    $('#nav-fav').hidden = !F_ON.favorites;
    $('#nav-account').hidden = !F_ON.members;
    $('#foot-deck').hidden = !F_ON.deck;
    const n = $('#notice');
    if (config.notice) { n.hidden = false; n.innerHTML = config.noticeLink ? `<a href="${esc(config.noticeLink)}">${esc(config.notice)}</a>` : esc(config.notice); } else n.hidden = true;
  }

  async function loadBase(force) {
    if (!config) { config = await api('/api/config'); applyConfig(); }
    if (token && !me && F_ON.members) { try { me = await api('/api/me'); } catch { setToken(null); } }
    if (!products || force) {
      products = await api('/api/products' + (force ? '?_=' + Date.now() : ''));
      byId = new Map(products.map(p => [p.id, p]));
      for (const id of Object.keys(cart.items)) if (!byId.has(+id)) delete cart.items[id];
      cart.save();
    }
    updateBadges();
  }
  async function loadOripas(force) {
    if (!F_ON.oripa) { oripas = []; return; }
    if (F_ON.coins && Object.keys(cart.oripa).length) { cart.oripa = {}; cart.save(); }
    if (!oripas || force) oripas = await api('/api/oripas' + (force ? '?_=' + Date.now() : '')).catch(() => []);
    for (const id of Object.keys(cart.oripa)) { const o = oripas.find(x => x.id === +id); if (!o || !o.open) delete cart.oripa[id]; }
    cart.save();
  }
  async function refreshMe() { if (token) { try { me = await api('/api/me'); } catch { setToken(null); } updateBadges(); } }

  // ─── 即日発送 ───
  function shipInfo() {
    if (!config || !F_ON.shipbar || !config.shipDays.length) return null;
    const now = new Date(Date.now() + 9 * 3600e3);
    const day = now.getUTCDay();
    const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
    const cutoff = config.shipCutoffHour * 60;
    if (config.shipDays.includes(day) && mins < cutoff) {
      const left = cutoff - mins;
      return { today: true, text: `あと<b>${Math.floor(left / 60)}時間${left % 60}分</b>以内のカード決済・ご入金確認で<b>本日発送</b>` };
    }
    for (let i = 1; i <= 7; i++) {
      const d = new Date(now.getTime() + i * 864e5);
      if (config.shipDays.includes(d.getUTCDay())) {
        const label = i === 1 ? '明日' : `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${'日月火水木金土'[d.getUTCDay()]})`;
        return { today: false, text: `今ご注文で<b>${label}発送</b>（${config.shipCutoffHour}時までの決済・入金確認分）` };
      }
    }
    return null;
  }
  function renderShipbar() {
    const s = shipInfo(); const bar = $('#shipbar');
    if (!s) { bar.hidden = true; return; }
    bar.hidden = false;
    bar.innerHTML = `<span>${s.text}</span><span class="ship-free">${yen(config.freeShippingOver)}以上 送料無料${config.pickupEnabled ? '・店頭受取OK' : ''}${F_ON.points ? `・${config.points.rate}%ポイント還元` : ''}</span>`;
  }
  setInterval(() => config && renderShipbar(), 30000);

  // ─── 共通パーツ ───
  const catLabel = k => (config.categories.find(c => c.key === k) || {}).label || '';
  function cardImage(p, cls = '') {
    const src = imagesOf(p)[0];
    return src ? `<img class="${cls}" src="${esc(src)}" alt="${esc(p.name)}" loading="lazy">` : `<div class="${cls} noimg"><span>NO IMAGE</span></div>`;
  }
  function condBadge(c) {
    if (!c) return '';
    const cls = /^PSA\s*10/i.test(c) ? 'psa10' : /^PSA/i.test(c) ? 'psa' : /^[SＳ]$/.test(c) ? 'cs' : /^B/.test(c) ? 'cb' : /^C/.test(c) ? 'cc' : '';
    return `<span class="tag cond ${cls}">${esc(c)}</span>`;
  }
  function priceHtml(p, big) {
    const off = offPct(p);
    return `<span class="pp"><span class="price ${big ? 'big' : ''}">${yen(p.price)}</span>${off ? ` <s class="was">${yen(p.compare_price)}</s> <span class="off">${off}%OFF</span>` : ''}</span>`;
  }
  function pcard(p, rank, vars) {
    const multi = vars && vars.length > 1;
    const minPrice = multi ? Math.min(...vars.filter(v => v.stock > 0).map(v => v.price).concat(vars.every(v => v.stock <= 0) ? vars.map(v => v.price) : [])) : 0;
    const stockSum = multi ? vars.reduce((s, v) => s + Math.max(0, v.stock), 0) : p.stock;
    const dropped = F_ON.favorites && fav.has(p.id) && p.price < fav.items[p.id];
    return `
      <article class="pcard ${p.stock <= 0 ? 'soldout' : ''}">
        <a href="#/p/${p.id}" class="pimg">${cardImage(p)}
          <span class="ribbons">${rank ? `<span class="rk rk${rank}">${rank}</span>` : ''}${offPct(p) ? '<span class="rb sale">値下げ</span>' : ''}${isNew(p) ? '<span class="rb new">新入荷</span>' : ''}${p.real_photo ? '<span class="rb photo">実物写真</span>' : ''}</span>
          ${p.stock <= 0 ? '<span class="sold">売り切れ</span>' : ''}</a>
        ${F_ON.favorites ? `<button class="favbtn ${fav.has(p.id) ? 'on' : ''}" data-fav="${p.id}" aria-label="お気に入り">♥</button>` : ''}
        <div class="pbody">
          <a href="#/p/${p.id}" class="pname">${esc(p.name)}</a>
          <div class="pmeta">${p.card_no ? `<span>${esc(p.card_no)}</span>` : ''}${p.rarity ? `<span class="tag">${esc(p.rarity)}</span>` : ''}${multi ? '' : condBadge(p.condition)}</div>
          ${multi ? `<div class="vars">${vars.map(v => `<span class="${v.stock > 0 ? '' : 'out'}">${esc(v.condition)}</span>`).join('')}</div>` : ''}
          ${dropped ? `<div class="drop">登録時から${yen(fav.items[p.id] - p.price)}値下がり</div>` : ''}
          <div class="pfoot">${multi ? `<span class="pp"><span class="price">${yen(minPrice)}</span><span class="muted small">〜</span></span><a class="btn sm add" href="#/p/${p.id}" aria-label="状態を選ぶ">›</a>` : `${priceHtml(p)}${p.stock > 0 ? `<button class="btn sm add" data-add="${p.id}" aria-label="カートに追加">＋</button>` : ''}`}</div>
          <div class="stockline ${stockSum > 0 && stockSum <= 2 ? 'low' : ''}">${stockSum > 0 ? (multi ? `${vars.length}状態・在庫${stockSum}` : stockSum <= 2 ? `残り${stockSum}点` : `在庫${stockSum}`) : '入荷待ち'}</div>
        </div>
      </article>`;
  }
  function bindCards(root = app) {
    $$('[data-add]', root).forEach(b => b.onclick = e => { e.preventDefault(); if (cart.add(+b.dataset.add)) toast('カートに追加しました'); });
    $$('[data-fav]', root).forEach(b => b.onclick = e => { e.preventDefault(); const on = fav.toggle(+b.dataset.fav); b.classList.toggle('on', on); toast(on ? 'お気に入りに追加しました' : 'お気に入りから外しました'); });
  }
  const strip = (title, list, more, ranked) => list.length ? `
    <section class="strip"><div class="strip-h"><h2>${title}</h2>${more ? `<button class="link" data-more="${more}">すべて見る</button>` : ''}</div>
    <div class="strip-row">${list.map((p, i) => pcard(p, ranked ? i + 1 : 0)).join('')}</div></section>` : '';

  // ─── オリパ部品 ───
  // 【重要事項】：管理画面の設定（1行に1項目）＋設定から自動で作る項目（コイン・年齢）
  function importantHtml() {
    const lines = String(config.oripa.important || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (F_ON.coins) lines.push(`${config.coin.name}は当店のオリパ専用です（1${config.coin.name}＝1円相当）。${config.coin.expireMonths ? `有効期限は付与から${config.coin.expireMonths}か月です。` : ''}購入した${config.coin.name}の払い戻しはできません（法令で定める場合を除きます）。`);
    if (config.oripa.ageNotice) lines.push(config.oripa.ageNotice);
    if (!lines.length) return '';
    return `<details class="important" id="important" open>
      <summary><b>【重要事項】</b> ご購入前に必ずご確認ください。</summary>
      <ul>${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      <p class="small muted">ほかに<a href="legal.html#oripa" target="_blank" rel="noopener">特定商取引法に基づく表記（オリパについて）</a>もご確認ください。</p>
    </details>`;
  }
  function oripaCard(o) {
    const pct = o.total ? Math.round(o.remaining / o.total * 100) : 0;
    const top = o.prizes.filter(p => !p.is_last_one)[0];
    return `
      <a class="ocard ${o.open ? '' : 'closed'}" href="#/oripa/${o.id}">
        <div class="oimg">${o.image_url ? `<img src="${esc(o.image_url)}" alt="" loading="lazy">` : `<div class="oph">${esc(o.title)}</div>`}${o.open ? '' : '<span class="sold">完売・終了</span>'}</div>
        <div class="obody">
          <b class="oname">${esc(o.title)}</b>
          ${top ? `<span class="muted small">最高賞：${esc(top.rank)} ${esc(top.name)}</span>` : ''}
          <div class="obar"><i style="width:${pct}%"></i></div>
          <div class="row-between small"><span>残り <b>${o.remaining}</b> / ${o.total}口</span><span class="price">${F_ON.coins ? `${o.price.toLocaleString()}<small>${esc(config.coin.name)}/口</small>` : `${yen(o.price)}<small>/口</small>`}</span></div>
        </div>
      </a>`;
  }

  // ─── 一覧 ───
  function applyFilter() {
    const terms = String(F.q).trim().split(/[\s　]+/).map(norm).filter(Boolean);
    const min = F.min === '' ? 0 : +F.min, max = F.max === '' ? Infinity : +F.max;
    let list = products.filter(p => {
      if (F.cat !== 'all' && p.category !== F.cat) return false;
      if (F.inStock && p.stock <= 0) return false;
      if (F.sale && !offPct(p)) return false;
      if (F.photo && !p.real_photo) return false;
      if (F.sets.length && !F.sets.includes(p.set_name)) return false;
      if (F.rarities.length && !F.rarities.includes(p.rarity)) return false;
      if (F.conds.length && !F.conds.includes(p.condition)) return false;
      if (p.price < min || p.price > max) return false;
      if (terms.length) { const hay = norm([p.name, p.set_name, p.card_no, p.rarity, p.condition].join(' ')); if (!terms.every(t => hay.includes(t))) return false; }
      return true;
    });
    const by = {
      new: (a, b) => (b.stock > 0) - (a.stock > 0) || b.id - a.id,
      cheap: (a, b) => a.price - b.price, high: (a, b) => b.price - a.price,
      popular: (a, b) => b.sold - a.sold || b.id - a.id, off: (a, b) => offPct(b) - offPct(a) || b.id - a.id,
      cond: (a, b) => condRank(a.condition) - condRank(b.condition) || a.price - b.price,
    }[F.sort];
    return by ? [...list].sort(by) : list;
  }
  const filterCount = () => F.sets.length + F.rarities.length + F.conds.length + (F.min !== '' ? 1 : 0) + (F.max !== '' ? 1 : 0) + (F.sale ? 1 : 0) + (F.photo ? 1 : 0);
  const isDefaultView = () => !F.q && F.cat === 'all' && !filterCount();
  const uniq = (key, list) => [...new Set(list.map(p => p[key]).filter(Boolean))];

  async function viewList() {
    store.set('pk_filter', F);
    if (F.cat !== 'all' && !config.categories.some(c => c.key === F.cat)) F.cat = 'all';
    const flat = applyFilter();
    // 状態違いを1件にまとめる（代表は在庫ありで一番安いもの）
    let list = flat.map(p => ({ p, vars: null }));
    if (F_ON.groupVariants) {
      const groups = new Map();
      for (const p of flat) { const k = gkey(p); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
      list = [...groups.values()].map(vs => {
        const rep = [...vs].sort((a, b) => (b.stock > 0) - (a.stock > 0) || a.price - b.price)[0];
        return { p: F.sort === 'new' || F.sort === 'popular' || F.sort === 'high' || F.sort === 'cond' ? vs[0] : rep, vars: vs.length > 1 ? [...vs].sort((a, b) => condRank(a.condition) - condRank(b.condition)) : null };
      });
    }
    const home = isDefaultView();
    if (home && F_ON.oripa && !oripas) await loadOripas();
    const liveOripas = home && F_ON.oripa ? (oripas || []).filter(o => o.open).slice(0, 8) : [];
    const ranking = home && F_ON.ranking ? products.filter(p => p.sold > 0 && p.stock > 0).sort((a, b) => b.sold - a.sold).slice(0, 10) : [];
    const sale = home && F_ON.saleStrip ? products.filter(p => offPct(p) && p.stock > 0).sort((a, b) => offPct(b) - offPct(a)).slice(0, 12) : [];
    const recent = home && F_ON.recent ? store.get('pk_recent', []).map(id => byId.get(id)).filter(Boolean).slice(0, 12) : [];
    const fc = filterCount();
    const scoped = products.filter(p => F.cat === 'all' || p.category === F.cat);
    const cats = [{ key: 'all', label: 'すべて' }, ...config.categories.filter(c => products.some(p => p.category === c.key))];

    app.innerHTML = `
      <div class="searchbar"><input id="q" type="search" placeholder="カード名・型番・弾で検索（ひらがなOK）" value="${esc(F.q)}" autocomplete="off" enterkeyhint="search"></div>
      <div class="chips">${cats.map(c => `<button class="chip ${F.cat === c.key ? 'on' : ''}" data-cat="${esc(c.key)}">${esc(c.label)}</button>`).join('')}${F_ON.oripa ? '<a class="chip oripa-chip" href="#/oripa">オリパ</a>' : ''}</div>
      ${home && F_ON.members && !me && F_ON.points && config.points.signupBonus ? `<a href="#/account" class="promo red"><b>会員登録で${config.points.signupBonus}ポイントプレゼント</b><span>お買い物で${config.points.rate}%ポイント還元・1pt＝1円で使えます</span></a>` : ''}
      ${home && F_ON.deck ? `<a href="#/deck" class="promo"><b>デッキリストを貼るだけで一括購入</b><span>在庫から一番安い組み合わせを自動でカートへ</span></a>` : ''}
      ${liveOripas.length ? `<section class="strip"><div class="strip-h"><h2>販売中のオリパ</h2><a class="link" href="#/oripa">すべて見る</a></div><div class="strip-row wide">${liveOripas.map(oripaCard).join('')}</div></section>` : ''}
      ${strip('売れ筋ランキング', ranking, 'popular', true)}
      ${strip('値下げ・セール', sale, 'off')}
      ${strip('最近チェックした商品', recent)}
      <div class="listhead">
        <h2>${home ? 'すべての商品' : '検索結果'} <span class="muted small">${list.length}件</span></h2>
        <div class="tools">
          <button class="btn sm ${fc ? 'primary' : ''}" id="openf">絞り込み${fc ? `（${fc}）` : ''}</button>
          <select id="sort">${[['new', '新着順'], ['popular', '人気順'], ['cheap', '安い順'], ['high', '高い順'], ['off', '割引率順'], ['cond', '状態の良い順']].map(([k, l]) => `<option value="${k}" ${F.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </div>
      </div>
      <div class="quick">
        <label class="check"><input type="checkbox" id="instock" ${F.inStock ? 'checked' : ''}> 在庫ありのみ</label>
        ${fc || F.q ? '<button class="link" id="clearf">条件をクリア</button>' : ''}
      </div>
      <div class="grid">${list.slice(0, shown).map(x => pcard(x.p, 0, x.vars)).join('') || '<p class="muted pad">該当する商品がありません。<br>「在庫ありのみ」を外すと売り切れ商品も表示されます。</p>'}</div>
      ${list.length > shown ? `<button class="btn block" id="more">もっと見る（残り${list.length - shown}件）</button>` : ''}
      <dialog id="fdlg" class="sheet">
        <form method="dialog" id="ff">
          <div class="sheet-h"><b>絞り込み</b><button value="close" class="link">閉じる</button></div>
          <div class="sheet-b">
            <h3>価格</h3>
            <div class="range"><input name="min" type="number" inputmode="numeric" placeholder="下限" value="${esc(F.min)}"> 〜 <input name="max" type="number" inputmode="numeric" placeholder="上限" value="${esc(F.max)}"> 円</div>
            <div class="chips wrap">${[[0, 500], [500, 3000], [3000, 10000], [10000, 50000], [50000, '']].map(([a, b]) => `<button type="button" class="chip" data-range="${a},${b}">${b === '' ? yen(a) + '〜' : yen(a) + '〜' + yen(b)}</button>`).join('')}</div>
            <h3>こだわり</h3>
            <label class="check"><input type="checkbox" name="sale" ${F.sale ? 'checked' : ''}> セール中のみ</label>
            <label class="check"><input type="checkbox" name="photo" ${F.photo ? 'checked' : ''}> 実物写真ありのみ</label>
            ${uniq('condition', scoped).length ? `<h3>状態</h3><div class="chips wrap">${uniq('condition', scoped).sort((a, b) => condRank(a) - condRank(b)).map(c => `<label class="chip ck"><input type="checkbox" name="conds" value="${esc(c)}" ${F.conds.includes(c) ? 'checked' : ''}>${esc(c)}</label>`).join('')}</div>` : ''}
            ${uniq('rarity', scoped).length ? `<h3>レアリティ</h3><div class="chips wrap">${uniq('rarity', scoped).sort().map(c => `<label class="chip ck"><input type="checkbox" name="rarities" value="${esc(c)}" ${F.rarities.includes(c) ? 'checked' : ''}>${esc(c)}</label>`).join('')}</div>` : ''}
            ${uniq('set_name', scoped).length ? `<h3>弾・シリーズ</h3><div class="chips wrap">${uniq('set_name', scoped).map(c => `<label class="chip ck"><input type="checkbox" name="sets" value="${esc(c)}" ${F.sets.includes(c) ? 'checked' : ''}>${esc(c)}</label>`).join('')}</div>` : ''}
          </div>
          <div class="sheet-f"><button type="button" class="btn" id="freset">リセット</button><button class="btn primary" value="apply">この条件で表示</button></div>
        </form>
      </dialog>`;

    const qi = $('#q');
    let composing = false;
    qi.addEventListener('compositionstart', () => { composing = true; });
    qi.addEventListener('compositionend', () => { composing = false; qi.dispatchEvent(new Event('input')); });
    qi.addEventListener('input', debounce(() => {
      if (composing) return; F.q = qi.value; shown = PAGE; viewList(); const n = $('#q'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250));
    $$('[data-cat]').forEach(b => b.onclick = () => { F.cat = b.dataset.cat; F.sets = []; F.rarities = []; F.conds = []; shown = PAGE; viewList(); });
    $('#instock').onchange = e => { F.inStock = e.target.checked; viewList(); };
    $('#sort').onchange = e => { F.sort = e.target.value; viewList(); };
    $$('[data-more]').forEach(b => b.onclick = () => { F.sort = b.dataset.more; if (b.dataset.more === 'off') F.sale = true; viewList(); $('.listhead').scrollIntoView({ behavior: 'smooth' }); });
    const more = $('#more'); if (more) more.onclick = () => { shown += PAGE; viewList(); };
    const clear = $('#clearf'); if (clear) clear.onclick = () => { F = { ...defaultFilter(), sort: F.sort }; viewList(); };
    const dlg = $('#fdlg'); const ff = $('#ff');
    $('#openf').onclick = () => dlg.showModal();
    $$('[data-range]').forEach(b => b.onclick = () => { const [a, c] = b.dataset.range.split(','); ff.min.value = a === '0' ? '' : a; ff.max.value = c; });
    $('#freset').onclick = () => { $$('input[type=checkbox]', ff).forEach(i => i.checked = false); ff.min.value = ''; ff.max.value = ''; };
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'apply') return;
      const fd = new FormData(ff);
      Object.assign(F, { min: fd.get('min') || '', max: fd.get('max') || '', sale: !!fd.get('sale'), photo: !!fd.get('photo'), conds: fd.getAll('conds'), rarities: fd.getAll('rarities'), sets: fd.getAll('sets') });
      shown = PAGE; viewList();
    });
    bindCards();
  }

  // ─── 商品詳細 ───
  function priceChart(hist, current) {
    const pts = hist.map(h => ({ t: utcToDate(h.at).getTime(), v: h.price }));
    if (!pts.length || pts[pts.length - 1].v !== current) pts.push({ t: Date.now(), v: current });
    pts.push({ t: Date.now(), v: current });
    if (pts.length < 3 && pts[0].v === current) return `<p class="muted small">掲載開始から価格の変動はありません（${yen(current)}）</p>`;
    const W = 320, H = 110, P = 6;
    const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
    const vs = pts.map(p => p.v); const lo = Math.min(...vs), hi = Math.max(...vs); const span = hi - lo || 1;
    const x = t => P + (t - t0) / (t1 - t0) * (W - P * 2);
    const y = v => H - P - (v - lo) / span * (H - P * 2 - 14);
    let d = `M${x(pts[0].t)},${y(pts[0].v)}`;
    for (let i = 1; i < pts.length; i++) d += ` H${x(pts[i].t)} V${y(pts[i].v)}`;
    const diff = current - pts[0].v;
    return `
      <svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="価格推移">
        <path d="${d} V${H - P} H${x(pts[0].t)} Z" class="area"/><path d="${d}" class="line"/>
        <circle cx="${x(pts[pts.length - 1].t)}" cy="${y(current)}" r="3.5" class="dotc"/>
        <text x="${P}" y="12" class="lbl">最高 ${yen(hi)}</text><text x="${W - P}" y="12" class="lbl" text-anchor="end">最安 ${yen(lo)}</text>
      </svg>
      <p class="small">${jst(hist[0]?.at, { year: 'numeric', month: 'numeric', day: 'numeric' })}の掲載時から <b class="${diff < 0 ? 'down' : diff > 0 ? 'up' : ''}">${diff === 0 ? '変動なし' : (diff < 0 ? '-' : '+') + yen(Math.abs(diff))}</b></p>`;
  }

  async function viewProduct(id) {
    const p = byId.get(id);
    if (!p) { app.innerHTML = '<p class="pad center">商品が見つかりません。<a href="#/">一覧へ戻る</a></p>'; return; }
    if (F_ON.recent) pushRecent(id);
    const imgs = imagesOf(p);
    const variants = F_ON.siblings ? products.filter(x => gkey(x) === gkey(p)).sort((a, b) => condRank(a.condition) - condRank(b.condition) || a.price - b.price) : [p];
    const siblings = variants.filter(x => x.id !== p.id);
    const base = norm(p.name).replace(/(ex|v|vmax|vstar|gx)$/, '');
    const related = products.filter(x => x.id !== p.id && x.stock > 0 && !siblings.includes(x) && ((p.set_name && x.set_name === p.set_name) || (base.length >= 2 && norm(x.name).includes(base)))).slice(0, 12);
    const s = shipInfo();
    const earn = F_ON.points ? Math.floor(p.price * config.points.rate / 100) : 0;

    app.innerHTML = `
      <a href="#/" class="back">← 一覧へ戻る</a>
      <div class="detail">
        <div class="gallery">
          <div class="gmain">${imgs.length ? `<img id="gimg" src="${esc(imgs[0])}" alt="${esc(p.name)}">` : '<div class="noimg"><span>NO IMAGE</span></div>'}
            ${p.real_photo ? '<span class="rb photo big">実物写真</span>' : ''}${p.stock <= 0 ? '<span class="sold">売り切れ</span>' : ''}</div>
          ${imgs.length > 1 ? `<div class="thumbs">${imgs.map((u, i) => `<button class="${i ? '' : 'on'}" data-img="${esc(u)}"><img src="${esc(u)}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}
          <p class="muted small">${p.real_photo ? 'この商品は実物を撮影した写真を掲載しています。届くのは写真のカードそのものです。' : '画像はイメージです。状態は表記をご確認ください。'}</p>
        </div>
        <div class="dinfo">
          <p class="muted small">${esc(catLabel(p.category))}${p.set_name ? ' ／ ' + esc(p.set_name) : ''}</p>
          <h1>${esc(p.name)}</h1>
          <div class="pmeta">${p.card_no ? `<span>${esc(p.card_no)}</span>` : ''}${p.rarity ? `<span class="tag">${esc(p.rarity)}</span>` : ''}${condBadge(p.condition)}${p.sold >= 3 ? `<span class="hot">🔥 30日で${p.sold}点売れています</span>` : ''}</div>
          ${siblings.length ? `
            <div class="varpick"><span class="small muted">状態を選ぶ</span>
              <div class="vp">${variants.map(v => `<a href="#/p/${v.id}" class="${v.id === p.id ? 'on' : ''} ${v.stock > 0 ? '' : 'out'}">${condBadge(v.condition)}<b>${yen(v.price)}</b><span class="small">${v.stock > 0 ? '在庫' + v.stock : '売切'}</span></a>`).join('')}</div>
            </div>` : ''}
          <div class="dprice">${priceHtml(p, true)} <small class="muted">税込</small></div>
          ${earn ? `<p class="small earn">${earn}ポイント獲得（${config.points.rate}%還元）${me ? '' : ' <a href="#/account">会員登録</a>で貯まります'}</p>` : ''}
          <p class="stockline big ${p.stock > 0 && p.stock <= 2 ? 'low' : ''}">${p.stock > 0 ? (p.stock <= 2 ? `残りわずか：あと${p.stock}点` : `在庫 ${p.stock}点`) : '現在売り切れです'}</p>
          ${p.stock > 0 ? `
            <div class="qty-row">
              <select id="qty" aria-label="数量">${Array.from({ length: Math.min(p.stock, config.maxQtyPerItem) }, (_, i) => `<option>${i + 1}</option>`).join('')}</select>
              <button class="btn primary" id="add">カートに入れる</button>
              ${F_ON.favorites ? `<button class="btn icon favbig ${fav.has(p.id) ? 'on' : ''}" id="favb" aria-label="お気に入り">♥</button>` : ''}
            </div>` : `
            <form id="rs" class="restock">
              ${F_ON.restock && config.mailEnabled ? `<b>入荷したらメールでお知らせ</b>
              <div class="row"><input type="email" name="email" placeholder="メールアドレス" required value="${esc(me?.customer.email || store.get('pk_customer', {}).email)}"><button class="btn primary">登録</button></div>
              <span class="muted small">再入荷時に1度だけお送りします。</span>` : '<b>再入荷をお待ちください</b>'}
              ${F_ON.favorites ? `<button type="button" class="btn sm ${fav.has(p.id) ? 'primary' : ''}" id="favb">${fav.has(p.id) ? '♥ お気に入り登録済み' : '♡ お気に入りに追加'}</button>` : ''}
            </form>`}
          ${s ? `<div class="shipnote">${s.text}<br><span class="muted small">送料${yen(config.shippingFee)}（${yen(config.freeShippingOver)}以上で無料）${config.pickupEnabled ? '・店頭受け取りは送料無料' : ''}</span></div>` : ''}
          ${F_ON.priceHistory ? '<div class="box"><h3>価格の推移</h3><div id="chart"><p class="muted small">読み込み中…</p></div></div>' : ''}
          ${F_ON.buyback && p.buy_price > 0 ? `
            <div class="box buy">
              <div><span class="muted small">このカードの買取価格</span><div class="bp">${yen(p.buy_price)}</div></div>
              ${config.buybackUrl ? `<a class="btn" href="${esc(config.buybackUrl)}" target="_blank" rel="noopener">このカードを買取に出す</a>` : ''}
            </div>` : ''}
          ${p.description ? `<div class="desc">${esc(p.description).replace(/\n/g, '<br>')}</div>` : ''}
          ${config.condGuide.length ? `<details class="guide"><summary>状態表記について</summary>${config.condGuide.map(([k, v]) => `<p>${condBadge(k)} ${esc(v)}</p>`).join('')}</details>` : ''}
        </div>
      </div>
      ${related.length ? `<section class="strip"><div class="strip-h"><h2>関連する商品</h2></div><div class="strip-row">${related.map(x => pcard(x)).join('')}</div></section>` : ''}`;

    $$('[data-img]').forEach(b => b.onclick = () => { $('#gimg').src = b.dataset.img; $$('[data-img]').forEach(x => x.classList.toggle('on', x === b)); });
    const gi = $('#gimg'); if (gi && imgs.length > 1) gi.onclick = () => { const i = (imgs.indexOf(gi.getAttribute('src')) + 1) % imgs.length; $$('[data-img]')[i].click(); };
    const add = $('#add'); if (add) add.onclick = () => { if (cart.add(p.id, +$('#qty').value)) toast('カートに追加しました'); };
    const fb = $('#favb'); if (fb) fb.onclick = () => { const on = fav.toggle(p.id); toast(on ? 'お気に入りに追加しました' : 'お気に入りから外しました'); viewProduct(id); };
    const rs = $('#rs');
    if (rs && rs.email) rs.onsubmit = async e => {
      e.preventDefault();
      try { await api('/api/restock', { method: 'POST', body: JSON.stringify({ product_id: p.id, email: rs.email.value }) }); rs.innerHTML = '<b>入荷通知を登録しました</b><span class="muted small">入荷したらメールでお知らせします。</span>'; }
      catch (err) { toast(err.message); }
    };
    bindCards();
    if (F_ON.priceHistory) {
      try { const h = await api(`/api/products/${p.id}/history`); const c = $('#chart'); if (c) c.innerHTML = priceChart(h, p.price); }
      catch { const c = $('#chart'); if (c) c.innerHTML = '<p class="muted small">取得できませんでした</p>'; }
    }
  }

  // ─── オリパ ───
  async function viewOripaList() {
    if (!F_ON.oripa) { location.hash = '#/'; return; }
    await loadOripas(true);
    const live = oripas.filter(o => o.open), ended = oripas.filter(o => !o.open);
    app.innerHTML = `
      <h1 class="h">オリパ</h1>
      <div class="oripa-note">${esc(config.oripa.notice)}<br><b>${esc(config.oripa.ageNotice)}</b></div>
      <div class="ogrid">${live.map(oripaCard).join('') || '<p class="muted pad center">現在販売中のオリパはありません</p>'}</div>
      ${ended.length ? `<h2 class="h2">終了したオリパ</h2><div class="ogrid">${ended.map(oripaCard).join('')}</div>` : ''}`;
  }

  async function viewOripa(id) {
    if (!F_ON.oripa) { location.hash = '#/'; return; }
    let o;
    try { o = await api(`/api/oripas/${id}?_=${Date.now()}`); } catch (e) { app.innerHTML = `<p class="pad center">${esc(e.message)}</p>`; return; }
    const pool = o.prizes.filter(p => !p.is_last_one);
    const lastOne = o.prizes.find(p => p.is_last_one);
    const showQty = config.oripa.showQty, showValue = config.oripa.showValue;
    const expect = showQty && showValue && o.total ? Math.round(pool.reduce((s, p) => s + p.value * p.qty, 0) / o.total) : 0;
    const needPhone = config.phoneEnabled && config.phone.forOripa;
    const inCart = cart.oripa[o.id] || 0;
    const limit = Math.max(0, Math.min(o.max_per_order, config.oripa.maxPerOrder, o.remaining) - inCart);
    const limitC = Math.max(0, Math.min(o.max_per_order, config.oripa.maxPerOrder, o.remaining));
    if (F_ON.coins && token && !me) await refreshMe();
    const coinBal = F_ON.coins && me ? (await api('/api/me/coins').catch(() => ({ coins: 0 }))).coins : 0;
    const pick = F_ON.coins && o.pick_mode && o.board;
    const picked = new Set();
    app.innerHTML = `
      <a href="#/oripa" class="back">← オリパ一覧へ</a>
      <div class="detail">
        <div class="gallery">
          ${o.image_url ? `<img class="oripa-main" src="${esc(o.image_url)}" alt="">` : `<div class="oph big">${esc(o.title)}</div>`}
        </div>
        <div class="dinfo">
          <h1>${esc(o.title)}</h1>
          <div class="dprice">${F_ON.coins ? `<span class="price big">${o.price.toLocaleString()}</span><small class="muted">${esc(config.coin.name)}／1口</small>` : `<span class="price big">${yen(o.price)}</span><small class="muted">／1口（税込）</small>`}</div>
          <div class="obar big"><i style="width:${o.total ? Math.round(o.remaining / o.total * 100) : 0}%"></i></div>
          <p class="row-between"><span>残り <b class="big-num">${o.remaining}</b> / ${o.total}口</span>${o.ends_at ? `<span class="muted small">${jst(o.ends_at)}まで</span>` : ''}</p>
          ${!o.open ? '<p class="danger"><b>このオリパは完売・終了しました</b></p>' : F_ON.coins ? (pick ? pickPanel(o, limitC) : coinPanel(o, limitC)) : `
            <div class="qty-row">
              <select id="oqty">${[1, 3, 5, 10, 20, 50].filter(n => n <= limit).concat(limit && ![1, 3, 5, 10, 20, 50].includes(limit) ? [limit] : []).map(n => `<option value="${n}">${n}口 ${yen(n * o.price)}</option>`).join('')}</select>
              <button class="btn primary" id="oadd" ${limit ? '' : 'disabled'}>カートに入れる</button>
            </div>
            ${inCart ? `<p class="small">カートに${inCart}口入っています。<a href="#/cart">カートを見る</a></p>` : ''}`}
          <div class="oripa-note small">${config.oripa.requireLogin ? `ご購入には会員登録（ログイン）${needPhone ? 'と電話番号認証' : ''}が必要です。` : ''}${F_ON.coins ? `${esc(config.coin.name)}で引くとその場で結果が出ます。` : '抽選は注文時にサーバーで行い、ご入金確認後に開封できます。'}<br><a href="#important" class="jump-imp">【重要事項】を必ずご確認ください</a></div>
          ${o.description ? `<div class="desc">${esc(o.description).replace(/\n/g, '<br>')}</div>` : ''}
        </div>
      </div>
      ${pick ? `<div class="box boardbox" id="boardbox">
        <div class="row-between"><h3 style="margin:0">パックを選ぶ</h3><span class="small muted" id="bstat"></span></div>
        <p class="small muted" style="margin:4px 0 10px">${o.open ? `タップして選び、「開封する」で開けます。開けられたパックには${o.board.reveal === 'rank' ? '当たった賞が色で' : '中身が'}表示されます。` : `開封済みのパックの${o.board.reveal === 'rank' ? '賞' : '中身'}です。`}</p>
        <div class="board" id="board"></div></div>
        ${o.open && me ? `<div class="pickbar" id="pickbar" hidden><span><b id="pbn">0</b>個　<b id="pbc">0</b>${esc(config.coin.name)}</span><button class="btn" id="pbclear">選び直す</button><button class="btn primary" id="pbopen">開封する</button></div>` : ''}` : ''}
      ${importantHtml()}
      <div class="box">
        <h3>封入内容</h3>
        ${showQty ? `<p class="small muted">全${o.total}口の封入内容です。封入率は全${o.total}口に対する割合です。</p>` : ''}
        <div class="prizes">
          ${pool.map(p => `
            <div class="prize">
              ${p.image_url ? `<img src="${esc(p.image_url)}" alt="" loading="lazy">` : '<div class="noimg sm"></div>'}
              <div class="pz-b"><span class="tag rank">${esc(p.rank)}</span> <b>${esc(p.name)}</b>
                ${showQty || showValue ? `<div class="small muted">${[showValue && `参考価格 ${yen(p.value)}`, showQty && `封入率 ${o.total ? (p.qty / o.total * 100).toFixed(p.qty / o.total < 0.01 ? 2 : 1) : '0'}%`].filter(Boolean).join('　')}</div>` : ''}</div>
              ${showQty ? `<div class="pz-n"><b>${p.qty}</b><span class="small muted">口</span></div>` : '<span></span>'}
            </div>`).join('')}
          ${lastOne ? `
            <div class="prize last">
              ${lastOne.image_url ? `<img src="${esc(lastOne.image_url)}" alt="" loading="lazy">` : '<div class="noimg sm"></div>'}
              <div class="pz-b"><span class="tag rank lo">ラストワン賞</span> <b>${esc(lastOne.name)}</b><div class="small muted">最後の1口を引いた方に追加でプレゼント${showValue ? `（参考価格 ${yen(lastOne.value)}）` : ''}</div></div>
              <span></span>
            </div>` : ''}
        </div>
        ${expect ? `<p class="small muted">1口あたりの参考価格の平均 ${yen(expect)}（参考価格は当店の目安です）</p>` : ''}
      </div>
      ${o.recent.length ? `<div class="box"><h3>最近の当選</h3><div class="recent">${o.recent.map(r => `<div class="small"><span class="tag rank ${r.is_last_one ? 'lo' : ''}">${esc(r.is_last_one ? 'ラストワン' : r.rank)}</span> ${esc(r.name)} <span class="muted">${jst(r.revealed_at)}</span></div>`).join('')}</div></div>` : ''}`;
    const add = $('#oadd');
    if (add) add.onclick = () => { const n = +$('#oqty').value; cart.setOripa(o.id, inCart + n); toast(`${n}口をカートに入れました`); viewOripa(id); };
    $$('[data-draw]').forEach(b => b.onclick = async () => {
      const agree = $('#oagree');
      if (agree && !agree.checked) { toast('注意事項への同意にチェックしてください'); agree.focus(); return; }
      const n = nOf(b);
      $$('[data-draw]').forEach(x => x.disabled = true);
      try {
        const r = await api(`/api/oripas/${o.id}/draw`, { method: 'POST', body: JSON.stringify({ qty: n, agree: true }) });
        showDrawResult(r, o, id);
      } catch (e) {
        toast(e.message);
        if (e.status === 403 && /電話番号/.test(e.message)) location.hash = '#/account';
        $$('[data-draw]').forEach(x => x.disabled = false);
      }
    });

    // 「1回引く」「10回引く」「選択した回数引く」
    function drawBtns(attr, lim) {
      const cn = esc(config.coin.name);
      if (!lim) return '';
      const cost = k => `${(k * o.price).toLocaleString()}${cn}`;
      const fixed = [1, 10].filter(k => k <= lim);
      const def = Math.min(lim, 5);
      const all = o.allin_under > 0 && o.remaining > 0 && o.remaining <= o.allin_under ? o.remaining : 0;
      return `${all ? `<button type="button" class="btn primary block allin" ${attr}="all" ${coinBal < all * o.price ? 'disabled' : ''}><b>残り全部引く（${all}口${o.prizes.some(p => p.is_last_one) ? '・ラストワン賞つき' : ''}）</b><span class="small">${cost(all)}</span></button>` : ''}
        <div class="drawbtns" style="margin-top:4px">${fixed.map(k => `<button type="button" class="btn ${k === 1 ? '' : 'primary'}" ${attr}="${k}" ${coinBal < k * o.price ? 'disabled' : ''}><b>${k}回引く</b><span class="small">${cost(k)}</span></button>`).join('')}</div>
        ${lim > 1 ? `<div class="drawpick"><select id="dnum" aria-label="引く回数">${Array.from({ length: Math.min(lim, 100) }, (_, i) => i + 1).map(k => `<option value="${k}" ${k === def ? 'selected' : ''}>${k}回</option>`).join('')}</select>
          <button type="button" class="btn primary" ${attr}="sel" id="dsel" ${coinBal < def * o.price ? 'disabled' : ''}><b>選択した回数引く</b><span class="small" id="dselc">${cost(def)}</span></button></div>` : ''}`;
    }
    const nOf = b => { const v = b.dataset.draw || b.dataset.rnd; return v === 'sel' ? +$('#dnum').value : v === 'all' ? o.remaining : +v; };
    const dn = $('#dnum');
    if (dn) dn.onchange = () => { const k = +dn.value; $('#dselc').textContent = `${(k * o.price).toLocaleString()}${config.coin.name}`; $('#dsel').disabled = coinBal < k * o.price; };

    // ── ボード形式（パックを選んで開ける） ──
    function pickPanel(o, lim) {
      const cn = esc(config.coin.name);
      if (!me) return `<div class="coinpanel"><p class="small">パックを選んで、${cn}で開けられます。</p><a class="btn primary block" href="#/account?next=oripa/${o.id}">ログインして選ぶ</a></div>`;
      return `<div class="coinpanel">
        <div class="row-between"><span class="small">保有${cn}</span><span><b class="big-num">${coinBal.toLocaleString()}</b> <a class="btn sm" href="#/coins">購入する</a></span></div>
        <label class="check agree small"><input type="checkbox" id="oagree" ${store.get('pk_oripa_agree', false) ? 'checked' : ''}> <span><a href="#important" class="jump-imp">【重要事項】</a>を確認し、同意します（${esc(config.oripa.ageNotice)}）</span></label>
        <button type="button" class="btn block" id="gopick" style="margin-top:0"><b>パックを選んで開ける</b></button>
        <p class="small muted" style="margin:0">ボードから好きなパックを選べます（1回に${lim}個まで）。</p>
        <div><span class="small">選ばずにランダムで引く</span>${drawBtns('data-rnd', lim)}</div>
        ${coinBal < o.price ? `<p class="small danger" style="margin:0">${cn}が足りません。<a href="#/coins">${cn}を購入する</a></p>` : ''}
      </div>`;
    }
    function paintBoard(board) {
      const el = $('#board'); if (!el) return;
      const opened = new Map(board.opened.map(x => [x.slot, x]));
      const lost = [...picked].filter(s => opened.has(s));
      lost.forEach(s => picked.delete(s));
      if (lost.length) toast(`選んでいた${lost.join('・')}番は、ほかの方が開けました`);
      let html = '';
      for (let n = 1; n <= board.size; n++) {
        const x = opened.get(n);
        const logoTxt = esc(config.logoText || 'PK');
        html += !x
          ? `<button type="button" class="bt ${picked.has(n) ? 'on' : ''}" data-slot="${n}" ${o.open && me ? '' : 'disabled'} aria-pressed="${picked.has(n)}" aria-label="${n}番のパック"><span class="bt-pk"><span class="bt-logo">${logoTxt}</span></span><i>${n}</i></button>`
          : board.reveal === 'rank' || !x.image_url
            ? `<div class="bt open bt-rank fx-${x.fx || 0}" title="${n}番：${esc(x.is_last_one ? 'ラストワン賞' : x.rank)}"><span class="bt-pk"><b>${esc(x.rank || '')}</b></span><i>${n}</i></div>`
            : `<div class="bt open bt-card fx-${x.fx || 0}" title="${n}番：${esc(x.rank)} ${esc(x.name)}"><img src="${esc(x.image_url)}" alt="" loading="lazy"><span class="bt-r">${esc(x.rank)}</span><i>${n}</i></div>`;
      }
      el.innerHTML = html;
      $('#bstat').textContent = `開封済み ${board.opened.length} / ${board.size}`;
      $$('[data-slot]', el).forEach(b => b.onclick = () => togglePick(+b.dataset.slot, b));
      syncBar();
    }
    function togglePick(n, b) {
      if (picked.has(n)) picked.delete(n);
      else {
        if (picked.size >= limitC) { toast(`1回に開けられるのは${limitC}個までです`); return; }
        picked.add(n);
      }
      if (b) { b.classList.toggle('on', picked.has(n)); b.setAttribute('aria-pressed', picked.has(n)); }
      syncBar();
    }
    function syncBar() {
      const bar = $('#pickbar'); if (!bar) return;
      bar.hidden = !picked.size;
      $('#pbn').textContent = picked.size;
      $('#pbc').textContent = (picked.size * o.price).toLocaleString();
      $('#pbopen').disabled = picked.size * o.price > coinBal;
    }
    if (pick) {
      paintBoard(o.board);
      $$('[data-rnd]').forEach(b => b.onclick = () => openPacks({ qty: nOf(b) }, b));
      const gp = $('#gopick'); if (gp) gp.onclick = () => { $('#boardbox').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('#boardbox').classList.add('flash'); setTimeout(() => $('#boardbox')?.classList.remove('flash'), 1200); };
      const clr = $('#pbclear'); if (clr) clr.onclick = () => { picked.clear(); paintBoard(o.board); };
      const op = $('#pbopen');
      if (op) op.onclick = () => openPacks({ slots: [...picked].sort((a, b) => a - b) }, op);
      async function openPacks(body, btn) {
        const agree = $('#oagree');
        if (agree && !agree.checked) { toast('注意事項への同意にチェックしてください'); agree.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
        btn.disabled = true;
        try {
          const r = await api(`/api/oripas/${o.id}/draw`, { method: 'POST', body: JSON.stringify({ ...body, agree: true }) });
          picked.clear();
          showDrawResult(r, o, id);
          viewOripa(id);
        } catch (e) {
          toast(e.message);
          if (e.status === 403 && /電話番号/.test(e.message)) { location.hash = '#/account'; return; }
          if (e.status === 409) { try { o.board = (await api(`/api/oripas/${o.id}?_=${Date.now()}`)).board; paintBoard(o.board); } catch { /* 次の更新で直る */ } }
          btn.disabled = false;
        }
      }
      // ほかのお客様が開けたパックを数十秒ごとに反映（表示し直すたびに前のタイマーは止める。
      // 古いタイマーが残ると、空の選択でボードを描き直して選んだパックが外れてしまう）
      clearInterval(window.__pkBoardTick);
      const tick = window.__pkBoardTick = setInterval(async () => {
        if (!$('#board') || window.__pkBoardTick !== tick) { clearInterval(tick); return; }
        if (document.hidden || document.querySelector('.op-ov')) return;
        try { const x = await api(`/api/oripas/${o.id}?_=${Date.now()}`); if (x.board && x.board.opened.length !== o.board.opened.length) { o.board = x.board; paintBoard(o.board); } } catch { /* 通信エラーは次回 */ }
      }, 20000);
    }

    function coinPanel(o, lim) {
      const cn = esc(config.coin.name);
      if (!me) return `<div class="coinpanel"><p class="small">${cn}を購入して引くと、その場で結果が出ます。</p><a class="btn primary block" href="#/account?next=oripa/${o.id}">ログインして引く</a></div>`;
      return `<div class="coinpanel">
        <div class="row-between"><span class="small">保有${cn}</span><span><b class="big-num">${coinBal.toLocaleString()}</b> <a class="btn sm" href="#/coins">購入する</a></span></div>
        <label class="check agree small"><input type="checkbox" id="oagree" ${store.get('pk_oripa_agree', false) ? 'checked' : ''}> <span><a href="#important" class="jump-imp">【重要事項】</a>を確認し、同意します（${esc(config.oripa.ageNotice)}）</span></label>
        ${drawBtns('data-draw', lim)}
        ${coinBal < o.price ? `<p class="small danger">${cn}が足りません。<a href="#/coins">${cn}を購入する</a></p>` : ''}
      </div>`;
    }
    $$('.jump-imp').forEach(a => a.onclick = e => { e.preventDefault(); const box = $('#important'); if (box) { box.open = true; box.scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
    const ag = $('#oagree'); if (ag) ag.onchange = () => store.set('pk_oripa_agree', ag.checked);
  }

  // 抽選結果（その場で開封）
  function showDrawResult(r, o, id) {
    window.PKOpening.play(r.draws, {
      title: o.title, logo: config.logoText || 'PK', shop: config.shopName,
      sub: `当選したカードは「獲得カード」に入りました（残り ${r.coins.toLocaleString()}${esc(config.coin.name)}）`,
      actions: [{ key: 'box', label: '獲得カードを見る' }, { key: 'again', label: o.pick_mode ? '続けて選ぶ' : '続けて引く', primary: true }],
      onAction(key, close) { close(); if (key === 'box') location.hash = '#/box'; else viewOripa(id); },
    });
  }

  // ─── コイン購入 ───
  async function viewCoins() {
    if (!F_ON.coins) { location.hash = '#/'; return; }
    if (!token) { location.hash = '#/account?next=coins'; return; }
    const s = await api('/api/me/coins');
    const cn = esc(config.coin.name);
    app.innerHTML = `
      <h1 class="h">${cn}を購入</h1>
      <div class="pointcard coin"><span class="small">保有${cn}</span><b>${s.coins.toLocaleString()}</b>
        <span class="small">${s.next_expire ? `うち ${s.next_expire.amount.toLocaleString()} は ${jst(s.next_expire.expires_at, { year: 'numeric', month: 'numeric', day: 'numeric' })} に失効` : 'オリパを引くのに使えます'}</span></div>
      <form id="cf2" class="form">
        <fieldset><legend>購入する金額</legend>
          <div class="packs">${config.coin.packs.map((p, i) => `<label class="pack"><input type="radio" name="pack" value="${i}" ${i === 0 ? 'checked' : ''}><span><b>${p.coins.toLocaleString()}${cn}</b>${p.coins > p.price ? `<em>+${(p.coins - p.price).toLocaleString()}お得</em>` : ''}<span class="small">${yen(p.price)}</span></span></label>`).join('')}</div>
        </fieldset>
        <fieldset><legend>お支払い方法</legend>
          ${config.cardEnabled ? '<label class="radio"><input type="radio" name="pay" value="card" checked> クレジットカード<span class="muted small">決済が終わるとすぐに付与されます</span></label>' : ''}
          ${config.bankEnabled ? `<label class="radio"><input type="radio" name="pay" value="bank" ${config.cardEnabled ? '' : 'checked'}> 銀行振込<span class="muted small">ご入金を確認してから付与します</span></label>` : ''}
        </fieldset>
        <div class="oripa-note small">
          ・${cn}は当店のオリパにのみ使えます（1${cn}＝1円相当）。<br>
          ・${config.coin.expireMonths ? `有効期限は付与から${config.coin.expireMonths}か月です。期限を過ぎた${cn}は失効します。` : '有効期限はありません。'}<br>
          ・購入した${cn}の払い戻し・換金はできません。当選したカードを${cn}に戻すこともできません。<br>
          ・<a href="legal.html#coin" target="_blank">${cn}に関する表示</a>
        </div>
        <button class="btn primary block">購入する</button>
      </form>
      ${s.ledger.length ? `<details class="box"><summary><b>${cn}の履歴</b></summary><table class="sib">${s.ledger.map(l => `<tr><td class="small">${jst(l.created_at)}</td><td class="small">${esc(l.reason)}</td><td class="${l.delta > 0 ? 'ok' : 'danger'}">${l.delta > 0 ? '+' : ''}${l.delta.toLocaleString()}</td></tr>`).join('')}</table></details>` : ''}`;
    $('#cf2').onsubmit = async e => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      const btn = $('#cf2 button.primary'); btn.disabled = true;
      try {
        const r = await api('/api/coins/buy', { method: 'POST', body: JSON.stringify({ pack: +fd.pack, payment_method: fd.pay || 'bank' }) });
        const hist = store.get('pk_orders', []); hist.unshift({ no: r.order_no, t: r.token, at: Date.now(), total: r.total }); store.set('pk_orders', hist.slice(0, 30));
        if (r.checkout_url) location.href = r.checkout_url; else location.hash = `#/order/${r.order_no}?t=${r.token}&new=1`;
      } catch (err) { toast(err.message); btn.disabled = false; }
    };
  }

  // ─── 獲得カードBOX ───
  async function viewBox() {
    if (!token) { location.hash = '#/account'; return; }
    await refreshMe();
    if (!me) { location.hash = '#/account'; return; }
    const list = await api('/api/me/prizes');
    const c = me.customer;
    app.innerHTML = `
      <h1 class="h">獲得カード <span class="muted small">${list.length}枚</span></h1>
      ${list.length ? `
        <div class="toolbar2"><label class="check"><input type="checkbox" id="all" checked> すべて選択</label></div>
        <div class="boxgrid">${list.map(d => `<label class="bx"><input type="checkbox" class="sel" value="${d.id}" checked>
          ${d.image_url ? `<img src="${esc(d.image_url)}" alt="" loading="lazy">` : '<div class="noimg sm"></div>'}
          <span class="tag rank ${d.is_last_one ? 'lo' : ''}">${esc(d.is_last_one ? 'ラストワン' : d.rank)}</span><b>${esc(d.name)}</b><span class="muted small">${esc(d.title)}</span></label>`).join('')}</div>
        <form id="sf2" class="form" style="margin-top:12px">
          <fieldset><legend>発送を依頼する</legend>
            ${config.pickupEnabled ? `<label class="radio"><input type="radio" name="ship" value="delivery" checked> 配送</label><label class="radio"><input type="radio" name="ship" value="pickup"> 店頭で受け取る<span class="muted small">${esc(config.pickupInfo)}</span></label>` : ''}
            <label>お名前<input name="name" value="${esc(c.name)}" required></label>
            <label>電話番号<input name="phone" type="tel" value="${esc(c.phone)}" required></label>
            <div id="addr2" class="sub"><label>郵便番号<input name="zip" inputmode="numeric" value="${esc(c.zip)}"></label>
            <label>住所<textarea name="address" rows="2">${esc(c.address)}</textarea></label>
            <label class="check"><input type="checkbox" name="save_address" checked> この住所を会員情報に保存する</label></div>
            <label>備考<textarea name="note" rows="2"></textarea></label>
            <div class="shipfee small" id="shipfee"></div>
            <button class="btn primary block" id="shipbtn">選んだカードの発送を依頼</button>
          </fieldset>
        </form>` : `<p class="muted pad center">まだ獲得カードはありません。<br><a class="btn" href="#/oripa">オリパを見る</a></p>`}`;
    if (!list.length) return;
    const sf = $('#sf2');
    // 発送料：選んだカードの販売金額（引いたときの1口の価格）の合計が基準以上なら無料
    const cn = esc(config.coin.name);
    const feeLine = () => {
      const ids = new Set($$('.sel').filter(x => x.checked).map(x => +x.value));
      const sale = list.filter(d => ids.has(d.id)).reduce((s, d) => s + (d.price || 0), 0);
      const over = config.coin.freeShipOver, base = config.coin.shipFee;
      const pickup = sf.ship && sf.ship.value === 'pickup';
      const free = pickup || !base || (over > 0 && sale >= over);
      $('#shipfee').innerHTML = `<div class="row-between"><span>選んだカード ${ids.size}枚（販売金額 ${sale.toLocaleString()}${cn}）</span><b>発送料：${free ? '無料' : `${base.toLocaleString()}${cn}`}</b></div>
        ${base && over > 0 && !pickup ? (sale >= over ? `<p class="ok" style="margin:2px 0 0">販売金額${over.toLocaleString()}${cn}以上のため送料無料です</p>` : `<p class="muted" style="margin:2px 0 0">販売金額の合計が${over.toLocaleString()}${cn}以上で送料無料（あと${(over - sale).toLocaleString()}${cn}）</p><div class="fb-track"><i style="width:${Math.min(100, Math.round(sale / over * 100))}%"></i></div>`) : ''}`;
    };
    const all = $('#all'); all.onchange = () => { $$('.sel').forEach(x => x.checked = all.checked); feeLine(); };
    $$('.sel').forEach(x => x.onchange = feeLine);
    $$('[name=ship]', sf).forEach(r => r.onchange = () => { $('#addr2').hidden = sf.ship.value === 'pickup'; feeLine(); });
    feeLine();
    sf.onsubmit = async e => {
      e.preventDefault();
      const ids = $$('.sel').filter(x => x.checked).map(x => +x.value);
      if (!ids.length) { toast('発送するカードを選んでください'); return; }
      const fd = Object.fromEntries(new FormData(sf));
      $('#shipbtn').disabled = true;
      try {
        const r = await api('/api/me/prizes/ship', { method: 'POST', body: JSON.stringify({ ids, shipping_method: fd.ship || 'delivery', save_address: !!fd.save_address, customer: { name: fd.name, phone: fd.phone, zip: fd.zip, address: fd.address, note: fd.note } }) });
        toast('発送依頼を受け付けました');
        location.hash = `#/order/${r.order_no}?t=${r.token}`;
      } catch (err) { toast(err.message); $('#shipbtn').disabled = false; }
    };
  }

  // ─── カート ───
  let coupon = store.get('pk_coupon', null);
  const cartLines = () => Object.entries(cart.items).map(([id, qty]) => ({ id: +id, qty, p: byId.get(+id) })).filter(l => l.p);
  const oripaLines = () => Object.entries(cart.oripa).map(([id, qty]) => ({ id: +id, qty, o: (oripas || []).find(x => x.id === +id) })).filter(l => l.o);

  async function getQuote(extra = {}) {
    return api('/api/quote', { method: 'POST', body: JSON.stringify({ items: cart.payload(), coupon_code: coupon?.code || '', ...extra }) });
  }
  function summaryHtml(q, opts = {}) {
    return `
      ${opts.lines || ''}
      <div><span>小計</span><span>${yen(q.subtotal)}</span></div>
      ${q.discount ? `<div class="ok"><span>クーポン（${esc(q.coupon?.code || '')}）</span><span>-${yen(q.discount)}</span></div>` : ''}
      ${q.points_use ? `<div class="ok"><span>ポイント利用</span><span>-${yen(q.points_use)}</span></div>` : ''}
      <div><span>${opts.pickup ? '店頭受け取り' : '送料'}</span><span>${q.shipping ? yen(q.shipping) : '無料'}</span></div>
      <div class="total"><span>合計</span><span>${yen(q.total)}</span></div>
      ${q.points_earn ? `<p class="earn small">このご注文で <b>${q.points_earn}ポイント</b> 獲得予定</p>` : ''}`;
  }

  async function viewCart() {
    if (Object.keys(cart.oripa).length) await loadOripas(true);
    const lines = cartLines(), olines = oripaLines();
    if (!lines.length && !olines.length) { app.innerHTML = `<div class="pad center"><p>カートは空です</p><p><a class="btn" href="#/">商品を見る</a> ${F_ON.deck ? '<a class="btn" href="#/deck">デッキリストから探す</a>' : ''}</p></div>`; return; }
    const problems = lines.filter(l => l.p.stock < l.qty).length + olines.filter(l => l.o.remaining < l.qty).length;
    const sub = lines.reduce((s, l) => s + l.p.price * l.qty, 0) + olines.reduce((s, l) => s + l.o.price * l.qty, 0);
    const rest = config.freeShippingOver - sub;
    const pct = Math.min(100, Math.round(sub / Math.max(1, config.freeShippingOver) * 100));
    const saved = lines.reduce((s, l) => s + (l.p.compare_price > l.p.price ? (l.p.compare_price - l.p.price) * l.qty : 0), 0);
    app.innerHTML = `
      <h1 class="h">カート <span class="muted small">${cart.count()}点</span></h1>
      <div class="freebar ${rest <= 0 ? 'done' : ''}"><div class="fb-track"><i style="width:${pct}%"></i></div>
        <span>${rest > 0 ? `あと<b>${yen(rest)}</b>で送料無料` : '🎉 送料無料になりました'}</span></div>
      <div class="lines">
        ${olines.map(l => `
          <div class="line ${l.o.remaining < l.qty ? 'warn' : ''}">
            <a class="limg" href="#/oripa/${l.id}">${l.o.image_url ? `<img src="${esc(l.o.image_url)}" alt="">` : '<div class="noimg"><span>ORIPA</span></div>'}</a>
            <div class="linfo"><span class="tag rank">オリパ</span><a class="lname" href="#/oripa/${l.id}">${esc(l.o.title)}</a><div><span class="price">${yen(l.o.price)}</span><span class="muted small">／口</span></div>
              ${l.o.remaining < l.qty ? `<div class="danger small">残りが${l.o.remaining}口になりました</div>` : ''}</div>
            <div class="lqty"><select data-oq="${l.id}">${Array.from({ length: Math.max(1, Math.min(l.o.remaining, l.o.max_per_order, config.oripa.maxPerOrder)) }, (_, i) => `<option ${i + 1 === l.qty ? 'selected' : ''}>${i + 1}</option>`).join('')}</select><button class="link danger" data-odel="${l.id}">削除</button></div>
          </div>`).join('')}
        ${lines.map(l => `
          <div class="line ${l.p.stock < l.qty ? 'warn' : ''}">
            <a class="limg" href="#/p/${l.id}">${cardImage(l.p)}</a>
            <div class="linfo">
              <a class="lname" href="#/p/${l.id}">${esc(l.p.name)}</a>
              <div class="pmeta">${esc(l.p.card_no)} ${condBadge(l.p.condition)}</div>
              <div>${priceHtml(l.p)}</div>
              ${l.p.stock < l.qty ? `<div class="danger small">在庫が${l.p.stock}点に減りました</div>` : ''}
            </div>
            <div class="lqty">
              <select data-q="${l.id}" aria-label="数量">${Array.from({ length: Math.max(1, Math.min(l.p.stock, config.maxQtyPerItem)) }, (_, i) => `<option ${i + 1 === l.qty ? 'selected' : ''}>${i + 1}</option>`).join('')}</select>
              <button class="link danger" data-del="${l.id}">削除</button>
            </div>
          </div>`).join('')}
      </div>
      ${F_ON.coupons && lines.length ? `<form class="coupon" id="cf">
        ${coupon ? `<span>クーポン <b>${esc(coupon.code)}</b>（${esc(coupon.label)}）適用中</span><button type="button" class="link" id="cdel">外す</button>`
          : `<input name="code" placeholder="クーポンコード" autocapitalize="characters"><button class="btn sm">適用</button>`}
      </form>` : ''}
      <div class="summary" id="sum"><p class="muted small">計算中…</p></div>
      ${saved ? `<p class="ok small center">セール価格で${yen(saved)}お得になっています</p>` : ''}
      <a class="btn primary block ${problems ? 'disabled' : ''}" href="${problems ? 'javascript:void 0' : '#/checkout'}">ご購入手続きへ</a>
      ${problems ? '<p class="danger small center">在庫が足りない商品があります。数量を変更してください</p>' : ''}
      <a href="#/" class="btn block">買い物を続ける</a>`;
    $$('select[data-q]').forEach(s => s.onchange = () => { cart.set(+s.dataset.q, +s.value); viewCart(); });
    $$('[data-del]').forEach(b => b.onclick = () => { cart.set(+b.dataset.del, 0); viewCart(); });
    $$('select[data-oq]').forEach(s => s.onchange = () => { cart.setOripa(+s.dataset.oq, +s.value); viewCart(); });
    $$('[data-odel]').forEach(b => b.onclick = () => { cart.setOripa(+b.dataset.odel, 0); viewCart(); });
    const cf = $('#cf');
    if (cf) cf.onsubmit = async e => {
      e.preventDefault();
      try { coupon = await api('/api/coupon', { method: 'POST', body: JSON.stringify({ code: cf.code.value, items: cart.payload() }) }); store.set('pk_coupon', coupon); toast('クーポンを適用しました'); viewCart(); }
      catch (err) { toast(err.message); }
    };
    const cd = $('#cdel'); if (cd) cd.onclick = () => { coupon = null; store.set('pk_coupon', null); viewCart(); };
    try { const q = await getQuote(); $('#sum').innerHTML = summaryHtml(q) + (F_ON.points && !me ? `<p class="small"><a href="#/account">ログイン・会員登録</a>するとポイントが貯まります</p>` : ''); }
    catch (e) {
      if (coupon && /クーポン/.test(e.message)) { toast(e.message); coupon = null; store.set('pk_coupon', null); return viewCart(); }
      $('#sum').innerHTML = `<p class="danger small">${esc(e.message)}</p>`;
    }
  }

  // ─── 購入手続き ───
  async function viewCheckout() {
    if (Object.keys(cart.oripa).length) await loadOripas(true);
    const lines = cartLines(), olines = oripaLines();
    if (!lines.length && !olines.length) { location.hash = '#/cart'; return; }
    const needLogin = (!F_ON.guestCheckout || (olines.length && config.oripa.requireLogin)) && !me;
    if (needLogin) {
      app.innerHTML = `<a href="#/cart" class="back">← カートへ戻る</a><div class="box center"><h2>${olines.length && F_ON.guestCheckout ? 'オリパのご購入には会員登録が必要です' : 'ご購入には会員登録が必要です'}</h2>
        <p class="small">ログインまたは会員登録すると、購入手続きに進めます。${F_ON.points && config.points.signupBonus ? `<br>今なら登録で<b>${config.points.signupBonus}ポイント</b>プレゼント。` : ''}</p>
        <a class="btn primary" href="#/account?next=checkout">ログイン・会員登録</a></div>`;
      return;
    }
    if (olines.length && config.phoneEnabled && config.phone.forOripa && me && !me.customer.phone_verified) {
      app.innerHTML = `<a href="#/cart" class="back">← カートへ戻る</a><div class="box center"><h2>オリパのご購入には電話番号認証が必要です</h2>
        <p class="small">マイページでSMS認証（1分ほど）を済ませてから、購入手続きにお進みください。</p><a class="btn primary" href="#/account?next=checkout">電話番号を認証する</a></div>`;
      return;
    }
    const prev = store.get('pk_customer', {});
    const mc = me?.customer;
    const saved = { name: mc?.name || prev.name, kana: mc?.kana || prev.kana, email: mc?.email || prev.email, phone: mc?.phone || prev.phone, zip: mc?.zip || prev.zip, address: mc?.address || prev.address };
    let pickup = config.pickupEnabled && prev.ship === 'pickup';
    let pointsUse = 0;
    const canPoints = F_ON.points && me && me.customer.points > 0;
    const itemLines = [
      ...olines.map(l => `<div class="small"><span>オリパ「${esc(l.o.title)}」× ${l.qty}口</span><span>${yen(l.o.price * l.qty)}</span></div>`),
      ...lines.map(l => `<div class="small"><span>${esc(l.p.name)} ${esc(l.p.condition)} × ${l.qty}</span><span>${yen(l.p.price * l.qty)}</span></div>`),
    ].join('');
    app.innerHTML = `
      <a href="#/cart" class="back">← カートへ戻る</a>
      <h1 class="h">ご購入手続き</h1>
      ${F_ON.members && !me ? `<div class="loginhint"><span>会員の方は<a href="#/account?next=checkout">ログイン</a>で入力を省略${F_ON.points ? '・ポイントが貯まります' : ''}</span></div>` : ''}
      <form id="f" class="form" novalidate>
        ${config.pickupEnabled ? `
        <fieldset><legend>お受け取り方法</legend>
          <label class="radio"><input type="radio" name="ship" value="delivery" ${pickup ? '' : 'checked'}> 配送<span class="muted small">送料${yen(config.shippingFee)}（${yen(config.freeShippingOver)}以上無料）・追跡番号つき</span></label>
          <label class="radio"><input type="radio" name="ship" value="pickup" ${pickup ? 'checked' : ''}> 店頭で受け取る（送料無料）<span class="muted small">${esc(config.pickupInfo)}</span></label>
        </fieldset>` : ''}
        <fieldset><legend>お客様情報</legend>
          <label>お名前 <em>必須</em><input name="name" required autocomplete="name" value="${esc(saved.name)}"></label>
          <label>フリガナ<input name="kana" value="${esc(saved.kana)}"></label>
          <label>メールアドレス <em>必須</em><input name="email" type="email" required autocomplete="email" value="${esc(saved.email)}" ${mc ? 'readonly' : ''}></label>
          <label>電話番号 <em>必須</em><input name="phone" type="tel" required autocomplete="tel" value="${esc(saved.phone)}"></label>
          <div id="addr" class="sub">
            <label>郵便番号 <em>必須</em><input name="zip" inputmode="numeric" autocomplete="postal-code" placeholder="1234567（住所を自動入力）" value="${esc(saved.zip)}"></label>
            <label>住所 <em>必須</em><textarea name="address" rows="2" autocomplete="street-address">${esc(saved.address)}</textarea></label>
            ${mc ? '<label class="check"><input type="checkbox" name="save_address" checked> この住所を会員情報に保存する</label>' : ''}
          </div>
          <label>備考<textarea name="note" rows="2" placeholder="ご要望があればご記入ください"></textarea></label>
        </fieldset>
        ${canPoints ? `
        <fieldset><legend>ポイント</legend>
          <p class="small">保有ポイント <b>${me.customer.points.toLocaleString()}pt</b>（1pt＝1円）${olines.length && !config.points.oripaUse ? '<br><span class="muted">※オリパ分には使えません</span>' : ''}</p>
          <div class="row pts"><input name="points" type="number" inputmode="numeric" min="0" placeholder="使うポイント" value=""><button type="button" class="btn sm" id="ptsall">すべて使う</button></div>
        </fieldset>` : ''}
        <fieldset id="payfs"><legend>お支払い方法</legend>
          ${config.cardEnabled ? `<label class="radio"><input type="radio" name="pay" value="card" checked> クレジットカード<span class="muted small">決済後すぐに発送準備に入ります（Stripeの安全な決済ページへ移動）</span></label>` : ''}
          ${config.bankEnabled ? `<label class="radio"><input type="radio" name="pay" value="bank" ${config.cardEnabled ? '' : 'checked'}> 銀行振込（前払い）<span class="muted small">ご注文から${config.paymentDays}日以内にお振込みください</span></label>` : ''}
        </fieldset>
        <div class="summary" id="sum"><p class="muted small">計算中…</p></div>
        ${olines.length ? `<label class="check agree"><input type="checkbox" name="oripa_agree"> <span>オリパの注意事項に同意します：${esc(config.oripa.notice)} ${esc(config.oripa.ageNotice)}</span></label>` : ''}
        <label class="check"><input type="checkbox" name="agree"> <span><a href="legal.html" target="_blank">特定商取引法に基づく表記・返品について</a>に同意します</span></label>
        <p id="err" class="danger" hidden></p>
        <button class="btn primary block" id="submit">注文を確定する</button>
        <p class="muted small center">シングルカードは一点ものが多いため、注文確定の時点で在庫を確保します。</p>
      </form>`;
    const f = $('#f');
    const draw = debounce(async () => {
      $('#addr').hidden = pickup;
      try {
        const q = await getQuote({ points_use: pointsUse, shipping_method: pickup ? 'pickup' : 'delivery' });
        // 入力中は欄を書き換えない（1桁目で「最低利用ポイント未満→0」に戻されて打てなくなるため）
        if (f.points && q.points_use !== pointsUse && pointsUse) { pointsUse = q.points_use; if (document.activeElement !== f.points) f.points.value = pointsUse || ''; }
        $('#sum').innerHTML = summaryHtml(q, { lines: itemLines, pickup });
        $('#payfs').hidden = q.total === 0;
        f._quote = q;
      } catch (e) { $('#sum').innerHTML = `<p class="danger small">${esc(e.message)}</p>`; }
    }, 200);
    draw();
    $$('[name=ship]').forEach(r => r.onchange = () => { pickup = f.ship.value === 'pickup'; draw(); });
    if (f.points) {
      f.points.oninput = () => { pointsUse = Math.max(0, Math.min(+f.points.value || 0, me.customer.points)); draw(); };
      f.points.onblur = () => draw();
      $('#ptsall').onclick = async () => { const q = await getQuote({ points_use: me.customer.points, shipping_method: pickup ? 'pickup' : 'delivery' }); pointsUse = q.points_use; f.points.value = pointsUse || ''; draw(); };
    }
    f.zip.addEventListener('input', async () => {
      const z = f.zip.value.normalize('NFKC').replace(/[^0-9]/g, '');
      if (z.length !== 7 || f.address.value.trim()) return;
      try {
        const r = await fetch('https://zipcloud.ibsnet.co.jp/api/search?zipcode=' + z).then(r => r.json());
        const a = r.results?.[0];
        if (a && !f.address.value.trim()) { f.address.value = a.address1 + a.address2 + a.address3; f.address.focus(); }
      } catch {}
    });
    f.onsubmit = async e => {
      e.preventDefault();
      const err = $('#err'); err.hidden = true;
      const fd = Object.fromEntries(new FormData(f));
      const fail = m => { err.textContent = m; err.hidden = false; };
      if (!fd.name || !fd.email || !fd.phone || (!pickup && (!fd.zip || !fd.address))) return fail('必須項目を入力してください');
      if (olines.length && !fd.oripa_agree) return fail('オリパの注意事項への同意が必要です');
      if (!fd.agree) return fail('特定商取引法に基づく表記への同意が必要です');
      const customer = { name: fd.name, kana: fd.kana, email: fd.email, phone: fd.phone, zip: fd.zip, address: fd.address, note: fd.note };
      store.set('pk_customer', { ...customer, note: '', ship: pickup ? 'pickup' : 'delivery' });
      const btn = $('#submit'); btn.disabled = true; btn.textContent = '送信中…';
      try {
        const res = await api('/api/orders', {
          method: 'POST',
          body: JSON.stringify({ customer, payment_method: fd.pay || 'bank', shipping_method: pickup ? 'pickup' : 'delivery', coupon_code: coupon?.code || '', points_use: pointsUse, oripa_agree: !!fd.oripa_agree, save_address: !!fd.save_address, items: cart.payload() }),
        });
        const hist = store.get('pk_orders', []);
        hist.unshift({ no: res.order_no, t: res.token, at: Date.now(), total: res.total });
        store.set('pk_orders', hist.slice(0, 30));
        cart.clear(); coupon = null; store.set('pk_coupon', null);
        products = null; oripas = null; me = null;
        if (res.checkout_url) location.href = res.checkout_url;
        else location.hash = `#/order/${res.order_no}?t=${res.token}&new=1`;
      } catch (ex) {
        fail(ex.message);
        btn.disabled = false; btn.textContent = '注文を確定する';
        if (ex.status === 401) { setToken(null); }
        if (ex.data?.failed || ex.data?.failed_oripa) { await loadBase(true); await loadOripas(true); toast('在庫が変わりました。カートを確認してください'); location.hash = '#/cart'; }
      }
    };
  }

  // ─── 注文確認・開封 ───
  function drawCard(d, i) {
    return `<div class="dcard ${d.is_last_one ? 'lo' : ''}" style="--i:${i}"><div class="dc-in">
      <div class="dc-back">${esc(config.logoText || 'PK')}</div>
      <div class="dc-front">${d.image_url ? `<img src="${esc(d.image_url)}" alt="">` : '<div class="noimg sm"></div>'}<span class="tag rank ${d.is_last_one ? 'lo' : ''}">${esc(d.is_last_one ? 'ラストワン' : d.rank)}</span><b>${esc(d.name)}</b></div>
    </div></div>`;
  }
  async function viewOrder(no, tk, isNew) {
    app.innerHTML = '<p class="muted center pad">読み込み中…</p>';
    if (token && F_ON.members) refreshMe();
    let o;
    try { o = await api(`/api/orders/${encodeURIComponent(no)}?t=${encodeURIComponent(tk)}`); }
    catch (e) {
      if (e.status === 404) store.set('pk_orders', store.get('pk_orders', []).filter(h => h.no !== no)); // 削除された注文は履歴からも外す
      app.innerHTML = `<p class="pad center">${esc(e.message)}<br><a class="btn" href="#/orders">ご注文履歴へ</a></p>`; return;
    }
    const digits = o.order_no.replace('PK', '');
    const pickup = o.shipping_method === 'pickup';
    const payLabel = { card: '決済完了', points: 'ポイント払い完了', bank: '入金確認' }[o.payment_method];
    const steps = o.kind === 'coin' ? [['ご注文', true], [`${config.coin.name}付与`, o.status === 'shipped']]
      : o.kind === 'ship' ? [['発送依頼', true], [pickup ? '受取準備完了' : '発送済み', o.status === 'shipped']]
      : [['ご注文', true], [payLabel, ['paid', 'shipped'].includes(o.status)], [pickup ? '受取準備完了' : '発送済み', o.status === 'shipped']];
    const unrevealed = o.can_open && o.draws.some(d => !d.revealed_at);
    const byOripa = {};
    o.draws.forEach(d => (byOripa[d.title] ||= []).push(d));
    app.innerHTML = `
      ${o.kind === 'coin' && o.status === 'shipped' ? `<div class="thanks"><h1>${esc(config.coin.name)} ${o.coins.toLocaleString()} を付与しました</h1><p><a class="btn primary" href="#/oripa">オリパを引く</a></p></div>` : ''}
      ${isNew && o.kind !== 'ship' ? '<div class="thanks"><h1>ご注文ありがとうございます</h1><p>このページをブックマークしておくと、あとでご注文状況を確認できます。</p></div>' : '<h1 class="h">ご注文状況</h1>'}
      ${['cancelled', 'expired'].includes(o.status) ? `<div class="ordercard"><b class="danger">このご注文は${esc(o.status_label)}になりました。</b></div>` : `
      <ol class="steps">${steps.map(([l, done], i) => `<li class="${done ? 'done' : (steps[i - 1]?.[1]) ? 'cur' : ''}">${l}</li>`).join('')}</ol>`}
      ${o.draws.length ? `
        <div class="box oripa-open">
          <h3>${o.kind === 'ship' ? `${pickup ? 'お受け取り' : '発送'}する当選カード（${o.draws.length}枚）` : `オリパ（${o.draws.filter(d => !d.is_last_one).length}口${o.draws.some(d => d.is_last_one) ? '＋ラストワン賞' : ''}）`}</h3>
          ${!o.can_open ? `<p class="small">${['cancelled', 'expired'].includes(o.status) ? 'キャンセルされたため開封できません。' : 'ご入金確認後に開封できます。お支払いが済むとこのページに「開封する」ボタンが表示されます。'}</p>` :
            unrevealed ? `<button class="btn primary block" id="reveal">開封する</button>` :
            `<div class="draws">${Object.entries(byOripa).map(([t, ds]) => `<p class="small muted">${esc(t)}</p>${ds.map((d, i) => drawCard(d, i)).join('')}`).join('')}</div>
             <p class="small muted">${o.kind === 'ship' ? (o.status === 'shipped' ? (pickup ? '準備ができています。' : '発送しました。') : '準備ができ次第、発送のご連絡をします。') : `当選したカードは${pickup ? '店頭でお渡し' : '他の商品と一緒に発送'}します。`}</p>`}
        </div>` : ''}
      <div class="ordercard">
        <div class="row-between"><span>注文番号</span><strong class="mono">${esc(o.order_no)}</strong></div>
        <div class="row-between"><span>状況</span><span class="status s-${esc(o.status)}">${esc(o.status_label)}</span></div>
        <div class="row-between"><span>ご注文日時</span><span>${jst(o.created_at)}</span></div>
        ${o.tracking_no ? `<div class="row-between"><span>${esc(o.carrier_label || '追跡番号')}</span>${o.tracking_url ? `<a class="mono" href="${esc(o.tracking_url)}" target="_blank" rel="noopener">${esc(o.tracking_no)}（配送状況を見る）</a>` : `<strong class="mono">${esc(o.tracking_no)}</strong>`}</div>` : ''}
        ${o.points_earn ? `<div class="row-between"><span>獲得ポイント</span><span>${o.points_earn}pt ${o.points_granted ? '<span class="ok small">付与済み</span>' : `<span class="muted small">${config.points.grantOn === 'paid' ? '入金確認時' : '発送時'}に付与</span>`}</span></div>` : ''}
      </div>
      ${o.bank_info ? `
        <div class="bankbox">
          <h2>お振込のご案内</h2>
          <p class="amount">お振込金額 <strong>${yen(o.total)}</strong> <button class="link" data-copy="${o.total}">金額をコピー</button></p>
          <pre class="bank">${esc(o.bank_info.trim())}</pre>
          <p><strong>振込名義の前に「${esc(digits)}」を入れてください</strong> <button class="link" data-copy="${esc(digits)}">番号をコピー</button><br><span class="muted small">例）${esc(digits)} ヤマダタロウ</span></p>
          <p class="small">お支払い期限：<strong>${jst(o.expires_at)}</strong> まで<br><span class="muted">期限を過ぎると自動でキャンセルになります。振込手数料はお客様のご負担となります。</span></p>
        </div>` : ''}
      ${pickup && o.pickup_info ? `<div class="box"><h3>店頭受け取り</h3><p class="small">${esc(o.pickup_info)}</p><p class="small muted">${o.status === 'shipped' ? '準備ができています。ご来店をお待ちしております。' : '準備ができ次第メールでお知らせします。'}注文番号をお伝えください。</p></div>` : ''}
      ${o.kind === 'ship' ? (o.coins ? `<p class="small muted">発送料：${o.coins.toLocaleString()}${esc(config.coin.name)}（お支払い済み）</p>` : '') : `<div class="summary">
        ${summaryHtml({ subtotal: o.subtotal, discount: o.discount, coupon: { code: o.coupon_code }, points_use: o.points_used, shipping: o.shipping_fee, total: o.total }, {
          pickup, lines: o.items.map(i => `<div class="small"><span>${i.oripa_id ? `オリパ「${esc(i.name)}」× ${i.qty}口` : `${esc(i.name)} ${esc(i.condition)} × ${i.qty}`}</span><span>${yen(i.price * i.qty)}</span></div>`).join('') })}
      </div>`}
      ${pickup || o.kind === 'coin' ? '' : `<p class="small muted">お届け先：〒${esc(o.zip)} ${esc(o.address)} ${esc(o.name)} 様</p>`}
      <a class="btn" href="#/">ショップトップへ</a>`;
    $$('[data-copy]').forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copy); toast('コピーしました'); } catch { toast(b.dataset.copy); } });
    const rv = $('#reveal');
    if (rv) rv.onclick = async () => {
      rv.disabled = true;
      try {
        const r = await api(`/api/orders/${encodeURIComponent(no)}/reveal?t=${encodeURIComponent(tk)}`, { method: 'POST' });
        const box = $('.oripa-open');
        const shown = r.draws.filter(d => !d.hidden);
        window.PKOpening.play(shown, { title: 'オリパ開封', logo: config.logoText || 'PK', shop: config.shopName, actions: [{ key: 'close', label: '結果を閉じる', primary: true }] });
        box.innerHTML = `<h3>開封結果</h3><div class="draws opening">${shown.map((d, i) => drawCard(d, i)).join('')}</div>
          <p class="small muted">当選したカードは${pickup ? '店頭でお渡し' : '他の商品と一緒に発送'}します。</p>`;
        $$('.dcard', box).forEach(c => c.classList.add('flip'));
      } catch (e) { toast(e.message); rv.disabled = false; }
    };
  }

  function viewOrders() {
    const hist = store.get('pk_orders', []);
    app.innerHTML = `<h1 class="h">ご注文履歴</h1>
      ${me ? '<p class="small"><a href="#/account">マイページ</a>で会員としてのご注文をすべて確認できます。</p>' : '<p class="muted small">このブラウザでご注文いただいた履歴です。</p>'}
      <div class="lines">${hist.map(h => `<a class="line plain" href="#/order/${esc(h.no)}?t=${esc(h.t)}"><div class="linfo"><b class="mono">${esc(h.no)}</b><span class="muted small">${new Date(h.at).toLocaleString('ja-JP')}</span></div><span>${h.total !== undefined ? yen(h.total) : ''} ›</span></a>`).join('') || '<p class="muted pad center">まだご注文はありません</p>'}</div>`;
  }

  // ─── 会員 ───
  async function viewAccount(params) {
    if (!F_ON.members) { location.hash = '#/'; return; }
    const next = params.get('next');
    if (!token) {
      const mode = params.get('mode') || 'login';
      app.innerHTML = `
        <div class="auth">
          <div class="seg big"><label><input type="radio" name="m" value="login" ${mode === 'login' ? 'checked' : ''}><span>ログイン</span></label><label><input type="radio" name="m" value="register" ${mode === 'register' ? 'checked' : ''}><span>新規会員登録</span></label></div>
          ${mode === 'login' ? `
            <form class="form" id="af">
              <fieldset><label>メールアドレス<input name="email" type="email" autocomplete="email" required></label>
              <label>パスワード<input name="password" type="password" autocomplete="current-password" required></label>
              <p id="aerr" class="danger small" hidden></p>
              <button class="btn primary block">ログイン</button>
              <a class="link center" href="#/forgot">パスワードを忘れた方</a></fieldset>
            </form>` : `
            <div class="perks">${F_ON.points ? `<div><b>${config.points.signupBonus}pt</b><span>登録ボーナス</span></div><div><b>${config.points.rate}%</b><span>ポイント還元</span></div>` : ''}<div><b>かんたん</b><span>住所の自動入力</span></div><div><b>履歴</b><span>注文をまとめて確認</span></div></div>
            <form class="form" id="af">
              <fieldset><label>お名前<input name="name" autocomplete="name" required></label>
              <label>メールアドレス<input name="email" type="email" autocomplete="email" required></label>
              <label>パスワード（8文字以上）<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
              <p id="aerr" class="danger small" hidden></p>
              <button class="btn primary block">登録する</button>
              <p class="muted small">登録すると<a href="legal.html#privacy" target="_blank">プライバシーポリシー</a>に同意したものとみなします。</p></fieldset>
            </form>`}
        </div>`;
      $$('[name=m]').forEach(r => r.onchange = () => { location.hash = `#/account?mode=${r.value}${next ? '&next=' + next : ''}`; });
      $('#af').onsubmit = async e => {
        e.preventDefault();
        const fd = Object.fromEntries(new FormData(e.target));
        try {
          const r = await api(mode === 'login' ? '/api/auth/login' : '/api/auth/register', { method: 'POST', body: JSON.stringify(fd) });
          setToken(r.token); await refreshMe();
          toast(mode === 'login' ? 'ログインしました' : r.verify_sent ? '登録しました。確認メールのリンクを開いてください' : r.phone_required ? '登録しました。マイページで電話番号を認証してください' : `登録しました${F_ON.points && config.points.signupBonus ? `（${config.points.signupBonus}pt プレゼント）` : ''}`);
          location.hash = next ? `#/${next}` : '#/account';
        } catch (err) { const a = $('#aerr'); a.textContent = err.message; a.hidden = false; }
      };
      return;
    }
    await refreshMe();
    if (!me) return viewAccount(params);
    const c = me.customer;
    app.innerHTML = `
      <h1 class="h">マイページ</h1>
      ${!c.email_verified && config.mailEnabled ? `<div class="loginhint"><b>メールアドレスの確認がまだです。</b>${c.email} に届いたリンクを開いてください。${F_ON.points && config.points.signupBonus ? `確認すると登録ボーナス${config.points.signupBonus}ptが付きます。` : ''} <button class="link" id="resend">確認メールを再送</button></div>` : ''}
      ${config.phoneEnabled ? (c.phone_verified ? `<p class="small ok">電話番号は認証済みです（${esc(c.phone_verified_number)}）</p>` : `
        <div class="box" id="phonebox"><h3>電話番号認証（SMS）</h3>
          <p class="small">${[config.phone.forBonus && F_ON.points && config.points.signupBonus ? `登録ボーナス${config.points.signupBonus}ptの受け取り` : '', config.phone.forOripa && F_ON.oripa ? 'オリパのご購入' : ''].filter(Boolean).join('・') || '安心してお取引いただくため'}に、携帯電話番号の認証をお願いしています。1つの番号は1アカウントでのみ使えます。</p>
          <div class="row pts"><input id="ph" type="tel" inputmode="tel" placeholder="090-1234-5678" value="${esc(c.phone)}"><button class="btn sm primary" id="phsend">SMSを送る</button></div>
          <div class="row pts" id="phcode" hidden><input id="phc" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="届いた6桁のコード"><button class="btn sm primary" id="phok">認証する</button></div>
          <p class="small danger" id="pherr" hidden></p>
        </div>`) : ''}
      ${F_ON.coins ? `<div class="mylinks"><a class="btn" href="#/coins">${esc(config.coin.name)}の購入・残高</a><a class="btn" href="#/box">獲得カード（発送依頼）</a></div>` : ''}
      ${F_ON.points ? `
      <div class="pointcard">
        <span class="small">保有ポイント</span><b>${c.points.toLocaleString()}<small>pt</small></b>
        <span class="small">1pt＝1円でお使いいただけます${me.points_expires_at ? `・有効期限 ${jst(me.points_expires_at, { year: 'numeric', month: 'numeric', day: 'numeric' })}` : ''}</span>
      </div>` : ''}
      <div class="box"><h3>ご注文履歴</h3>
        <div class="lines">${me.orders.map(o => `<a class="line plain" href="#/order/${esc(o.order_no)}?t=${esc(o.token)}"><div class="linfo"><b class="mono">${esc(o.order_no)}</b><span class="muted small">${jst(o.created_at)}</span></div><span><span class="status s-${esc(o.status)}">${esc({ awaiting_payment: '入金待ち', paid: '入金済み', shipped: '発送済み', cancelled: 'キャンセル', expired: '期限切れ' }[o.status])}</span> ${yen(o.total)} ›</span></a>`).join('') || '<p class="muted small">まだご注文はありません</p>'}</div>
      </div>
      ${F_ON.points ? `<details class="box"><summary><b>ポイント履歴</b></summary>
        <table class="sib">${me.ledger.map(l => `<tr><td class="small">${jst(l.created_at)}</td><td class="small">${esc(l.reason)}</td><td class="${l.delta > 0 ? 'ok' : 'danger'}">${l.delta > 0 ? '+' : ''}${l.delta}</td></tr>`).join('') || '<tr><td class="muted">履歴はありません</td></tr>'}</table></details>` : ''}
      <details class="box"><summary><b>会員情報・お届け先</b></summary>
        <form class="form" id="pf" style="margin-top:10px">
          <label>お名前<input name="name" value="${esc(c.name)}" required></label>
          <label>フリガナ<input name="kana" value="${esc(c.kana)}"></label>
          <label>メールアドレス<input value="${esc(c.email)}" disabled></label>
          <label>電話番号<input name="phone" type="tel" value="${esc(c.phone)}"></label>
          <label>郵便番号<input name="zip" inputmode="numeric" value="${esc(c.zip)}"></label>
          <label>住所<textarea name="address" rows="2">${esc(c.address)}</textarea></label>
          <button class="btn primary">保存</button>
        </form></details>
      <details class="box"><summary><b>パスワードの変更</b></summary>
        <form class="form" id="pw" style="margin-top:10px">
          <label>現在のパスワード<input name="current_password" type="password" autocomplete="current-password" required></label>
          <label>新しいパスワード（8文字以上）<input name="new_password" type="password" autocomplete="new-password" minlength="8" required></label>
          <button class="btn primary">変更</button>
        </form></details>
      <div class="row-between"><button class="btn" id="logout">ログアウト</button><button class="link muted" id="withdraw">退会する</button></div>`;
    const phs = $('#phsend');
    if (phs) {
      const perr = m => { const e = $('#pherr'); e.textContent = m; e.hidden = !m; };
      phs.onclick = async () => {
        perr(''); phs.disabled = true;
        try { await api('/api/me/phone/send', { method: 'POST', body: JSON.stringify({ phone: $('#ph').value }) }); $('#phcode').hidden = false; $('#phc').focus(); toast('SMSを送りました'); phs.textContent = '再送する'; }
        catch (err) { perr(err.message); }
        setTimeout(() => (phs.disabled = false), 30000);
      };
      $('#phok').onclick = async () => {
        perr('');
        try {
          const r = await api('/api/me/phone/verify', { method: 'POST', body: JSON.stringify({ phone: $('#ph').value, code: $('#phc').value }) });
          toast(r.bonus ? `認証しました（${r.bonus}pt プレゼント）` : '電話番号を認証しました');
          if (params.get('next') === 'checkout') { await refreshMe(); location.hash = '#/checkout'; } else viewAccount(params);
        } catch (err) { perr(err.message); }
      };
    }
    const rsd = $('#resend'); if (rsd) rsd.onclick = async () => { try { await api('/api/auth/verify-resend', { method: 'POST' }); toast('確認メールを送りました'); } catch (err) { toast(err.message); } };
    $('#pf').onsubmit = async e => { e.preventDefault(); try { await api('/api/me', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); toast('保存しました'); await refreshMe(); } catch (err) { toast(err.message); } };
    $('#pw').onsubmit = async e => { e.preventDefault(); try { await api('/api/me', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); toast('パスワードを変更しました'); e.target.reset(); } catch (err) { toast(err.message); } };
    $('#logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); setToken(null); toast('ログアウトしました'); location.hash = '#/'; };
    $('#withdraw').onclick = async () => {
      if (!confirm(`退会すると${F_ON.points ? `保有ポイント（${c.points}pt）と` : ''}会員情報が削除され、元に戻せません。退会しますか？`)) return;
      try { await api('/api/me', { method: 'DELETE' }); setToken(null); toast('退会しました'); location.hash = '#/'; } catch (err) { toast(err.message); }
    };
  }

  async function viewVerify(params) {
    app.innerHTML = '<p class="muted center pad">確認中…</p>';
    try {
      const r = await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ token: params.get('token') }) });
      await refreshMe();
      app.innerHTML = `<div class="auth box center"><h1 class="h">メールアドレスを確認しました</h1>${r.bonus ? `<p>登録ボーナス <b>${r.bonus}ポイント</b> をお付けしました。</p>` : ''}<a class="btn primary" href="#/">お買い物を始める</a></div>`;
    } catch (e) { app.innerHTML = `<div class="auth box center"><p>${esc(e.message)}</p><a class="btn" href="#/account">マイページへ</a></div>`; }
  }

  function viewForgot() {
    app.innerHTML = `<div class="auth"><h1 class="h">パスワードの再設定</h1>
      ${config.mailEnabled ? `<form class="form" id="ff"><fieldset><label>登録したメールアドレス<input name="email" type="email" required></label><button class="btn primary block">再設定メールを送る</button></fieldset></form>`
        : '<p class="small">お手数ですが、お店までお問い合わせください。</p>'}</div>`;
    const ff = $('#ff');
    if (ff) ff.onsubmit = async e => { e.preventDefault(); await api('/api/auth/reset-request', { method: 'POST', body: JSON.stringify({ email: ff.email.value }) }).catch(() => {}); ff.innerHTML = '<p>ご登録があれば、再設定用のメールをお送りしました。1時間以内にリンクを開いてください。</p>'; };
  }
  function viewReset(params) {
    app.innerHTML = `<div class="auth"><h1 class="h">新しいパスワード</h1><form class="form" id="rf"><fieldset><label>新しいパスワード（8文字以上）<input name="password" type="password" minlength="8" autocomplete="new-password" required></label><p id="aerr" class="danger small" hidden></p><button class="btn primary block">設定してログイン</button></fieldset></form></div>`;
    $('#rf').onsubmit = async e => {
      e.preventDefault();
      try { const r = await api('/api/auth/reset', { method: 'POST', body: JSON.stringify({ token: params.get('token'), password: e.target.password.value }) }); setToken(r.token); await refreshMe(); toast('パスワードを再設定しました'); location.hash = '#/account'; }
      catch (err) { const a = $('#aerr'); a.textContent = err.message; a.hidden = false; }
    };
  }

  // ─── お気に入り ───
  function viewFav() {
    const list = Object.keys(fav.items).map(id => byId.get(+id)).filter(Boolean);
    const gone = Object.keys(fav.items).filter(id => !byId.has(+id)).length;
    app.innerHTML = `<h1 class="h">お気に入り <span class="muted small">${list.length}件</span></h1>
      <p class="muted small">登録時より値下がりした商品にはお知らせを表示します。ログイン不要・このブラウザに保存されます。</p>
      <div class="grid">${list.map(p => pcard(p)).join('') || '<p class="muted pad">商品ページの ♥ でお気に入りに追加できます</p>'}</div>
      ${gone ? `<p class="muted small">販売終了した商品が${gone}件あります。</p>` : ''}`;
    bindCards();
  }

  // ─── デッキリスト一括購入 ───
  const SECTION_RE = /^(ポケモン|グッズ|ポケモンのどうぐ|サポート|スタジアム|エネルギー|トレーナーズ|pokemon|trainer|energy)\s*[:：(（]?\s*\d*\s*[)）]?\s*$/i;
  function parseDeck(text) {
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.normalize('NFKC').trim(), qty = 1, m;
      if (!line || SECTION_RE.test(line) || /^(合計|total)/i.test(line)) continue;
      if ((m = line.match(/^(\d{1,2})\s*[x×*枚]?\s+(.+)$/))) { qty = +m[1]; line = m[2]; }
      else if ((m = line.match(/^(.+?)\s*[x×*]\s*(\d{1,2})\s*枚?$/))) { line = m[1]; qty = +m[2]; }
      else if ((m = line.match(/^(.+?)\s+(\d{1,2})\s*枚$/))) { line = m[1]; qty = +m[2]; }
      const no = (line.match(/(\d{1,3}\/\d{1,3})/) || [])[1] || '';
      const name = line.replace(/(\d{1,3}\/\d{1,3})/, '').replace(/[\[［【(（][^\]］】)）]*[\]］】)）]/g, '').replace(/\s+[A-Za-z]{1,4}\d{0,2}[a-z]?\s*$/, '').trim();
      if (name || no) out.push({ raw: raw.trim(), qty: Math.min(qty, 60), name, no });
    }
    return out;
  }
  function matchDeck(rows, pref) {
    return rows.map(r => {
      const pool = products.filter(p => p.stock > 0 && p.category === 'single');
      let cands = r.no ? pool.filter(p => p.card_no === r.no && (!r.name || norm(p.name).includes(norm(r.name)) || norm(r.name).includes(norm(p.name)))) : [];
      if (!cands.length && r.no) cands = pool.filter(p => p.card_no === r.no);
      let fuzzy = false;
      if (!cands.length && r.name) cands = pool.filter(p => norm(p.name) === norm(r.name));
      if (!cands.length && r.name) { cands = pool.filter(p => norm(p.name).startsWith(norm(r.name))); fuzzy = cands.length > 0; }
      if (!cands.length && r.name && norm(r.name).length >= 2) { cands = pool.filter(p => norm(p.name).includes(norm(r.name))); fuzzy = cands.length > 0; }
      const sorted = [...cands].sort(pref === 'best' ? (a, b) => condRank(a.condition) - condRank(b.condition) || a.price - b.price : (a, b) => a.price - b.price);
      let need = r.qty; const picks = [];
      for (const p of sorted) {
        if (need <= 0) break;
        const inCart = cart.items[p.id] || 0;
        const can = Math.min(p.stock - inCart, config.maxQtyPerItem - inCart, need);
        if (can > 0) { picks.push({ p, qty: can }); need -= can; }
      }
      return { ...r, picks, short: need, fuzzy, found: cands.length > 0 };
    });
  }
  function viewDeck() {
    if (!F_ON.deck) { location.hash = '#/'; return; }
    const draft = store.get('pk_deck', '');
    app.innerHTML = `
      <h1 class="h">デッキリストで一括購入</h1>
      <p class="small">デッキレシピをそのまま貼り付けると、在庫からカードを探してまとめてカートに入れます。<br><span class="muted">書き方の例：「4 ナンジャモ」「ナンジャモ ×4」「リザードンex 223/165 2枚」</span></p>
      <form id="df" class="form">
        <textarea name="list" rows="10" placeholder="4 ナンジャモ&#10;2 リザードンex 223/165&#10;ボスの指令 ×2&#10;ふしぎなアメ 4枚">${esc(draft)}</textarea>
        <div class="seg"><label><input type="radio" name="pref" value="cheap" checked><span>とにかく安く</span></label><label><input type="radio" name="pref" value="best"><span>状態の良い順</span></label></div>
        <button class="btn primary block">在庫を探す</button>
      </form>
      <div id="dres"></div>`;
    const df = $('#df');
    df.onsubmit = e => {
      e.preventDefault();
      store.set('pk_deck', df.list.value);
      const rows = parseDeck(df.list.value);
      if (!rows.length) { toast('カード名を入力してください'); return; }
      const res = matchDeck(rows, df.pref.value);
      const total = res.reduce((s, r) => s + r.picks.reduce((a, x) => a + x.p.price * x.qty, 0), 0);
      const okCount = res.filter(r => r.short === 0).length;
      const cardsTotal = res.reduce((s, r) => s + r.qty, 0);
      const gotCards = res.reduce((s, r) => s + r.qty - r.short, 0);
      $('#dres').innerHTML = `
        <div class="deckhead"><span><b>${cardsTotal}枚中 ${gotCards}枚</b>が見つかりました<br><span class="small">${okCount}/${res.length}種類そろいます</span></span><span class="price">${yen(total)}</span></div>
        <div class="dlist">
          ${res.map((r, i) => `
            <div class="drow ${r.short === 0 ? 'ok' : r.picks.length ? 'part' : 'ng'}">
              <div class="dreq"><b>${esc(r.name || r.no)}</b> ${r.no && r.name ? `<span class="muted small">${esc(r.no)}</span>` : ''} × ${r.qty}${r.fuzzy ? ' <span class="tag">近い候補</span>' : ''}</div>
              ${r.picks.map(x => `<label class="dpick"><input type="checkbox" data-pick="${i}" data-id="${x.p.id}" data-qty="${x.qty}" checked><span>${esc(x.p.name)} ${condBadge(x.p.condition)} ${esc(x.p.card_no)}</span><span>${x.p.price >= 3000 ? '<span class="tag hi">高額</span> ' : ''}${yen(x.p.price)} × ${x.qty}</span></label>`).join('')}
              ${r.short ? `<div class="small ${r.picks.length ? '' : 'danger'}">${r.found ? `在庫不足：あと${r.short}枚` : '在庫が見つかりませんでした'} <a class="link" href="#/" data-search="${esc(r.name || r.no)}">検索する</a></div>` : ''}
            </div>`).join('')}
        </div>
        <button class="btn primary block" id="dadd">チェックした${res.reduce((s, r) => s + r.picks.length, 0)}商品をカートに入れる</button>`;
      $$('[data-search]').forEach(a => a.onclick = e => { e.preventDefault(); F = { ...defaultFilter(), q: a.dataset.search, inStock: false }; location.hash = '#/'; });
      $('#dadd').onclick = () => {
        let n = 0;
        $$('[data-pick]:checked').forEach(c => { if (cart.add(+c.dataset.id, +c.dataset.qty, true)) n += +c.dataset.qty; });
        toast(`${n}枚をカートに入れました`);
        location.hash = '#/cart';
      };
    };
    if (draft) df.requestSubmit();
  }

  function viewGuide() {
    app.innerHTML = `
      <h1 class="h">ご利用ガイド</h1>
      ${config.condGuide.length ? `<div class="box"><h3>状態表記</h3>${config.condGuide.map(([k, v]) => `<p>${condBadge(k)} ${esc(v)}</p>`).join('')}<p class="small muted">「実物写真」マークの商品は、お届けするカードそのものを撮影しています。</p></div>` : ''}
      <div class="box"><h3>発送について</h3><p class="small">${config.shipDays.map(d => '日月火水木金土'[d]).join('・')}曜日に発送しています。${config.shipCutoffHour}時までのカード決済・ご入金確認分は当日発送します。<br>送料${yen(config.shippingFee)}、${yen(config.freeShippingOver)}以上のご注文で送料無料。カードはスリーブ＋硬質ケースに入れ、防水して発送します。${config.pickupEnabled ? '<br>店頭受け取り（送料無料）もお選びいただけます。' : ''}</p></div>
      ${F_ON.points ? `<div class="box"><h3>ポイント</h3><p class="small">会員登録で${config.points.signupBonus}ポイント、お買い物金額の${config.points.rate}%をポイント還元（${config.points.grantOn === 'paid' ? '入金確認時' : '発送時'}に付与）。1ポイント＝1円としてお使いいただけます。${config.points.expireDays ? `最後にポイントが増減した日から${config.points.expireDays}日で失効します。` : ''}${config.points.oripaEarn ? '' : '<br>オリパのご購入分はポイント付与の対象外です。'}</p></div>` : ''}
      ${F_ON.oripa ? `<div class="box"><h3>オリパ</h3><p class="small">${esc(config.oripa.notice)}<br>総口数・賞ごとの封入数と、全体の残り口数を公開しています。抽選は注文時にサーバーで行い、ご入金確認後に開封できます。<br>${esc(config.oripa.ageNotice)}</p></div>` : ''}`;
  }

  // ─── ルーター ───
  let lastPath = '';
  async function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = h.split('?');
    if (path !== lastPath) window.scrollTo(0, 0);
    lastPath = path;
    const params = new URLSearchParams(qs || '');
    try {
      const mo = path.match(/^\/order\/(PK\d{6})$/);
      if (mo) { if (!config) { config = await api('/api/config'); applyConfig(); } renderShipbar(); return viewOrder(mo[1], params.get('t'), params.get('new') === '1'); }
      await loadBase(!products);
      renderShipbar();
      const mp = path.match(/^\/p\/(\d+)$/);
      if (mp) return viewProduct(+mp[1]);
      const mor = path.match(/^\/oripa\/(\d+)$/);
      if (mor) return viewOripa(+mor[1]);
      if (path === '/oripa') return viewOripaList();
      if (path === '/coins') return viewCoins();
      if (path === '/box') return viewBox();
      if (path === '/cart') return viewCart();
      if (path === '/checkout') return viewCheckout();
      if (path === '/fav') return viewFav();
      if (path === '/deck') return viewDeck();
      if (path === '/orders') return viewOrders();
      if (path === '/guide') return viewGuide();
      if (path === '/account') return viewAccount(params);
      if (path === '/forgot') return viewForgot();
      if (path === '/reset') return viewReset(params);
      if (path === '/verify') return viewVerify(params);
      return viewList();
    } catch (e) {
      console.error(e);
      app.innerHTML = `<div class="pad center"><p>読み込みに失敗しました</p><p class="muted small">${esc(e.message)}</p><button class="btn" id="reload">再読み込み</button></div>`;
      $('#reload').onclick = () => location.reload();
    }
  }
  window.addEventListener('hashchange', route);
  updateBadges();
  route();
})();
