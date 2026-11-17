// PKlabo 管理画面
(() => {
  const API = window.PKLABO.API_BASE.replace(/\/$/, '');
  const app = document.getElementById('app');
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = n => '¥' + Number(n).toLocaleString('ja-JP');
  const jst = (utc, o = { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) => utc ? new Date(utc.replace(' ', 'T') + 'Z').toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', ...o }) : '';
  const toLocalInput = utc => utc ? new Date(new Date(utc.replace(' ', 'T') + 'Z').getTime() + 9 * 3600e3).toISOString().slice(0, 16) : '';
  const fromLocalInput = v => v ? new Date(v + ':00+09:00').toISOString() : '';
  const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/[\s・　]/g, '');
  const gkey = p => p.group_key || `${norm(p.name)}|${norm(p.card_no)}`;
  const STATUS = { awaiting_payment: '入金待ち', paid: '発送待ち', shipped: '発送済み', cancelled: 'キャンセル', expired: '期限切れ' };
  const CARRIERS = { japanpost: '日本郵便', yamato: 'ヤマト運輸', sagawa: '佐川急便' };
  const FIELDS = ['name', 'set_name', 'card_no', 'rarity', 'condition', 'category', 'price', 'compare_price', 'buy_price', 'stock', 'image_url', 'images', 'real_photo', 'description', 'active', 'sort', 'group_key'];
  // CSV の列（日本語見出し ⇔ 項目）
  const CSV_COLS = [['id', 'ID'], ['name', '商品名'], ['condition', '状態'], ['price', '価格'], ['stock', '在庫'], ['card_no', '型番'], ['set_name', '弾'], ['rarity', 'レアリティ'], ['category', 'カテゴリ'],
    ['compare_price', '値下げ前価格'], ['buy_price', '買取価格'], ['image_url', '画像URL'], ['images', '追加画像'], ['real_photo', '実物写真'], ['description', '説明'], ['active', '公開'], ['sort', '表示順'], ['group_key', 'グループ']];
  const HEAD_ALIAS = Object.fromEntries([...CSV_COLS.map(([k, l]) => [l, k]), ...CSV_COLS.map(([k]) => [k, k]),
    ['カード名', 'name'], ['セット', 'set_name'], ['販売価格', 'price'], ['通常価格', 'compare_price'], ['在庫数', 'stock'], ['商品ID', 'id']]);

  let key = sessionStorage.getItem('pk_admin_session') || ''; // 12時間で切れるセッション（管理キーそのものは保存しない）
  let tab = 'dash';
  let orderFilter = 'paid';
  let productQ = '';
  let productsCache = [];
  let ordersCache = [];
  let settings = null;

  function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2800); }
  async function api(path, opts = {}) {
    const isBlob = opts.body instanceof Blob;
    const res = await fetch(API + path, { ...opts, headers: { ...(isBlob ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'X-Admin-Session': key } : {}), ...(opts.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { logout(); throw new Error(data.error || '認証エラー'); }
    if (!res.ok) throw new Error(data.error || '通信エラー');
    return data;
  }
  function logout() { key = ''; sessionStorage.removeItem('pk_admin_session'); settings = null; $('#logout').hidden = true; render(); }
  $('#logout').onclick = async () => { await api('/api/admin/logout', { method: 'POST' }).catch(() => {}); logout(); };
  // Excel で開いたときに =… などが数式として実行されないように先頭に ' を付ける
  const csvSafe = v => { const s = String(v ?? ''); return /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" + s : s; };
  const csvCell = v => `"${csvSafe(v).replace(/"/g, '""')}"`;
  function download(name, rows) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' }));
    a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const catLabel = k => (settings?.categories || []).find(c => c.key === k)?.label || k;

  async function compress(file) {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => null);
    const img = bmp || await new Promise((ok, ng) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ng; i.src = URL.createObjectURL(file); });
    const r = Math.min(1, 1000 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    let blob = await new Promise(ok => c.toBlob(ok, 'image/webp', 0.82));
    if (!blob || blob.type !== 'image/webp') blob = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.85));
    return blob;
  }
  async function uploadFile(f) { const blob = await compress(f); return (await api('/api/admin/images', { method: 'POST', body: blob, headers: { 'Content-Type': blob.type } })).url; }

  async function viewLogin() {
    const info = await fetch(API + '/api/admin/auth-info').then(r => r.json()).catch(() => ({}));
    app.innerHTML = `
      <form id="login" class="form" style="max-width:380px;margin:40px auto">
        <fieldset><legend>管理画面にログイン</legend>
          ${info.ready === false ? '<p class="danger small">ADMIN_KEY が未設定か短すぎます（20文字以上）。README の手順で設定してください。</p>' : ''}
          <input type="password" name="k" placeholder="管理キー" autocomplete="current-password" required>
          ${info.totp ? '<input name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="認証アプリの6桁コード" required>' : '<p class="small muted">2段階認証は未設定です（あとから追加できます）。</p>'}
          <p id="lerr" class="danger small" hidden></p>
          <button class="btn primary block">ログイン</button>
          <p class="small muted">5回失敗すると15分間ロックされます。ログインは12時間で自動的に切れます。</p>
        </fieldset>
      </form>`;
    $('#login').onsubmit = async e => {
      e.preventDefault();
      try {
        const r = await fetch(API + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: e.target.k.value.trim(), otp: e.target.otp?.value || '' }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'ログインできませんでした');
        key = d.session; sessionStorage.setItem('pk_admin_session', key); render();
      } catch (err) { const l = $('#lerr'); l.textContent = err.message; l.hidden = false; }
    };
  }

  const TABS = [['dash', 'ダッシュボード'], ['orders', '注文'], ['products', '商品'], ['csv', 'CSV入出力'], ['oripa', 'オリパ'], ['members', '会員'], ['coupons', 'クーポン'], ['settings', '設定']];
  function shell(inner) {
    app.innerHTML = `
      <div class="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}
        <a class="btn sm" href="index.html" target="_blank" style="margin-left:auto;flex:none">ショップ ↗</a></div>
      <div id="body">${inner}</div>`;
    $$('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });
  }

  // ─── ダッシュボード ───
  async function viewDash() {
    shell('<p class="muted">読み込み中…</p>');
    const s = await api('/api/admin/stats');
    const days = [];
    for (let i = 29; i >= 0; i--) days.push(new Date(Date.now() + 9 * 3600e3 - i * 864e5).toISOString().slice(0, 10));
    const map = Object.fromEntries(s.daily.map(d => [d.d, d]));
    const max = Math.max(1, ...s.daily.map(d => d.sales));
    $('#body').innerHTML = `
      <div class="stats">
        <div class="stat"><span class="sub2">今日（24時間）</span><b>${yen(s.today.sales)}</b><span class="sub2">${s.today.orders}件</span></div>
        <div class="stat"><span class="sub2">7日間</span><b>${yen(s.week.sales)}</b><span class="sub2">${s.week.orders}件</span></div>
        <div class="stat"><span class="sub2">30日間</span><b>${yen(s.month.sales)}</b><span class="sub2">${s.month.orders}件・客単価${s.month.orders ? yen(Math.round(s.month.sales / s.month.orders)) : '-'}</span></div>
        <div class="stat" style="cursor:pointer" data-go="awaiting_payment"><span class="sub2">入金待ち</span><b>${s.status.awaiting_payment || 0}件</b></div>
        <div class="stat" style="cursor:pointer" data-go="paid"><span class="sub2">発送待ち</span><b class="${s.to_ship ? 'danger' : ''}">${s.to_ship || 0}件</b></div>
        <div class="stat"><span class="sub2">公開中の在庫</span><b>${s.stock.units}点</b><span class="sub2">${s.stock.items}商品・販売額${yen(s.stock.value)}</span></div>
        <div class="stat"><span class="sub2">会員</span><b>${s.members.n}人</b><span class="sub2">30日で+${s.members.new30 || 0}・未使用ポイント${s.members.points.toLocaleString()}pt</span></div>
        <div class="stat"><span class="sub2">オリパ（30日・注文分）</span><b>${yen(s.oripa.sales)}</b><span class="sub2">${s.oripa.draws}口</span></div>
        ${s.coins ? `<div class="stat"><span class="sub2">${esc(settings?.coin?.name || 'コイン')}販売（30日）</span><b>${yen(s.coins.sales30)}</b><span class="sub2">獲得カードBOX ${s.coins.prize_box}枚が未発送</span></div>
        <div class="stat"><span class="sub2">未使用${esc(settings?.coin?.name || 'コイン')}（購入分）</span><b class="${(s.coins.expireMonths === 0 || s.coins.expireMonths > 6) && s.coins.paid_unused > 8000000 ? 'danger' : ''}">${Number(s.coins.paid_unused).toLocaleString()}</b><span class="sub2">${s.coins.expireMonths && s.coins.expireMonths <= 6 ? `有効期限${s.coins.expireMonths}か月のため資金決済法の届出対象外` : '3月末・9月末に1,000万円を超えると財務局への届出が必要'}</span></div>` : ''}
      </div>
      <div class="panel" style="margin-bottom:12px"><b>30日間の売上（入金済み）</b>
        <div class="bars">${days.map(d => { const v = map[d]?.sales || 0; return `<div style="height:${Math.round(v / max * 100)}%" data-t="${d.slice(5)} ${yen(v)}"></div>`; }).join('')}</div>
        <div class="row-between small muted"><span>${days[0].slice(5)}</span><span>今日</span></div>
      </div>
      <div class="two">
        <div class="panel"><b>売れ筋（30日）</b>
          <table class="t">${s.top.map(p => `<tr><td>${esc(p.name)} <span class="muted small">${esc(p.card_no)} ${esc(p.condition)}</span></td><td class="num">${p.sold}点</td><td class="num ${p.stock ? '' : 'danger'}">在庫${p.stock}</td></tr>`).join('') || '<tr><td class="muted">まだありません</td></tr>'}</table></div>
        <div class="panel"><b>入荷待ちの多い商品</b> <span class="muted small">在庫を入れると自動でメールが届きます</span>
          <table class="t">${s.waiting.map(p => `<tr><td>${esc(p.name)} <span class="muted small">${esc(p.card_no)} ${esc(p.condition)}</span></td><td class="num">${p.waiting}人</td></tr>`).join('') || '<tr><td class="muted">ありません</td></tr>'}</table></div>
      </div>`;
    $$('[data-go]').forEach(b => b.onclick = () => { orderFilter = b.dataset.go; tab = 'orders'; render(); });
  }

  // ─── 注文 ───
  async function viewOrders() { shell('<p class="muted">読み込み中…</p>'); ordersCache = await api('/api/admin/orders'); drawOrders(); }
  function itemsText(o) {
    const lines = o.items.filter(i => !i.oripa_id).map(i => `${esc(i.name)} ${esc(i.card_no)} [${esc(i.condition)}] ${yen(i.price)} × ${i.qty}`);
    const ol = o.items.filter(i => i.oripa_id).map(i => `🎁 オリパ「${esc(i.name)}」${yen(i.price)} × ${i.qty}口`);
    const dr = o.draws.length ? `<div class="small" style="margin-top:4px"><b>当選品（発送対象）</b>：${o.draws.map(d => `${esc(d.is_last_one ? 'ラストワン' : d.rank)} ${esc(d.name)}`).join('、')}</div>` : '';
    return [...ol, ...lines].join('<br>') + dr;
  }
  function drawOrders() {
    const all = ordersCache;
    const count = s => all.filter(o => o.status === s).length;
    const list = orderFilter === 'all' ? all : all.filter(o => o.status === orderFilter);
    $('#body').innerHTML = `
      <div class="chips" style="padding-top:0">
        ${[['awaiting_payment', '入金待ち'], ['paid', '発送待ち'], ['shipped', '発送済み'], ['cancelled', 'キャンセル'], ['expired', '期限切れ'], ['all', 'すべて']]
          .map(([k, l]) => `<button class="chip ${orderFilter === k ? 'on' : ''}" data-f="${k}">${l}${['awaiting_payment', 'paid'].includes(k) && count(k) ? `（${count(k)}）` : ''}</button>`).join('')}
      </div>
      ${orderFilter === 'paid' && list.length ? `
        <div class="toolbar2">
          <label class="check"><input type="checkbox" id="selall" checked> すべて選択</label>
          <button class="btn sm" id="pick">ピッキングリスト</button><button class="btn sm" id="slip">納品書を印刷</button><button class="btn sm" id="csv">発送用CSV</button>
        </div>` : ''}
      ${list.length ? `<div class="toolbar2"><button class="btn sm" id="ocsv">この一覧をCSVで書き出し</button></div>` : ''}
      <div class="orders">
        ${list.map(o => `
          <div class="order" data-id="${o.id}">
            <div class="row-between">
              <span class="sel">${orderFilter === 'paid' ? `<input type="checkbox" class="osel" checked>` : ''}<strong class="mono">${esc(o.order_no)}</strong>
                ${o.kind === 'coin' ? `<span class="pill">${esc(settings?.coin?.name || 'コイン')}購入 ${Number(o.coins).toLocaleString()}</span>` : ''}${o.kind === 'ship' ? '<span class="pill">オリパ当選品の発送</span>' : ''}${o.shipping_method === 'pickup' ? '<span class="pill">店頭受取</span>' : ''}${o.customer_id ? '<span class="pill">会員</span>' : ''}${o.coupon_code ? `<span class="pill">${esc(o.coupon_code)}</span>` : ''}${o.draws.length ? '<span class="pill">オリパ</span>' : ''}</span>
              <span class="status s-${esc(o.status)}">${o.kind === 'coin' && o.status === 'shipped' ? '付与済み' : STATUS[o.status]}</span>
            </div>
            <div class="small">${jst(o.created_at)}　${{ bank: '銀行振込', card: 'カード', points: 'ポイント', coin: esc(settings?.coin?.name || 'コイン') }[o.payment_method]}　<strong>${yen(o.total)}</strong>${o.discount ? `（クーポン-${yen(o.discount)}）` : ''}${o.points_used ? `（ポイント-${o.points_used}）` : ''}（送料${yen(o.shipping_fee)}）${o.points_earn ? `　付与予定${o.points_earn}pt${o.points_granted ? '済' : ''}` : ''}</div>
            ${o.kind === 'coin' && o.status === 'awaiting_payment' ? '<div class="small">入金確認するとコインが付与され、この注文は完了になります。</div>' : ''}
            ${o.payment_method === 'bank' && o.status === 'awaiting_payment' ? `<div class="hint">振込名義の目印：<b>${esc(o.order_no.replace('PK', ''))}</b> ${esc(o.kana || o.name)}　金額 <b>${yen(o.total)}</b>　期限 ${jst(o.expires_at)}</div>` : ''}
            <div class="small">${esc(o.name)}${o.kana ? `（${esc(o.kana)}）` : ''} ／ ${esc(o.phone)} ／ ${esc(o.email)}${o.shipping_method === 'pickup' ? '' : `<br>〒${esc(o.zip)} ${esc(o.address)}`}</div>
            ${o.note ? `<div class="small">備考：${esc(o.note)}</div>` : ''}
            <div class="items">${itemsText(o)}</div>
            <textarea class="memo" rows="1" placeholder="社内メモ">${esc(o.admin_memo)}</textarea>
            <div class="actions">
              ${o.status === 'awaiting_payment' ? `<button class="btn sm primary" data-act="paid">入金確認</button>` : ''}
              ${o.status === 'paid' ? (o.shipping_method === 'pickup' ? `<button class="btn sm primary" data-act="shipped">受取準備完了を通知</button>` : `
                <select class="car">${Object.entries(CARRIERS).map(([k, l]) => `<option value="${k}" ${o.carrier === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
                <input class="trk" placeholder="追跡番号" value="${esc(o.tracking_no)}" inputmode="numeric"><button class="btn sm primary" data-act="shipped">発送済みにする</button>`) : ''}
              ${o.status === 'shipped' && o.tracking_no ? `<span class="small">${esc(CARRIERS[o.carrier] || '')} <b class="mono">${esc(o.tracking_no)}</b></span>` : ''}
              ${o.kind === 'coin' ? (['awaiting_payment', 'shipped'].includes(o.status) ? `<button class="btn sm" data-act="cancelled">${o.status === 'shipped' ? 'キャンセル（付与したコインを取り消す）' : 'キャンセル'}</button>` : '')
                : o.kind === 'ship' ? (o.status === 'paid' ? `<button class="btn sm" data-act="cancelled">キャンセル（当選品はお客様のBOXに戻す）</button>` : '')
                : (['awaiting_payment', 'paid'].includes(o.status) ? `<button class="btn sm" data-act="cancelled">キャンセル（在庫・オリパ・ポイントを戻す）</button>` : '')}
              <button class="btn sm" data-act="memo">メモ保存</button>
            </div>
          </div>`).join('') || '<p class="muted pad center">該当する注文はありません</p>'}
      </div>`;
    $$('[data-f]').forEach(b => b.onclick = () => { orderFilter = b.dataset.f; drawOrders(); });
    $$('[data-act]').forEach(b => b.onclick = async () => {
      const card = b.closest('.order'); const id = card.dataset.id; const act = b.dataset.act;
      const body = { admin_memo: $('.memo', card).value };
      if (act === 'cancelled' && !confirm('この注文をキャンセルしますか？\n在庫・オリパの抽選・クーポン・ポイントを元に戻します。\n（カード決済済みの場合、返金はStripeの管理画面で行ってください）')) return;
      if (act === 'shipped' && $('.trk', card)) {
        body.tracking_no = $('.trk', card).value.trim(); body.carrier = $('.car', card).value;
        if (!body.tracking_no && !confirm('追跡番号なしで発送済みにしますか？')) return;
      }
      if (act !== 'memo') body.status = act;
      b.disabled = true;
      try { await api(`/api/admin/orders/${id}`, { method: 'PUT', body: JSON.stringify(body) }); toast('更新しました'); viewOrders(); }
      catch (e) { toast(e.message); b.disabled = false; }
    });
    const sel = () => $$('.osel').filter(c => c.checked).map(c => ordersCache.find(o => o.id === +c.closest('.order').dataset.id));
    const sa = $('#selall'); if (sa) sa.onchange = () => $$('.osel').forEach(c => c.checked = sa.checked);
    const pk = $('#pick'); if (pk) pk.onclick = () => printPicking(sel());
    const sl = $('#slip'); if (sl) sl.onclick = () => printSlips(sel());
    const cv = $('#csv'); if (cv) cv.onclick = () => {
      const rows = sel().filter(o => o.shipping_method !== 'pickup');
      download(`shipping_${today()}.csv`, [['注文番号', 'お届け先郵便番号', 'お届け先住所', 'お届け先氏名', 'お届け先電話番号', '品名', '合計金額'], ...rows.map(o => [o.order_no, o.zip, o.address, o.name, o.phone, 'トレーディングカード', o.total])]);
    };
    const oc = $('#ocsv'); if (oc) oc.onclick = () => download(`orders_${orderFilter}_${today()}.csv`, [
      ['注文番号', '種類', '日時', '状況', '支払い', '受取', '氏名', 'メール', '電話', '郵便番号', '住所', '小計', 'クーポン', 'ポイント利用', '送料', '合計', '内容', '追跡番号', 'メモ'],
      ...list.map(o => [o.order_no, { normal: '通常', coin: 'コイン購入', ship: '当選品発送' }[o.kind] || o.kind, jst(o.created_at, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }), STATUS[o.status], o.payment_method, o.shipping_method === 'pickup' ? '店頭' : '配送', o.name, o.email, o.phone, o.zip, o.address, o.subtotal, o.discount, o.points_used, o.shipping_fee, o.total,
        [...o.items.map(i => i.oripa_id ? `オリパ ${i.name}×${i.qty}` : `${i.name} ${i.card_no} ${i.condition}×${i.qty}`), ...o.draws.map(d => `当選:${d.rank} ${d.name}`)].join(' / '), o.tracking_no, o.admin_memo])]);
  }

  function printWindow(title, body) {
    const w = window.open('', '_blank');
    if (!w) { toast('ポップアップを許可してください'); return; }
    w.document.write(`<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
      body{font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;font-size:12px;margin:18px;color:#111}
      h1{font-size:18px;margin:0 0 4px} table{width:100%;border-collapse:collapse;margin:10px 0} th,td{border:1px solid #999;padding:5px 6px;text-align:left}
      td.n{text-align:right;white-space:nowrap} .slip{page-break-after:always;padding-bottom:12px} .slip:last-child{page-break-after:auto}
      .row{display:flex;justify-content:space-between;gap:20px} .box{border:1px solid #999;padding:8px;margin-top:8px} .chk{width:22px}
      @media print{button{display:none}}</style></head><body><button id="pr">印刷する</button>${body}</body></html>`);
    w.document.close();
    w.document.getElementById('pr').addEventListener('click', () => w.print());
  }
  function printPicking(orders) {
    if (!orders.length) { toast('注文を選択してください'); return; }
    const agg = new Map();
    const add = (k, v, qty, no) => { const a = agg.get(k) || { ...v, qty: 0, orders: [] }; a.qty += qty; a.orders.push(`${no}×${qty}`); agg.set(k, a); };
    orders.forEach(o => {
      o.items.filter(i => !i.oripa_id).forEach(i => add('p' + i.product_id, { name: i.name, card_no: i.card_no, condition: i.condition }, i.qty, o.order_no));
      o.draws.forEach(d => add('z' + d.prize_id, { name: `【オリパ当選】${d.rank} ${d.name}`, card_no: d.title, condition: '' }, 1, o.order_no));
    });
    const rows = [...agg.values()].sort((a, b) => String(a.card_no).localeCompare(String(b.card_no)) || a.name.localeCompare(b.name));
    printWindow('ピッキングリスト', `<h1>ピッキングリスト</h1><div>${new Date().toLocaleString('ja-JP')}　注文${orders.length}件・${rows.reduce((s, r) => s + r.qty, 0)}点</div>
      <table><tr><th class="chk">✓</th><th>商品名</th><th>型番</th><th>状態</th><th>数量</th><th>注文</th></tr>
      ${rows.map(r => `<tr><td></td><td>${esc(r.name)}</td><td>${esc(r.card_no)}</td><td>${esc(r.condition)}</td><td class="n"><b>${r.qty}</b></td><td>${esc(r.orders.join(', '))}</td></tr>`).join('')}</table>`);
  }
  function printSlips(orders) {
    if (!orders.length) { toast('注文を選択してください'); return; }
    printWindow('納品書', orders.map(o => `
      <div class="slip">
        <div class="row"><div><h1>納品書</h1>注文番号 ${esc(o.order_no)}<br>ご注文日 ${jst(o.created_at, { year: 'numeric', month: 'numeric', day: 'numeric' })}</div>
          <div style="text-align:right"><b>${esc(settings?.shopName || '')}</b><br>${settings?.kobutsu ? '古物商許可 ' + esc(settings.kobutsu) : ''}</div></div>
        <div class="box">${o.shipping_method === 'pickup' ? '店頭受け取り' : `〒${esc(o.zip)}<br>${esc(o.address)}`}<br><b style="font-size:14px">${esc(o.name)} 様</b></div>
        <table><tr><th class="chk">✓</th><th>商品</th><th>状態</th><th>単価</th><th>数量</th><th>小計</th></tr>
          ${o.items.map(i => `<tr><td></td><td>${i.oripa_id ? `オリパ「${esc(i.name)}」` : `${esc(i.name)} ${esc(i.card_no)}`}</td><td>${i.oripa_id ? '' : esc(i.condition)}</td><td class="n">${yen(i.price)}</td><td class="n">${i.qty}</td><td class="n">${yen(i.price * i.qty)}</td></tr>`).join('')}
          ${o.draws.map(d => `<tr><td></td><td>オリパ当選品：${esc(d.is_last_one ? 'ラストワン賞' : d.rank)} ${esc(d.name)}</td><td></td><td class="n">-</td><td class="n">1</td><td class="n">-</td></tr>`).join('')}
          <tr><td colspan="5" class="n">小計</td><td class="n">${yen(o.subtotal)}</td></tr>
          ${o.discount ? `<tr><td colspan="5" class="n">クーポン割引</td><td class="n">-${yen(o.discount)}</td></tr>` : ''}
          ${o.points_used ? `<tr><td colspan="5" class="n">ポイント利用</td><td class="n">-${yen(o.points_used)}</td></tr>` : ''}
          <tr><td colspan="5" class="n">送料</td><td class="n">${yen(o.shipping_fee)}</td></tr>
          <tr><td colspan="5" class="n"><b>合計（税込）</b></td><td class="n"><b>${yen(o.total)}</b></td></tr></table>
        <div>この度はご注文いただき誠にありがとうございました。商品に不備がございましたら、到着後7日以内にご連絡ください。</div>
      </div>`).join(''));
  }

  // ─── 商品（状態違いをまとめて表示） ───
  async function loadProducts() { productsCache = await api('/api/admin/products'); }
  async function viewProducts() { shell('<p class="muted">読み込み中…</p>'); await loadProducts(); drawProducts(); }
  function groupsOf(list) {
    const g = new Map();
    for (const p of list) { const k = gkey(p); if (!g.has(k)) g.set(k, []); g.get(k).push(p); }
    return [...g.values()];
  }
  function drawProducts() {
    const terms = productQ.trim().split(/\s+/).map(norm).filter(Boolean);
    const list = productsCache.filter(p => { const h = norm([p.name, p.set_name, p.card_no, p.rarity, p.condition].join(' ')); return terms.every(t => h.includes(t)); });
    const groups = groupsOf(list);
    $('#body').innerHTML = `
      <div class="toolbar2">
        <input id="pq" type="search" placeholder="検索（名前・型番・弾・状態）" value="${esc(productQ)}" style="max-width:320px">
        <button class="btn primary sm" id="new">＋ 商品を追加</button>
      </div>
      <p class="small muted">${groups.length}カード・${list.length}商品 ／ 在庫合計 ${list.reduce((s, p) => s + p.stock, 0)}点</p>
      <div class="panel overflow">
        <table class="t">
          <thead><tr><th></th><th>商品名 / 状態</th><th>型番</th><th>状態</th><th class="num">価格</th><th class="num">買取</th><th class="num">在庫</th><th class="num">売上30日</th><th></th></tr></thead>
          <tbody>
            ${groups.map(vs => vs.map((p, i) => `
              <tr class="${p.active ? '' : 'off'} ${i ? 'vrow' : 'grp'}" data-id="${p.id}">
                <td>${p.image_url ? `<img class="thumb" src="${esc(p.image_url)}" alt="">` : ''}</td>
                <td>${i ? `<span class="small">状態 ${esc(p.condition)}</span>` : `<b>${esc(p.name)}</b><br><span class="muted small">${esc(catLabel(p.category))} ${esc(p.set_name)} ${esc(p.rarity)}</span>`}
                  ${p.real_photo ? ' <span class="pill">実物</span>' : ''}${p.active ? '' : ' <span class="small muted">非公開</span>'}
                  ${p.waiting ? `<br><span class="danger small">入荷待ち ${p.waiting}人</span>` : ''}</td>
                <td class="small">${i ? '' : esc(p.card_no)}</td>
                <td class="small"><b>${esc(p.condition)}</b></td>
                <td class="num">${yen(p.price)}${p.compare_price > p.price ? `<br><s class="muted small">${yen(p.compare_price)}</s>` : ''}</td>
                <td class="num small">${p.buy_price ? yen(p.buy_price) : '-'}</td>
                <td class="num"><span class="stockctl"><button data-st="-1">−</button><b>${p.stock}</b><button data-st="1">＋</button></span></td>
                <td class="num small">${p.sold || ''}</td>
                <td style="white-space:nowrap"><button class="link" data-edit>編集</button>${i === vs.length - 1 ? ` <button class="link" data-var>＋状態</button>` : ''}</td>
              </tr>`).join('')).join('')}
          </tbody>
        </table>
      </div>`;
    const pq = $('#pq');
    pq.oninput = () => { productQ = pq.value; clearTimeout(drawProducts._t); drawProducts._t = setTimeout(() => { drawProducts(); const n = $('#pq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250); };
    $('#new').onclick = () => editProduct(null);
    const rowP = b => productsCache.find(p => p.id === +b.closest('tr').dataset.id);
    $$('[data-edit]').forEach(b => b.onclick = () => editProduct(rowP(b)));
    $$('[data-var]').forEach(b => b.onclick = () => { const p = rowP(b); editProduct({ ...p, id: undefined, condition: '', stock: 1, image_url: p.real_photo ? '' : p.image_url, images: [], real_photo: 0, compare_price: 0, group_key: gkey(p) }, true); });
    $$('[data-st]').forEach(b => b.onclick = async () => {
      const p = rowP(b);
      try { const r = await api(`/api/admin/products/${p.id}/stock`, { method: 'POST', body: JSON.stringify({ delta: +b.dataset.st }) }); p.stock = r.stock; if (r.notified) { toast(`入荷通知を${r.notified}人に送りました`); p.waiting = 0; } drawProducts(); }
      catch (e) { toast(e.message); }
    });
  }

  function editProduct(p, isNewVariant) {
    const d = $('#dlg');
    const v = p || { category: settings?.categories?.[0]?.key || 'single', condition: 'A', active: 1, stock: 1, price: 0, sort: 0, images: [] };
    let imgs = [v.image_url, ...(v.images || [])].filter(Boolean);
    const editing = p && p.id;
    const variants = editing ? productsCache.filter(x => gkey(x) === gkey(p) && x.id !== p.id) : [];
    d.innerHTML = `
      <form method="dialog" class="form" id="pf">
        <h2 style="margin:0">${editing ? '商品を編集' : isNewVariant ? `「${esc(v.name)}」に状態を追加` : '商品を追加'}</h2>
        <div class="fs" style="background:var(--bg)"><h3>カード情報 <span class="muted small">（状態違い共通）</span></h3>
          <label>商品名 *<input name="name" required value="${esc(v.name)}"></label>
          <div class="grid2">
            <label>弾・セット<input name="set_name" value="${esc(v.set_name)}" list="sets"></label>
            <label>型番<input name="card_no" value="${esc(v.card_no)}" placeholder="201/165"></label>
            <label>レアリティ<input name="rarity" value="${esc(v.rarity)}" placeholder="SAR" list="rars"></label>
          </div>
          ${variants.length ? `<label class="check"><input type="checkbox" name="sync_group" checked> カード情報を同じカードの他の状態（${variants.length}件）にも反映する</label>` : ''}
        </div>
        <div class="fs"><h3>この状態の内容</h3>
          <div class="grid3">
            <label>状態 *<input name="condition" value="${esc(v.condition)}" placeholder="A / B / PSA10" list="conds" required></label>
            <label>販売価格 *<input name="price" type="number" min="0" required value="${esc(v.price)}"></label>
            <label>在庫 *<input name="stock" type="number" min="0" required value="${esc(v.stock)}"></label>
            <label>値下げ前の価格<input name="compare_price" type="number" min="0" value="${esc(v.compare_price || '')}" placeholder="セール時のみ"></label>
            <label>買取価格<input name="buy_price" type="number" min="0" value="${esc(v.buy_price || '')}" placeholder="表示する場合"></label>
            <label>表示順<input name="sort" type="number" value="${esc(v.sort)}"></label>
            <label>カテゴリ<select name="category" style="width:100%">${(settings?.categories || []).map(c => `<option value="${esc(c.key)}" ${v.category === c.key ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
          </div>
          <label>説明<textarea name="description" rows="2" placeholder="センタリング・傷の位置など">${esc(v.description)}</textarea></label>
          <div><b class="small">写真</b> <span class="muted small">（スマホで撮影してそのまま追加・1枚目がメイン）</span><div class="imgs" id="imgs"></div></div>
          <label class="check"><input type="checkbox" name="real_photo" ${v.real_photo ? 'checked' : ''}> 実物写真（届くカードそのものを撮影）</label>
          <label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> ショップに公開する</label>
        </div>
        ${variants.length ? `<div class="fs"><h3>このカードの他の状態</h3><table class="t">${variants.map(x => `<tr><td><b>${esc(x.condition)}</b></td><td class="num">${yen(x.price)}</td><td class="num">在庫${x.stock}</td><td><button type="button" class="link" data-ed="${x.id}">編集</button></td></tr>`).join('')}</table></div>` : ''}
        <datalist id="conds">${[...new Set(['S', 'A', 'B', 'C', 'PSA10', 'PSA9', '未開封', '新品', ...productsCache.map(x => x.condition)].filter(Boolean))].map(s => `<option>${esc(s)}</option>`).join('')}</datalist>
        <datalist id="sets">${[...new Set(productsCache.map(x => x.set_name).filter(Boolean))].map(s => `<option>${esc(s)}</option>`).join('')}</datalist>
        <datalist id="rars">${[...new Set(productsCache.map(x => x.rarity).filter(Boolean))].map(s => `<option>${esc(s)}</option>`).join('')}</datalist>
        <div class="row-between">
          <span>${editing ? '<button type="button" class="link danger" id="del">削除</button> <button type="button" class="link" id="addvar">＋状態を追加</button>' : ''}</span>
          <div style="display:flex;gap:8px"><button type="button" class="btn" id="cancel">閉じる</button><button class="btn primary">保存</button></div>
        </div>
      </form>`;
    const drawImgs = () => {
      $('#imgs').innerHTML = imgs.map((u, i) => `<div class="im"><img src="${esc(u)}" alt="">${i === 0 ? '<span class="main">メイン</span>' : `<span class="main" style="background:#555;cursor:pointer" data-first="${i}">メインに</span>`}<button type="button" data-rm="${i}">×</button></div>`).join('')
        + `<label class="upl">＋写真<input type="file" accept="image/*" multiple id="up"></label>`;
      $$('[data-rm]', d).forEach(b => b.onclick = () => { imgs.splice(+b.dataset.rm, 1); drawImgs(); });
      $$('[data-first]', d).forEach(b => b.onclick = () => { const [x] = imgs.splice(+b.dataset.first, 1); imgs.unshift(x); drawImgs(); });
      $('#up').onchange = async e => {
        for (const f of e.target.files) { try { toast('アップロード中…'); imgs.push(await uploadFile(f)); drawImgs(); toast('追加しました'); } catch (err) { toast(err.message); } }
      };
    };
    drawImgs();
    d.showModal();
    $('#cancel').onclick = () => d.close();
    $$('[data-ed]', d).forEach(b => b.onclick = () => { d.close(); editProduct(productsCache.find(x => x.id === +b.dataset.ed)); });
    const av = $('#addvar'); if (av) av.onclick = () => { d.close(); editProduct({ ...p, id: undefined, condition: '', stock: 1, image_url: p.real_photo ? '' : p.image_url, images: [], real_photo: 0, compare_price: 0, group_key: gkey(p) }, true); };
    $('#pf').onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = Object.fromEntries(FIELDS.map(f => [f, fd.get(f)]));
      Object.assign(body, { active: fd.get('active') ? 1 : 0, real_photo: fd.get('real_photo') ? 1 : 0, image_url: imgs[0] || '', images: imgs.slice(1), group_key: v.group_key || (editing ? p.group_key : ''), sync_group: !!fd.get('sync_group') });
      if (isNewVariant && productsCache.some(x => gkey(x) === v.group_key && norm(x.condition) === norm(body.condition))) { if (!confirm(`状態「${body.condition}」は既にあります。別の商品として追加しますか？`)) return; }
      try {
        const r = editing ? await api(`/api/admin/products/${p.id}`, { method: 'PUT', body: JSON.stringify(body) }) : await api('/api/admin/products', { method: 'POST', body: JSON.stringify(body) });
        d.close(); toast(r.notified ? `保存しました（入荷通知を${r.notified}人に送信）` : '保存しました'); await loadProducts(); drawProducts();
      } catch (err) { toast(err.message); }
    };
    const del = $('#del');
    if (del) del.onclick = async () => {
      if (!confirm('この商品（この状態）を削除しますか？（注文履歴がある場合は非公開になります）')) return;
      try { const r = await api(`/api/admin/products/${p.id}`, { method: 'DELETE' }); d.close(); toast(r.note || '削除しました'); await loadProducts(); drawProducts(); }
      catch (err) { toast(err.message); }
    };
  }

  // ─── CSV 入出力 ───
  function parseCSV(text) {
    const rows = []; let row = []; let cell = ''; let q = false;
    text = text.replace(/^﻿/, '');
    const delim = (text.split('\n')[0].match(/\t/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(r => r.some(c => c.trim() !== ''));
  }
  async function viewCsv() {
    shell('<p class="muted">読み込み中…</p>');
    await loadProducts();
    $('#body').innerHTML = `
      <div class="fs"><h3>書き出し</h3>
        <p class="hint2">Excel・Googleスプレッドシートで開いて編集し、下の「読み込み」でそのまま戻せます。</p>
        <div class="toolbar2">
          <button class="btn primary sm" data-exp="all">全項目を書き出す（${productsCache.length}件）</button>
          <button class="btn sm" data-exp="stock">在庫・価格だけ書き出す</button>
          <button class="btn sm" data-exp="template">空のテンプレート</button>
        </div>
      </div>
      <div class="fs"><h3>読み込み</h3>
        <div class="grid2">
          <label>読み込み方法<select id="mode" style="width:100%">
            <option value="upsert">追加・更新（IDがある行は更新、ない行は新規追加）</option>
            <option value="update">更新だけ（一致する商品だけ更新・新規追加しない）</option>
          </select></label>
          <label>在庫の扱い<select id="smode" style="width:100%">
            <option value="set">在庫数を上書きする</option>
            <option value="add">在庫数に加算する（入荷分を足す）</option>
          </select></label>
        </div>
        <label class="check"><input type="checkbox" id="match"> IDが空の行は「型番＋状態」（＋商品名）で既存の商品を探す</label>
        <p class="hint2">空欄の列は変更しません。見出しは日本語（${CSV_COLS.map(c => c[1]).join('・')}）・英語どちらでもOK。カテゴリは ${esc((settings?.categories || []).map(c => `${c.key}(${c.label})`).join(' / '))}</p>
        <input type="file" id="file" accept=".csv,.tsv,.txt,text/csv">
        <textarea id="csv" rows="8" placeholder="ID,商品名,状態,価格,在庫&#10;12,リザードンex,A,12800,2&#10;,ピカチュウex,B,4800,1"></textarea>
        <button class="btn" id="preview">プレビュー</button>
        <div id="pv"></div>
      </div>`;
    $$('[data-exp]').forEach(b => b.onclick = () => {
      const t = b.dataset.exp;
      if (t === 'template') return download('products_template.csv', [CSV_COLS.map(c => c[1])]);
      const cols = t === 'stock' ? CSV_COLS.filter(([k]) => ['id', 'name', 'card_no', 'condition', 'price', 'compare_price', 'buy_price', 'stock'].includes(k)) : CSV_COLS;
      const sorted = [...productsCache].sort((a, b) => gkey(a).localeCompare(gkey(b)) || a.id - b.id);
      download(`products_${t}_${today()}.csv`, [cols.map(c => c[1]), ...sorted.map(p => cols.map(([k]) => k === 'images' ? (p.images || []).join(' ') : p[k]))]);
    });
    $('#file').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      const buf = await f.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(buf);
      if (text.includes('�')) text = new TextDecoder('shift_jis').decode(buf); // Excel の Shift_JIS CSV
      $('#csv').value = text;
    };
    $('#preview').onclick = () => {
      const rows = parseCSV($('#csv').value);
      if (rows.length < 2) { toast('データがありません'); return; }
      const head = rows[0].map(h => HEAD_ALIAS[h.trim()] || h.trim());
      const unknown = rows[0].filter((h, i) => !FIELDS.includes(head[i]) && head[i] !== 'id');
      const cats = Object.fromEntries((settings?.categories || []).flatMap(c => [[c.label, c.key], [c.key, c.key]]));
      const items = rows.slice(1).map(r => {
        const o = {};
        head.forEach((h, i) => { if (FIELDS.includes(h) || h === 'id') o[h] = (r[i] ?? '').trim(); });
        if (o.category) o.category = cats[o.category] || o.category;
        if (o.real_photo) o.real_photo = /^(1|true|○|〇|はい|yes)$/i.test(o.real_photo) ? 1 : 0;
        if (o.active) o.active = /^(0|false|×|いいえ|no|非公開)$/i.test(o.active) ? 0 : 1;
        if (o.images) o.images = o.images.split(/[\s|]+/).filter(Boolean);
        return o;
      }).filter(o => Object.values(o).some(v => v !== '' && !(Array.isArray(v) && !v.length)));
      const withId = items.filter(o => o.id).length;
      $('#pv').innerHTML = `
        <p><b>${items.length}行</b>（ID あり ${withId}行・ID なし ${items.length - withId}行）${unknown.length ? `<br><span class="danger small">読み込まない列：${esc(unknown.join(', '))}</span>` : ''}</p>
        <div class="overflow"><table class="t"><tr>${head.filter(h => FIELDS.includes(h) || h === 'id').map(h => `<th>${esc((CSV_COLS.find(c => c[0] === h) || [h, h])[1])}</th>`).join('')}</tr>
        ${items.slice(0, 5).map(o => `<tr>${head.filter(h => FIELDS.includes(h) || h === 'id').map(h => `<td class="small">${esc(Array.isArray(o[h]) ? o[h].join(' ') : o[h])}</td>`).join('')}</tr>`).join('')}</table></div>
        <div class="prog" style="margin:10px 0"><i id="pg"></i></div>
        <button class="btn primary" id="go">${items.length}行を読み込む</button>
        <div id="res"></div>`;
      $('#go').onclick = async () => {
        $('#go').disabled = true;
        const CH = 100, tot = { created: 0, updated: 0, skipped: 0, notified: 0, errors: [] };
        try {
          for (let i = 0; i < items.length; i += CH) {
            const r = await api('/api/admin/products/import', { method: 'POST', body: JSON.stringify({ rows: items.slice(i, i + CH), offset: i, mode: $('#mode').value, stock_mode: $('#smode').value, match: $('#match').checked ? 'card' : 'id' }) });
            ['created', 'updated', 'skipped', 'notified'].forEach(k => tot[k] += r[k]); tot.errors.push(...r.errors);
            $('#pg').style.width = Math.round(Math.min(items.length, i + CH) / items.length * 100) + '%';
          }
          $('#res').innerHTML = `<p><b>完了</b>：追加 ${tot.created}件・更新 ${tot.updated}件・スキップ ${tot.skipped}件${tot.notified ? `・入荷通知 ${tot.notified}人` : ''}</p>
            ${tot.errors.length ? `<p class="danger small">エラー ${tot.errors.length}件<br>${tot.errors.slice(0, 30).map(e => `${e.row}行目：${esc(e.message)}`).join('<br>')}</p>` : ''}`;
          toast('読み込みました'); await loadProducts();
        } catch (e) { toast(e.message); $('#res').innerHTML = `<p class="danger">${esc(e.message)}（途中まで反映されています）</p>`; }
        $('#go').disabled = false;
      };
    };
  }

  // ─── オリパ ───
  async function viewOripa() {
    shell('<p class="muted">読み込み中…</p>');
    const list = await api('/api/admin/oripas');
    $('#body').innerHTML = `
      <div class="toolbar2"><button class="btn primary sm" id="newo">＋ オリパを作成</button><button class="btn sm" id="ocsv">CSVで作成・更新</button><button class="btn sm" id="oexp" ${list.length ? '' : 'disabled'}>CSVに書き出す</button><span class="muted small">販売開始後は封入内容（賞品・数）を変更できません（公平性のため）。</span></div>
      <div class="ogrid">${list.map(o => {
        const st = { draft: '下書き', live: '販売中', ended: '終了' }[o.status];
        return `<div class="panel"><div class="row-between"><b>${esc(o.title)}</b><span class="pill">${st}</span></div>
          <div class="small">${unitPrice(o.price)}/口　販売 ${o.sold} / ${o.total}口　売上 ${yen(o.sold * o.price)}</div>
          <div class="obar" style="margin:6px 0"><i style="width:${o.total ? Math.round((o.total - o.sold) / o.total * 100) : 0}%"></i></div>
          <div class="small muted">${o.prizes.map(p => `${esc(p.is_last_one ? 'ラストワン' : p.rank)} ${esc(p.name)} ${p.remaining}/${p.qty}`).join('<br>')}</div>
          <div class="toolbar2" style="margin:8px 0 0"><button class="btn sm" data-eo="${o.id}">編集</button><button class="btn sm" data-dr="${o.id}">当選履歴</button>
          ${o.status !== 'ended' && o.sold ? `<button class="btn sm" data-end="${o.id}">販売終了</button>` : ''}</div></div>`;
      }).join('') || '<p class="muted pad">まだオリパはありません</p>'}</div>`;
    $('#newo').onclick = () => editOripa(null);
    $('#ocsv').onclick = () => importOripaCsv();
    $('#oexp').onclick = () => download(`oripa_${today()}.csv`, [ORIPA_COLS.map(c => c[1]), ...list.flatMap(o => o.prizes.map((p, i) => ORIPA_COLS.map(([k]) => {
      if (k === 'oripa_id') return o.id;
      if (k === 'title') return o.title;
      if (i > 0 && ['price', 'status', 'max_per_order', 'banner', 'description'].includes(k)) return '';
      if (k === 'price') return o.price;
      if (k === 'status') return { draft: '下書き', live: '販売中', ended: '終了' }[o.status];
      if (k === 'max_per_order') return o.max_per_order;
      if (k === 'banner') return o.image_url;
      if (k === 'description') return o.description;
      if (k === 'is_last_one') return p.is_last_one ? '○' : '';
      if (['product_id', 'card_no', 'condition'].includes(k)) return '';
      return p[k];
    })))]);
    $$('[data-eo]').forEach(b => b.onclick = () => editOripa(list.find(o => o.id === +b.dataset.eo)));
    $$('[data-end]').forEach(b => b.onclick = async () => {
      if (!confirm('販売を終了しますか？（残りの口は販売されなくなります）')) return;
      const o = list.find(x => x.id === +b.dataset.end);
      try { await api('/api/admin/oripas', { method: 'POST', body: JSON.stringify({ ...o, starts_at: o.starts_at ? new Date(o.starts_at.replace(' ', 'T') + 'Z').toISOString() : '', ends_at: o.ends_at ? new Date(o.ends_at.replace(' ', 'T') + 'Z').toISOString() : '', status: 'ended' }) }); viewOripa(); } catch (e) { toast(e.message); }
    });
    $$('[data-dr]').forEach(b => b.onclick = async () => {
      const rows = await api(`/api/admin/oripas/${b.dataset.dr}/draws`);
      const d = $('#dlg');
      d.innerHTML = `<form method="dialog" class="form"><h2 style="margin:0">当選履歴（${rows.length}件）</h2><div class="overflow" style="max-height:60vh"><table class="t">
        <tr><th>日時</th><th>注文</th><th>お客様</th><th>賞</th><th>状況</th></tr>
        ${rows.map(r => `<tr><td class="small">${jst(r.created_at)}</td><td class="mono small">${esc(r.order_no || '—')}</td><td class="small">${esc(r.customer)}</td><td class="small">${esc(r.is_last_one ? 'ラストワン' : r.rank)} ${esc(r.name)}</td><td class="small">${!r.order_no ? '獲得カードBOXに保管中' : r.kind === 'ship' ? `発送依頼・${esc(STATUS[r.status])}` : `${esc(STATUS[r.status])}${r.revealed_at ? '・開封済' : ''}`}</td></tr>`).join('')}</table></div>
        <button class="btn">閉じる</button></form>`;
      d.showModal();
    });
  }


  const unitPrice = n => settings?.features?.coins ? `${Number(n).toLocaleString()}${esc(settings.coin.name)}` : yen(n);
  const ORIPA_COLS = [['oripa_id', 'オリパID'], ['title', 'オリパ名'], ['price', '1口の価格'], ['status', '状態'], ['max_per_order', '1回の上限口数'], ['banner', 'バナー画像URL'], ['description', '説明'],
    ['rank', 'ランク'], ['name', '賞品名'], ['qty', '封入数'], ['value', '参考価格'], ['image_url', '賞品画像URL'], ['is_last_one', 'ラストワン'], ['product_id', '商品ID'], ['card_no', '型番'], ['condition', '商品の状態']];
  const ORIPA_ALIAS = Object.fromEntries([...ORIPA_COLS.map(([k, l]) => [l, k]), ...ORIPA_COLS.map(([k]) => [k, k]),
    ['タイトル', 'title'], ['価格', 'price'], ['賞', 'rank'], ['枚数', 'qty'], ['口数', 'qty'], ['画像URL', 'image_url'], ['LO', 'is_last_one'], ['状態（商品）', 'condition']]);

  // 登録済みの商品から賞品の中身を作る
  const prizeFromProduct = x => ({
    name: [x.name, x.rarity, x.card_no].filter(Boolean).join(' ') + (x.condition ? `（${x.condition}）` : ''),
    image_url: x.image_url || (x.images || [])[0] || '', value: x.price, product_id: x.id,
  });
  function findProduct(r) {
    if (r.product_id) return productsCache.find(p => p.id === +r.product_id) || null;
    if (!r.card_no) return null;
    const hits = productsCache.filter(p => norm(p.card_no) === norm(r.card_no) && (!r.condition || norm(p.condition) === norm(r.condition)));
    return hits.length === 1 ? hits[0] : hits.find(p => p.stock > 0) || hits[0] || null;
  }

  // 商品を選ぶ小窓（multi=true で複数選択）
  async function pickProducts(multi) {
    if (!productsCache.length) await loadProducts();
    return new Promise(resolve => {
      const pd = document.createElement('dialog');
      pd.className = "ed picker";
      const picked = new Set();
      pd.innerHTML = `<form method="dialog" class="form">
        <div class="row-between"><h2 style="margin:0">商品から選ぶ</h2><span class="small muted">名前・型番・状態で検索</span></div>
        <input type="search" id="pq" placeholder="例：リザードン 201/165 PSA10" autocomplete="off">
        <div class="overflow" style="max-height:55vh"><table class="t" id="pl"></table></div>
        <p class="hint2" style="margin:0">賞品名・画像・参考価格（＝販売価格）が入ります。あとから書き換えられます。オリパに入れたカードの在庫は自動では減らないので、通常販売と重ならないよう在庫を調整してください。</p>
        <div class="row-between"><span class="small" id="pc"></span><div style="display:flex;gap:8px"><button type="button" class="btn" id="pcancel">閉じる</button>${multi ? '<button type="button" class="btn primary" id="pok">追加する</button>' : ''}</div></div>
      </form>`;
      document.body.appendChild(pd);
      const done = v => { pd.close(); pd.remove(); resolve(v); };
      const list = () => {
        const qs = norm($('#pq', pd).value) ? $('#pq', pd).value.trim().split(/\s+/).map(norm).filter(Boolean) : [];
        const hit = productsCache.filter(p => { const t = norm(`${p.name} ${p.card_no} ${p.condition} ${p.rarity} ${p.set_name}`); return qs.every(w => t.includes(w)); })
          .sort((x, y) => (y.stock > 0) - (x.stock > 0) || y.price - x.price).slice(0, 80);
        $('#pl', pd).innerHTML = hit.map(p => `<tr data-id="${p.id}" style="cursor:pointer">
          ${multi ? `<td><input type="checkbox" ${picked.has(p.id) ? 'checked' : ''}></td>` : ''}
          <td>${p.image_url ? `<img src="${esc(p.image_url)}" alt="" style="width:36px;height:50px;object-fit:cover;border-radius:4px">` : ''}</td>
          <td><b>${esc(p.name)}</b> <span class="muted small">${esc(p.card_no)} ${esc(p.rarity)}</span></td><td><span class="pill">${esc(p.condition)}</span></td>
          <td class="num">${yen(p.price)}</td><td class="num small ${p.stock ? '' : 'muted'}">在庫${p.stock}</td></tr>`).join('') || '<tr><td class="muted">見つかりません</td></tr>';
        $$('#pl tr[data-id]', pd).forEach(tr => tr.onclick = e => {
          const p = productsCache.find(x => x.id === +tr.dataset.id);
          if (!multi) return done([p]);
          picked.has(p.id) ? picked.delete(p.id) : picked.add(p.id);
          const cb = $('input', tr); if (e.target !== cb) cb.checked = picked.has(p.id);
          $('#pc', pd).textContent = picked.size ? `${picked.size}件を選択中` : '';
        });
      };
      $('#pq', pd).oninput = list;
      $('#pcancel', pd).onclick = () => done([]);
      pd.addEventListener('cancel', e => { e.preventDefault(); done([]); });
      const ok = $('#pok', pd); if (ok) ok.onclick = () => done(productsCache.filter(p => picked.has(p.id)));
      list();
      pd.showModal();
      $('#pq', pd).focus();
    });
  }

  // オリパを CSV でまとめて作成・更新（1行＝1つの賞。オリパ名が同じ行（または空欄の行）は同じオリパ）
  async function importOripaCsv() {
    if (!productsCache.length) await loadProducts();
    const d = $('#dlg');
    d.innerHTML = `<form method="dialog" class="form" id="ocf">
      <h2 style="margin:0">オリパをCSVで作成・更新</h2>
      <p class="hint2" style="margin:0">1行に1つの賞を書きます。<b>オリパ名</b>が同じ行（またはオリパ名が空欄の行）は前の行と同じオリパの賞になります。価格・状態などのオリパの項目は、各オリパの最初の行だけ書けばOKです。<br>
      <b>商品ID</b>か<b>型番（＋商品の状態）</b>を書くと、登録済みの商品から賞品名・画像・参考価格を自動で入れます（書いた欄はそのまま優先）。<br>
      <b>オリパID</b>がある行は既存のオリパを更新します（販売が始まったものは封入内容を変えられません）。空欄なら新しく作ります。状態が空欄なら「下書き」です。</p>
      <div class="toolbar2" style="margin:0"><button type="button" class="btn sm" id="otpl">テンプレート（記入例つき）</button><input type="file" id="ofile" accept=".csv,.tsv,.txt,text/csv"></div>
      <textarea id="ocsvt" rows="8" placeholder="オリパ名,1口の価格,状態,ランク,賞品名,封入数,参考価格,商品ID,型番,商品の状態"></textarea>
      <button type="button" class="btn" id="opv">プレビュー</button>
      <div id="opvr"></div>
      <div class="row-between"><span></span><button type="button" class="btn" id="oclose">閉じる</button></div>
    </form>`;
    d.showModal();
    $('#oclose').onclick = () => { d.close(); viewOripa(); };
    $('#otpl').onclick = () => {
      const pick = productsCache.find(p => p.card_no) || {};
      download('oripa_template.csv', [ORIPA_COLS.map(c => c[1]),
        ['', 'SAR確定！1000円オリパ', 1000, '下書き', 10, '', '1口でSAR以上確定', 'S賞', 'メガリザードンXex MUR', 1, 79800, '', '', '', '', ''],
        ['', '', '', '', '', '', '', 'A賞', '', 2, '', '', '', pick.id || '', '', ''],
        ['', '', '', '', '', '', '', 'B賞', '', 3, '', '', '', '', pick.card_no || '201/165', pick.condition || 'A'],
        ['', '', '', '', '', '', '', 'C賞', 'SAR 1枚', 94, 1200, '', '', '', '', ''],
        ['', '', '', '', '', '', '', 'ラストワン', 'BOX 1個', 1, 6600, '', '○', '', '', '']]);
    };
    $('#ofile').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      const buf = await f.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(buf);
      if (text.includes('�')) text = new TextDecoder('shift_jis').decode(buf);
      $('#ocsvt').value = text;
    };
    $('#opv').onclick = () => {
      const rows = parseCSV($('#ocsvt').value);
      if (rows.length < 2) { toast('データがありません'); return; }
      const head = rows[0].map(h => ORIPA_ALIAS[h.trim()] || '');
      const unknown = rows[0].filter((h, i) => !head[i]);
      const groups = []; const warn = [];
      rows.slice(1).forEach((r, n) => {
        const o = {}; head.forEach((h, i) => { if (h) o[h] = (r[i] ?? '').trim(); });
        const line = n + 2;
        let g = groups[groups.length - 1];
        const newGroup = (o.title && (!g || g.title !== o.title)) || (o.oripa_id && (!g || String(g.id || '') !== o.oripa_id));
        if (newGroup || !g) { g = { title: o.title || '', id: o.oripa_id ? +o.oripa_id : null, line, prizes: [] }; groups.push(g); }
        for (const [k, kk] of [['price', 'price'], ['max_per_order', 'max_per_order'], ['banner', 'image_url'], ['description', 'description']]) if (o[k] && g[kk] === undefined) g[kk] = o[k];
        if (o.status && !g.status) g.status = /販売|live|公開/i.test(o.status) ? 'live' : /終了|ended/i.test(o.status) ? 'ended' : 'draft';
        if (!o.name && !o.product_id && !o.card_no && !o.qty) return; // 賞のない行（オリパの項目だけ）
        const prod = (o.product_id || o.card_no) ? findProduct(o) : null;
        if ((o.product_id || o.card_no) && !prod) warn.push(`${line}行目：商品が見つかりません（${esc(o.product_id ? 'ID ' + o.product_id : o.card_no + ' ' + (o.condition || ''))}）`);
        const base = prod ? prizeFromProduct(prod) : {};
        const lo = /^(1|true|○|〇|はい|yes|lo)$/i.test(o.is_last_one || '') || /ラストワン|last/i.test(o.rank || '');
        g.prizes.push({
          rank: o.rank || '', name: o.name || base.name || '', image_url: o.image_url || base.image_url || '',
          qty: lo ? 1 : (o.qty === '' || o.qty === undefined ? 1 : +o.qty), value: o.value !== '' && o.value !== undefined ? +o.value : (base.value || 0), is_last_one: lo ? 1 : 0, sort: g.prizes.length, line,
        });
      });
      groups.forEach(g => {
        if (!g.title && !g.id) warn.push(`${g.line}行目：オリパ名がありません`);
        if (!g.id && !(+g.price > 0)) warn.push(`「${esc(g.title)}」：1口の価格がありません`);
        g.prizes.filter(p => !p.name).forEach(p => warn.push(`${p.line}行目：賞品名がありません`));
        if (g.prizes.filter(p => p.is_last_one).length > 1) warn.push(`「${esc(g.title)}」：ラストワン賞は1つまでです`);
        if (g.prizes.length > 40) warn.push(`「${esc(g.title)}」：賞は1つのオリパにつき40行までです`);
      });
      const ok = !warn.length;
      $('#opvr').innerHTML = `
        ${unknown.length ? `<p class="small danger">読み込まない列：${esc(unknown.join(', '))}</p>` : ''}
        ${groups.map(g => {
          const pool = g.prizes.filter(p => !p.is_last_one);
          const total = pool.reduce((s, p) => s + p.qty, 0), value = pool.reduce((s, p) => s + p.qty * p.value, 0);
          return `<div class="panel" style="margin:6px 0"><div class="row-between"><b>${esc(g.title || `ID ${g.id}`)}</b><span class="pill">${g.id ? `ID ${g.id} を更新` : '新規'}・${{ draft: '下書き', live: '販売中', ended: '終了' }[g.status || 'draft']}</span></div>
            <div class="small">${g.price ? unitPrice(g.price) + '/口　' : ''}総口数 ${total}口　還元率（参考） ${total && g.price ? Math.round(value / (total * g.price) * 100) : '—'}%</div>
            <table class="t">${g.prizes.map(p => `<tr><td class="small">${esc(p.is_last_one ? 'ラストワン' : p.rank)}</td><td>${p.image_url ? `<img src="${esc(p.image_url)}" alt="" style="width:28px;height:39px;object-fit:cover;border-radius:3px">` : ''}</td><td class="small">${esc(p.name) || '<span class="danger">（なし）</span>'}</td><td class="num small">${p.qty}枚</td><td class="num small">${yen(p.value)}</td></tr>`).join('')}</table></div>`;
        }).join('')}
        ${warn.length ? `<p class="small danger">${warn.slice(0, 30).join('<br>')}</p>` : ''}
        <button type="button" class="btn primary" id="ogo" ${ok ? '' : 'disabled'}>${groups.length}件のオリパを保存</button><div id="ores" class="small"></div>`;
      const go = $('#ogo');
      if (go) go.onclick = async () => {
        go.disabled = true;
        const res = [];
        for (const g of groups) {
          let cur = null;
          let body = { title: g.title, price: g.price, status: g.status || 'draft', max_per_order: g.max_per_order || 10, image_url: g.image_url || '', description: g.description || '', prizes: g.prizes };
          if (g.id) {
            cur = (await api('/api/admin/oripas')).find(o => o.id === g.id);
            if (!cur) { res.push(`ID ${g.id}：見つかりません`); continue; }
            body = { ...cur, ...Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== '' && v !== undefined && !(k === 'status' && !g.status) && !(k === 'max_per_order' && !g.max_per_order))), id: g.id,
              starts_at: cur.starts_at ? new Date(cur.starts_at.replace(' ', 'T') + 'Z').toISOString() : '', ends_at: cur.ends_at ? new Date(cur.ends_at.replace(' ', 'T') + 'Z').toISOString() : '' };
            // 販売開始後は既存の賞のIDを引き継いで名前・画像・参考価格だけ更新
            if (cur.sold > 0) body.prizes = g.prizes.map((p, i) => ({ ...p, id: cur.prizes.filter(x => x.is_last_one === p.is_last_one)[g.prizes.filter((q, j) => j < i && q.is_last_one === p.is_last_one).length]?.id }));
          }
          try { const r = await api('/api/admin/oripas', { method: 'POST', body: JSON.stringify(body) }); res.push(`「${esc(g.title || cur?.title || g.id)}」：保存しました${r.note ? `（${esc(r.note)}）` : ''}`); }
          catch (e) { res.push(`<span class="danger">「${esc(g.title || g.id)}」：${esc(e.message)}</span>`); }
        }
        $('#ores').innerHTML = res.join('<br>');
        toast('読み込みました');
      };
    };
  }

  function editOripa(o) {
    const d = $('#dlg');
    const v = o || { title: '', price: 1000, status: 'draft', max_per_order: 10, prizes: [{ rank: 'S賞', name: '', qty: 1, value: 0 }, { rank: 'A賞', name: '', qty: 3, value: 0 }, { rank: 'C賞', name: '', qty: 20, value: 0 }] };
    const locked = o && o.sold > 0;
    let prizes = v.prizes.map(p => ({ ...p }));
    let image = v.image_url || '';
    const draw = () => {
      const pool = prizes.filter(p => !p.is_last_one);
      const total = pool.reduce((s, p) => s + (+p.qty || 0), 0);
      const value = pool.reduce((s, p) => s + (+p.qty || 0) * (+p.value || 0), 0);
      $('#prz').innerHTML = `
        <div class="r p6 small muted"><span>ランク</span><span>賞品名</span><span>画像URL</span><span>封入数</span><span>参考価格</span><span>LO</span><span></span></div>
        ${prizes.map((p, i) => `<div class="r p6" data-i="${i}">
          <input data-k="rank" value="${esc(p.rank)}" placeholder="S賞">
          <span style="display:flex;gap:4px"><input data-k="name" value="${esc(p.name)}" placeholder="賞品名"><button type="button" class="btn sm" style="flex:none" data-pick="${i}" title="登録済みの商品から選ぶ">商品</button></span>
          <span style="display:flex;gap:4px"><input data-k="image_url" value="${esc(p.image_url)}" placeholder="https://"><label class="btn sm" style="flex:none">📷<input type="file" accept="image/*" data-up="${i}" hidden></label></span>
          <input data-k="qty" type="number" min="0" value="${p.is_last_one ? 1 : esc(p.qty)}" ${locked || p.is_last_one ? 'disabled' : ''}>
          <input data-k="value" type="number" min="0" value="${esc(p.value)}">
          <input data-k="is_last_one" type="checkbox" ${p.is_last_one ? 'checked' : ''} ${locked ? 'disabled' : ''} title="ラストワン賞">
          ${locked ? '<span></span>' : `<button type="button" class="link danger" data-rm="${i}">削除</button>`}
        </div>`).join('')}
        ${locked ? '' : '<div class="toolbar2" style="margin:0"><button type="button" class="btn sm" id="addp">＋ 賞を追加</button><button type="button" class="btn sm" id="addpp">＋ 登録済みの商品から追加</button></div>'}
        <p class="small">総口数 <b>${total}口</b>　賞品の参考価格合計 ${yen(value)}　売上見込み ${yen(total * (+$('#of').price.value || 0))}　<b>還元率（参考） ${total && +$('#of').price.value ? Math.round(value / (total * +$('#of').price.value) * 100) : 0}%</b></p>`;
      $$('#prz [data-k]').forEach(inp => inp.oninput = inp.onchange = () => {
        const p = prizes[+inp.closest('[data-i]').dataset.i];
        p[inp.dataset.k] = inp.type === 'checkbox' ? (inp.checked ? 1 : 0) : inp.value;
        if (inp.type === 'checkbox' || inp.dataset.k === 'qty' || inp.dataset.k === 'value') draw();
      });
      $$('#prz [data-rm]').forEach(b => b.onclick = () => { prizes.splice(+b.dataset.rm, 1); draw(); });
      $$('#prz [data-up]').forEach(inp => inp.onchange = async () => { try { toast('アップロード中…'); prizes[+inp.dataset.up].image_url = await uploadFile(inp.files[0]); draw(); } catch (e) { toast(e.message); } });
      const ap = $('#addp'); if (ap) ap.onclick = () => { prizes.push({ rank: '', name: '', qty: 1, value: 0 }); draw(); };
      const app2 = $('#addpp'); if (app2) app2.onclick = async () => {
        const sel = await pickProducts(true);
        sel.forEach(x => prizes.push({ rank: '', qty: 1, ...prizeFromProduct(x) }));
        if (sel.length) draw();
      };
      $$('#prz [data-pick]').forEach(b => b.onclick = async () => {
        const [x] = await pickProducts(false);
        if (!x) return;
        Object.assign(prizes[+b.dataset.pick], prizeFromProduct(x));
        draw();
      });
    };
    d.innerHTML = `
      <form method="dialog" class="form" id="of">
        <h2 style="margin:0">${o ? 'オリパを編集' : 'オリパを作成'}</h2>
        ${locked ? '<p class="small danger">販売が始まっているため、賞品の追加・削除・封入数・価格は変更できません。</p>' : ''}
        <label>タイトル *<input name="title" required value="${esc(v.title)}" placeholder="SAR確定！1000円オリパ"></label>
        <div class="grid3">
          <label>1口の価格${settings?.features?.coins ? `（${esc(settings.coin.name)}）` : ''} *<input name="price" type="number" min="1" required value="${esc(v.price)}" ${locked ? 'disabled' : ''}></label>
          <label>1注文の上限口数<input name="max_per_order" type="number" min="1" value="${esc(v.max_per_order)}"></label>
          <label>状態<select name="status" style="width:100%"><option value="draft" ${v.status === 'draft' ? 'selected' : ''}>下書き（非公開）</option><option value="live" ${v.status === 'live' ? 'selected' : ''}>販売中</option><option value="ended" ${v.status === 'ended' ? 'selected' : ''}>終了</option></select></label>
          <label>販売開始（任意）<input name="starts_at" type="datetime-local" value="${toLocalInput(v.starts_at)}"></label>
          <label>販売終了（任意）<input name="ends_at" type="datetime-local" value="${toLocalInput(v.ends_at)}"></label>
          <label>表示順<input name="sort" type="number" value="${esc(v.sort || 0)}"></label>
        </div>
        <div><b class="small">バナー画像</b><div class="imgs" id="oimg"></div></div>
        <label>説明<textarea name="description" rows="3">${esc(v.description)}</textarea></label>
        <div class="fs" style="background:var(--bg)"><h3>封入内容</h3><p class="hint2">ハズレ枠も「C賞 ノーマル5枚」のように賞品として登録してください（総口数＝封入数の合計）。LO＝ラストワン賞（最後の1口を引いた人に追加でプレゼント）。</p><div class="rows" id="prz"></div></div>
        <div class="row-between"><span>${o && !o.sold ? '<button type="button" class="link danger" id="odel">削除</button>' : ''}</span>
          <div style="display:flex;gap:8px"><button type="button" class="btn" id="ocancel">閉じる</button><button class="btn primary">保存</button></div></div>
      </form>`;
    const drawImg = () => {
      $('#oimg').innerHTML = (image ? `<div class="im" style="width:160px"><img src="${esc(image)}" style="width:160px;aspect-ratio:16/9" alt=""><button type="button" id="irm">×</button></div>` : '') + `<label class="upl" style="width:160px;aspect-ratio:16/9">＋画像<input type="file" accept="image/*" id="oup"></label>`;
      const rm = $('#irm'); if (rm) rm.onclick = () => { image = ''; drawImg(); };
      $('#oup').onchange = async e => { try { toast('アップロード中…'); image = await uploadFile(e.target.files[0]); drawImg(); } catch (err) { toast(err.message); } };
    };
    drawImg();
    d.showModal();
    draw();
    $('#of').price.oninput = draw;
    $('#ocancel').onclick = () => d.close();
    const od = $('#odel'); if (od) od.onclick = async () => { if (!confirm('削除しますか？')) return; try { await api(`/api/admin/oripas/${o.id}`, { method: 'DELETE' }); d.close(); viewOripa(); } catch (e) { toast(e.message); } };
    $('#of').onsubmit = async e => {
      e.preventDefault();
      const fd = Object.fromEntries(new FormData(e.target));
      const body = { ...fd, id: o?.id, price: locked ? o.price : fd.price, image_url: image, starts_at: fromLocalInput(fd.starts_at), ends_at: fromLocalInput(fd.ends_at), prizes };
      if (body.status === 'live' && prizes.some(p => !p.name)) { toast('賞品名が空の行があります'); return; }
      try { const r = await api('/api/admin/oripas', { method: 'POST', body: JSON.stringify(body) }); d.close(); toast(r.note || '保存しました'); viewOripa(); } catch (err) { toast(err.message); }
    };
  }

  // ─── 会員 ───
  let memberQ = '';
  async function viewMembers() {
    shell('<p class="muted">読み込み中…</p>');
    const r = await api('/api/admin/members?q=' + encodeURIComponent(memberQ));
    $('#body').innerHTML = `
      <div class="toolbar2"><input id="mq" type="search" placeholder="名前・メール・電話で検索" value="${esc(memberQ)}" style="max-width:320px"><span class="small muted">会員 ${r.total.n}人・未使用ポイント合計 ${r.total.points.toLocaleString()}pt</span>
        <button class="btn sm" id="mcsv">CSV書き出し</button></div>
      <div class="panel overflow"><table class="t">
        <tr><th>ID</th><th>お名前</th><th>メール</th><th>電話</th><th>認証</th><th class="num">ポイント</th><th class="num">注文</th><th class="num">購入額</th><th>登録日</th><th></th></tr>
        ${r.members.map(m => `<tr><td>${m.id}</td><td>${esc(m.name)}<br><span class="muted small">${esc(m.kana)}</span></td><td class="small">${esc(m.email)}</td><td class="small">${esc(m.phone)}</td><td class="small">${m.email_verified ? '✉︎' : ''}${m.phone_verified ? ' 📱' : ''}</td><td class="num">${m.points.toLocaleString()}</td><td class="num">${m.orders}</td><td class="num">${yen(m.spent)}</td><td class="small">${jst(m.created_at, { year: 'numeric', month: 'numeric', day: 'numeric' })}</td><td><button class="link" data-m="${m.id}">詳細</button></td></tr>`).join('') || '<tr><td class="muted" colspan="10">会員はまだいません</td></tr>'}
      </table></div>`;
    $('#mq').onchange = e => { memberQ = e.target.value; viewMembers(); };
    $('#mcsv').onclick = () => download(`members_${today()}.csv`, [['ID', 'お名前', 'フリガナ', 'メール', '電話', 'ポイント', '注文数', '購入額', '登録日', '最終ログイン'], ...r.members.map(m => [m.id, m.name, m.kana, m.email, m.phone, m.points, m.orders, m.spent, m.created_at, m.last_login_at || ''])]);
    $$('[data-m]').forEach(b => b.onclick = async () => {
      const x = await api(`/api/admin/members/${b.dataset.m}`);
      const cx = settings?.features?.coins ? await api(`/api/admin/members/${b.dataset.m}/coins`).catch(() => null) : null;
      const d = $('#dlg');
      d.innerHTML = `<form method="dialog" class="form" id="mf"><h2 style="margin:0">${esc(x.customer.name)} 様</h2>
        <p class="small">${esc(x.customer.email)} ／ ${esc(x.customer.phone)}<br>〒${esc(x.customer.zip)} ${esc(x.customer.address)}</p>
        <div class="fs" style="background:var(--bg)"><h3>ポイント ${x.customer.points.toLocaleString()}pt</h3>
          <div class="grid3"><label>増減<input name="delta" type="number" placeholder="+500 / -100"></label><label style="grid-column:span 2">理由<input name="reason" placeholder="お詫び・キャンペーンなど"></label></div>
          <button type="button" class="btn sm primary" id="padj">ポイントを調整</button>
          <div class="overflow" style="max-height:200px"><table class="t">${x.ledger.map(l => `<tr><td class="small">${jst(l.created_at)}</td><td class="small">${esc(l.reason)}</td><td class="num ${l.delta > 0 ? 'ok' : 'danger'}">${l.delta > 0 ? '+' : ''}${l.delta}</td></tr>`).join('')}</table></div></div>
        ${cx ? `<div class="fs" style="background:var(--bg)"><h3>${esc(settings.coin.name)} ${cx.coins.toLocaleString()}　<span class="small muted">獲得カードBOX ${cx.prize_box}枚</span></h3>
          <div class="grid3"><label>増減<input name="cdelta" type="number" placeholder="+500 / -100"></label><label style="grid-column:span 2">理由<input name="creason" placeholder="お詫び・キャンペーンなど（付与分は無償扱い）"></label></div>
          <button type="button" class="btn sm primary" id="cadj">${esc(settings.coin.name)}を調整</button>
          <div class="overflow" style="max-height:200px"><table class="t">${cx.ledger.map(l => `<tr><td class="small">${jst(l.created_at)}</td><td class="small">${esc(l.reason)}</td><td class="num ${l.delta > 0 ? 'ok' : 'danger'}">${l.delta > 0 ? '+' : ''}${l.delta}</td></tr>`).join('')}</table></div></div>` : ''}
        <div class="fs"><h3>注文履歴</h3><table class="t">${x.orders.map(o => `<tr><td class="mono small">${esc(o.order_no)}</td><td class="small">${jst(o.created_at)}</td><td class="small">${STATUS[o.status]}</td><td class="num">${yen(o.total)}</td></tr>`).join('') || '<tr><td class="muted">なし</td></tr>'}</table></div>
        <button class="btn">閉じる</button></form>`;
      d.showModal();
      const ca = $('#cadj');
      if (ca) ca.onclick = async () => {
        const f = $('#mf');
        try { await api(`/api/admin/members/${b.dataset.m}/coins`, { method: 'POST', body: JSON.stringify({ delta: f.cdelta.value, reason: f.creason.value }) }); d.close(); toast('調整しました'); viewMembers(); } catch (e) { toast(e.message); }
      };
      $('#padj').onclick = async () => {
        const f = $('#mf');
        try { await api(`/api/admin/members/${b.dataset.m}/points`, { method: 'POST', body: JSON.stringify({ delta: f.delta.value, reason: f.reason.value }) }); d.close(); toast('ポイントを調整しました'); viewMembers(); } catch (e) { toast(e.message); }
      };
    });
  }

  // ─── クーポン ───
  async function viewCoupons() {
    shell('<p class="muted">読み込み中…</p>');
    const list = await api('/api/admin/coupons');
    $('#body').innerHTML = `
      <form class="panel form" id="cf" style="margin-bottom:12px">
        <b>クーポンを作成・更新</b> <span class="muted small">（オリパには使えません）</span>
        <div class="grid3">
          <label>コード<input name="code" required placeholder="WELCOME10" autocapitalize="characters"></label>
          <label>種類<select name="type" style="width:100%"><option value="percent">％引き</option><option value="amount">円引き</option></select></label>
          <label>値<input name="value" type="number" min="1" required placeholder="10"></label>
          <label>最低購入金額<input name="min_subtotal" type="number" min="0" value="0"></label>
          <label>利用回数の上限（0=無制限）<input name="max_uses" type="number" min="0" value="0"></label>
          <label>有効期限<input name="ends_at" type="datetime-local"></label>
        </div>
        <label>メモ<input name="note" placeholder="Xフォロワー向け など"></label>
        <button class="btn primary">保存</button>
      </form>
      <div class="panel overflow"><table class="t">
        <tr><th>コード</th><th>内容</th><th>条件</th><th class="num">利用</th><th>期限</th><th></th></tr>
        ${list.map(c => `<tr class="${c.active ? '' : 'off'}"><td class="mono"><b>${esc(c.code)}</b><br><span class="muted small">${esc(c.note)}</span></td><td>${c.type === 'percent' ? c.value + '%OFF' : yen(c.value) + '引き'}</td>
          <td class="small">${c.min_subtotal ? yen(c.min_subtotal) + '以上' : '-'}</td><td class="num">${c.used}${c.max_uses ? ' / ' + c.max_uses : ''}</td>
          <td class="small">${c.ends_at ? jst(c.ends_at) : 'なし'}</td><td><button class="link" data-tg="${esc(c.code)}">${c.active ? '停止' : '再開'}</button> <button class="link danger" data-rm="${esc(c.code)}">削除</button></td></tr>`).join('') || '<tr><td class="muted">まだありません</td></tr>'}
      </table></div>`;
    $('#cf').onsubmit = async e => {
      e.preventDefault();
      const b = Object.fromEntries(new FormData(e.target));
      b.ends_at = fromLocalInput(b.ends_at);
      try { await api('/api/admin/coupons', { method: 'POST', body: JSON.stringify(b) }); toast('保存しました'); viewCoupons(); } catch (err) { toast(err.message); }
    };
    $$('[data-rm]').forEach(b => b.onclick = async () => { if (!confirm('削除しますか？')) return; await api(`/api/admin/coupons/${b.dataset.rm}`, { method: 'DELETE' }); viewCoupons(); });
    $$('[data-tg]').forEach(b => b.onclick = async () => { const c = list.find(x => x.code === b.dataset.tg); await api('/api/admin/coupons', { method: 'POST', body: JSON.stringify({ ...c, active: c.active ? 0 : 1, ends_at: c.ends_at ? new Date(c.ends_at.replace(' ', 'T') + 'Z').toISOString() : '' }) }); viewCoupons(); });
  }

  const ACTIONS = [[/^PUT settings/, '設定を変更'], [/^POST products\/import/, 'CSVを読み込み'], [/^POST products\/\d+\/stock/, '在庫を増減'], [/^PUT products/, '商品を編集'], [/^POST products/, '商品を追加'], [/^DELETE products/, '商品を削除'],
    [/^POST images/, '画像をアップロード'], [/^PUT orders/, '注文を更新'], [/^POST oripas/, 'オリパを保存'], [/^DELETE oripas/, 'オリパを削除'], [/^POST coupons/, 'クーポンを保存'], [/^DELETE coupons/, 'クーポンを削除'], [/^POST members\/\d+\/points/, 'ポイントを調整']];
  const actionLabel = s => { const hit = ACTIONS.find(([re]) => re.test(s)); return hit ? `${hit[1]}（${s}）` : s; };

  // ─── 設定 ───
  const FEATURE_LABELS = [
    ['members', '会員登録・ログイン', 'マイページ・注文履歴・住所の保存'],
    ['points', 'ポイント制度', '会員登録が必要です'],
    ['oripa', 'オリパ', '口数・封入数を公開する抽選販売'],
    ['coins', 'オリパをコインで引く', 'コインを購入 → その場で抽選 → 当選品は発送依頼。OFFなら注文ごとに購入'],
    ['guestCheckout', '会員登録なしで購入', 'オフにすると購入にログインが必要'],
    ['coupons', 'クーポン', ''],
    ['deck', 'デッキリスト一括購入', ''],
    ['groupVariants', '一覧で状態違いをまとめる', '「A・B・PSA10／¥9,800〜」のように1件で表示'],
    ['siblings', '商品ページで状態を切り替え', ''],
    ['favorites', 'お気に入り', ''],
    ['ranking', '売れ筋ランキング', ''],
    ['saleStrip', '値下げ・セール欄', ''],
    ['recent', '最近チェックした商品', ''],
    ['priceHistory', '価格推移グラフ', ''],
    ['buyback', '買取価格の表示', '商品ページに「このカードを売る」'],
    ['restock', '入荷通知メール', 'メール送信の設定が必要'],
    ['phoneVerify', '電話番号（SMS）認証', 'Twilio の設定が必要。1回20円前後'],
    ['shipbar', '即日発送カウントダウン', ''],
    ['bankPayment', '銀行振込', ''],
    ['cardPayment', 'カード決済', 'STRIPE_SECRET_KEY が必要'],
  ];
  async function viewSettings() {
    shell('<p class="muted">読み込み中…</p>');
    const r = await api('/api/admin/settings');
    const s = settings = r.settings;
    const inp = (name, label, val, type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${esc(val)}" ${extra}></label>`;
    const ta = (name, label, val, rows = 3) => `<label>${label}<textarea name="${name}" rows="${rows}">${esc(val)}</textarea></label>`;
    $('#body').innerHTML = `
      <form id="sf">
        <div class="fs"><h3>接続状況</h3><div class="envs">
          <span class="${r.env.stripe ? 'on' : ''}">Stripe ${r.env.stripe ? '接続済み' : '未設定'}</span><span class="${r.env.webhook ? 'on' : ''}">Stripe Webhook ${r.env.webhook ? 'OK' : '未設定'}</span>
          <span class="${r.env.mail ? 'on' : ''}">メール送信 ${r.env.mail ? 'OK' : '未設定'}</span><span class="${r.env.sms ? 'on' : ''}">SMS認証 ${r.env.sms ? 'OK' : '未設定'}</span><span class="${r.env.totp ? 'on' : ''}">管理画面の2段階認証 ${r.env.totp ? 'OK' : '未設定'}</span><span class="${r.env.r2 ? 'on' : ''}">画像 ${r.env.r2 ? 'R2' : 'D1に保存'}</span></div>
          <p class="hint2">これらは秘密の値なので Cloudflare 側（wrangler secret）で設定します。README 参照。</p></div>

        <div class="fs"><h3>機能のON / OFF</h3><div class="feat">
          ${FEATURE_LABELS.map(([k, l, h]) => `<label><input type="checkbox" name="f_${k}" ${s.features[k] ? 'checked' : ''}><span style="color:inherit;font-size:13.5px;font-weight:600">${l}<span>${h}</span></span></label>`).join('')}
        </div></div>

        <div class="fs"><h3>ショップ基本情報・見た目</h3>
          <div class="grid3">${inp('shopName', 'ショップ名', s.shopName)}${inp('logoText', 'ロゴの文字（2〜3文字）', s.logoText, 'text', 'maxlength="4"')}<label>テーマカラー<input name="accentColor" type="color" value="${esc(s.accentColor)}" style="height:44px"></label></div>
          ${inp('tagline', 'キャッチコピー（ページタイトル）', s.tagline)}
          <div class="grid2">${inp('notice', 'お知らせバナー（空なら非表示）', s.notice)}${inp('noticeLink', 'お知らせのリンク先（任意）', s.noticeLink)}</div>
          <div class="grid2">${inp('kobutsu', '古物商許可', s.kobutsu)}${inp('buybackUrl', '買取フォームのURL', s.buybackUrl, 'url')}</div>
        </div>

        <div class="fs"><h3>送料・発送</h3>
          <div class="grid3">${inp('shippingFee', '送料（円）', s.shippingFee, 'number')}${inp('freeShippingOver', '送料無料になる金額', s.freeShippingOver, 'number')}${inp('shipCutoffHour', '当日発送の締め時刻（時）', s.shipCutoffHour, 'number', 'min="0" max="24"')}</div>
          <div><span class="small"><b>発送する曜日</b></span><div class="chips wrap">${'日月火水木金土'.split('').map((d, i) => `<label class="chip ck"><input type="checkbox" name="shipDays" value="${i}" ${s.shipDays.includes(i) ? 'checked' : ''}>${d}</label>`).join('')}</div></div>
          <label class="check"><input type="checkbox" name="pickupEnabled" ${s.pickupEnabled ? 'checked' : ''}> 店頭受け取り（送料無料）を選べるようにする</label>
          ${ta('pickupInfo', '店頭受け取りの案内（住所・営業時間など）', s.pickupInfo, 2)}
          ${inp('maxQtyPerItem', '1商品あたりの購入上限', s.maxQtyPerItem, 'number')}
        </div>

        <div class="fs"><h3>お支払い</h3>
          ${ta('bankInfo', '振込先（お客様に表示されます）', s.bankInfo, 3)}
          ${inp('paymentDays', '振込の支払期限（日）', s.paymentDays, 'number', 'min="1" max="30"')}
        </div>

        <div class="fs"><h3>ポイント</h3>
          <div class="grid3">${inp('p_rate', '還元率（%）', s.points.rate, 'number', 'min="0" max="100"')}${inp('p_signupBonus', '新規登録ボーナス（pt）', s.points.signupBonus, 'number')}${inp('p_expireDays', '有効期限（最終利用から日数・0=無期限）', s.points.expireDays, 'number')}
            ${inp('p_minUse', '1回に使える最小ポイント', s.points.minUse, 'number')}
            <label>付与タイミング<select name="p_grantOn" style="width:100%"><option value="shipped" ${s.points.grantOn === 'shipped' ? 'selected' : ''}>発送したとき</option><option value="paid" ${s.points.grantOn === 'paid' ? 'selected' : ''}>入金確認したとき</option></select></label></div>
          <label class="check"><input type="checkbox" name="p_oripaEarn" ${s.points.oripaEarn ? 'checked' : ''}> オリパ購入分にもポイントを付与する（注文で買う方式のときのみ）</label>
          <label class="check"><input type="checkbox" name="p_oripaUse" ${s.points.oripaUse ? 'checked' : ''}> オリパの支払いにポイントを使えるようにする（注文で買う方式のときのみ）</label>
          <p class="hint2">※オリパとポイントを循環させる仕組みは換金性が問題視されています。オフのままを推奨します。コイン方式ではポイントとコインは別物で、行き来できません。</p>
        </div>

        <div class="fs"><h3>コイン（オリパ用）</h3>
          <div class="grid3">${inp('c_name', '名前', s.coin.name)}${inp('c_expireMonths', '有効期限（購入から何か月・0=無期限）', s.coin.expireMonths, 'number', 'min="0" max="120"')}${inp('c_shipFee', '当選品の発送料（コイン・0=無料）', s.coin.shipFee, 'number', 'min="0"')}</div>
          <p class="hint2">有効期限を6か月以内にしておくと、資金決済法の「前払式支払手段」に当たらず、届出や供託が不要です。6か月を超える・無期限にする場合は、3月末・9月末の未使用残高が1,000万円を超えたら財務局への届出と残高の半額の供託が必要になります（ダッシュボードで残高を確認できます）。当選カードをコインに戻す機能はありません。</p>
          <b class="small">購入パック（価格 → 付与するコイン）</b>
          <div class="rows" id="packs">${s.coin.packs.map(p => `<div class="r"><input data-pp type="number" value="${p.price}" placeholder="価格（円）"><input data-pc type="number" value="${p.coins}" placeholder="付与コイン"><button type="button" class="link danger" data-x>削除</button></div>`).join('')}</div>
          <button type="button" class="btn sm" id="addpack">＋ パックを追加</button>
        </div>

        <div class="fs"><h3>電話番号（SMS）認証</h3>
          <p class="hint2">「機能のON / OFF」で電話番号認証をONにし、Twilio を設定すると有効になります。1つの電話番号は1アカウントだけ。日本の携帯番号（070/080/090）のみ受け付けます。</p>
          <label class="check"><input type="checkbox" name="ph_forBonus" ${s.phone.forBonus ? 'checked' : ''}> 登録ボーナスは電話番号認証の後に付与する（複数アカウントでのボーナス取得を防ぐ）</label>
          <label class="check"><input type="checkbox" name="ph_forOripa" ${s.phone.forOripa ? 'checked' : ''}> オリパの購入に電話番号認証を必須にする</label>
        </div>

        <div class="fs"><h3>オリパ</h3>
          <label class="check"><input type="checkbox" name="o_requireLogin" ${s.oripa.requireLogin ? 'checked' : ''}> オリパの購入に会員登録を必須にする</label>
          <label class="check"><input type="checkbox" name="o_showRecent" ${s.oripa.showRecent ? 'checked' : ''}> 販売ページに「最近の当選」を表示する</label>
          <p class="hint2">お客様には賞ごとの封入数と総残り口数だけを表示し、賞ごとの残り数は表示しません（この管理画面でのみ確認できます）。</p>
          ${inp('o_maxPerOrder', '1注文の上限口数（全オリパ共通の上限）', s.oripa.maxPerOrder, 'number')}
          ${ta('o_notice', '注意事項（販売ページ・購入時の同意文）', s.oripa.notice, 2)}
          ${inp('o_ageNotice', '年齢の注意書き', s.oripa.ageNotice)}
        </div>

        <div class="fs"><h3>カテゴリ</h3><p class="hint2">キーは英小文字・数字（CSVの「カテゴリ」に使えます）。商品が1件もないカテゴリはショップに表示されません。</p>
          <div class="rows" id="cats">${s.categories.map(c => `<div class="r"><input data-ck value="${esc(c.key)}" placeholder="single"><input data-cl value="${esc(c.label)}" placeholder="シングル"><button type="button" class="link danger" data-x>削除</button></div>`).join('')}</div>
          <button type="button" class="btn sm" id="addcat">＋ カテゴリを追加</button></div>

        <div class="fs"><h3>状態表記の説明</h3>
          <div class="rows" id="conds">${s.condGuide.map(([k, v]) => `<div class="r"><input data-gk value="${esc(k)}" placeholder="A"><input data-gv value="${esc(v)}" placeholder="説明"><button type="button" class="link danger" data-x>削除</button></div>`).join('')}</div>
          <button type="button" class="btn sm" id="addcond">＋ 追加</button></div>

        <div class="fs"><h3>特定商取引法に基づく表記</h3>
          <div class="grid2">${inp('l_seller', '販売業者', s.legal.seller)}${inp('l_manager', '運営統括責任者', s.legal.manager)}${inp('l_phone', '電話番号', s.legal.phone)}${inp('l_hours', '受付時間', s.legal.hours)}${inp('l_email', 'メールアドレス', s.legal.email, 'email')}</div>
          ${inp('l_address', '所在地', s.legal.address)}
          ${ta('l_delivery', '商品の引渡し時期（空なら発送設定から自動）', s.legal.delivery, 2)}
          ${ta('l_returns', '返品・交換について', s.legal.returns, 3)}
          ${ta('l_extra', 'その他', s.legal.extra, 2)}
        </div>
        <div class="savebar"><a class="btn" href="legal.html" target="_blank">特商法ページを確認 ↗</a><button class="btn primary">設定を保存</button></div>
      </form>
      <details class="fs"><summary><b>管理画面の操作履歴（直近200件）</b></summary><div id="alog" class="overflow" style="max-height:320px"><p class="muted small">読み込み中…</p></div></details>`;
    api('/api/admin/log').then(rows => { $('#alog').innerHTML = `<table class="t">${rows.map(l => `<tr><td class="small">${jst(l.at)}</td><td class="small mono">${esc(l.ip)}</td><td class="small ${l.action === 'ログイン失敗' ? 'danger' : ''}">${esc(actionLabel(l.action))}</td></tr>`).join('')}</table>`; }).catch(() => {});
    const rowHtml = (a, b) => `<div class="r"><input ${a} value=""><input ${b} value=""><button type="button" class="link danger" data-x>削除</button></div>`;
    const bindX = () => $$('[data-x]').forEach(b => b.onclick = () => b.closest('.r').remove());
    bindX();
    $('#addcat').onclick = () => { $('#cats').insertAdjacentHTML('beforeend', rowHtml('data-ck placeholder="key"', 'data-cl placeholder="表示名"')); bindX(); };
    $('#addpack').onclick = () => { $('#packs').insertAdjacentHTML('beforeend', `<div class="r"><input data-pp type="number" placeholder="価格（円）"><input data-pc type="number" placeholder="付与コイン"><button type="button" class="link danger" data-x>削除</button></div>`); bindX(); };
    $('#addcond').onclick = () => { $('#conds').insertAdjacentHTML('beforeend', rowHtml('data-gk placeholder="状態"', 'data-gv placeholder="説明"')); bindX(); };
    $('#sf').onsubmit = async e => {
      e.preventDefault();
      const f = e.target, fd = new FormData(f), g = n => fd.get(n);
      const body = {
        ...s,
        shopName: g('shopName'), logoText: g('logoText'), accentColor: g('accentColor'), tagline: g('tagline'), notice: g('notice'), noticeLink: g('noticeLink'),
        kobutsu: g('kobutsu'), buybackUrl: g('buybackUrl'), shippingFee: g('shippingFee'), freeShippingOver: g('freeShippingOver'), shipCutoffHour: g('shipCutoffHour'),
        shipDays: fd.getAll('shipDays').map(Number), pickupEnabled: !!g('pickupEnabled'), pickupInfo: g('pickupInfo'), maxQtyPerItem: g('maxQtyPerItem'),
        bankInfo: g('bankInfo'), paymentDays: g('paymentDays'),
        features: Object.fromEntries(FEATURE_LABELS.map(([k]) => [k, !!g('f_' + k)])),
        points: { rate: g('p_rate'), signupBonus: g('p_signupBonus'), expireDays: g('p_expireDays'), minUse: g('p_minUse'), grantOn: g('p_grantOn'), oripaEarn: !!g('p_oripaEarn'), oripaUse: !!g('p_oripaUse') },
        phone: { forBonus: !!g('ph_forBonus'), forOripa: !!g('ph_forOripa') },
        coin: { name: g('c_name'), expireMonths: g('c_expireMonths'), shipFee: g('c_shipFee'), packs: $$('#packs .r').map(r => ({ price: $('[data-pp]', r).value, coins: $('[data-pc]', r).value })).filter(p => p.price && p.coins) },
        oripa: { requireLogin: !!g('o_requireLogin'), showRecent: !!g('o_showRecent'), maxPerOrder: g('o_maxPerOrder'), notice: g('o_notice'), ageNotice: g('o_ageNotice') },
        categories: $$('#cats .r').map(r => ({ key: $('[data-ck]', r).value, label: $('[data-cl]', r).value })).filter(c => c.key && c.label),
        condGuide: $$('#conds .r').map(r => [$('[data-gk]', r).value, $('[data-gv]', r).value]).filter(x => x[0]),
        legal: { seller: g('l_seller'), manager: g('l_manager'), address: g('l_address'), phone: g('l_phone'), hours: g('l_hours'), email: g('l_email'), delivery: g('l_delivery'), returns: g('l_returns'), extra: g('l_extra') },
      };
      try { const r2 = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) }); settings = r2.settings; toast('設定を保存しました'); viewSettings(); }
      catch (err) { toast(err.message); }
    };
  }

  async function render() {
    if (!key) { $('#logout').hidden = true; return viewLogin(); }
    $('#logout').hidden = false;
    try {
      if (!settings) settings = (await api('/api/admin/settings')).settings;
      await ({ dash: viewDash, orders: viewOrders, products: viewProducts, csv: viewCsv, oripa: viewOripa, members: viewMembers, coupons: viewCoupons, settings: viewSettings }[tab] || viewDash)();
    } catch (e) { if (key) app.innerHTML = `<p class="danger pad center">${esc(e.message)}</p>`; }
  }
  render();
})();
