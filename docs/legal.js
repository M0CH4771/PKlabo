(async () => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = n => '¥' + Number(n).toLocaleString('ja-JP');
  const todo = s => `<span class="todo">${s}</span>`;
  const v = (x, label) => x ? esc(x) : todo(`【管理画面の「設定 → 特定商取引法」で${label}を入力してください】`);
  let c;
  try { c = await fetch(window.PKLABO.API_BASE.replace(/\/$/, '') + '/api/config').then(r => r.json()); }
  catch { document.getElementById('doc').innerHTML = '<p>読み込みに失敗しました</p>'; return; }
  const L = c.legal;
  document.documentElement.style.setProperty('--accent', c.accentColor);
  document.getElementById('sn').textContent = c.shopName;
  document.getElementById('lm').textContent = c.logoText || 'PK';
  document.title = `特定商取引法に基づく表記｜${c.shopName}`;
  const pays = [c.cardEnabled && 'クレジットカード（Stripe）', c.bankEnabled && '銀行振込（前払い）', c.features.points && 'ポイント（1pt＝1円）', c.features.coins && `${c.coin.name}（オリパのみ）`].filter(Boolean).join('、');
  const days = c.shipDays.map(d => '日月火水木金土'[d]).join('・');
  document.getElementById('doc').innerHTML = `
    <h1>特定商取引法に基づく表記</h1>
    <dl>
      <dt>販売業者</dt><dd>${v(L.seller, '販売業者')}</dd>
      <dt>運営統括責任者</dt><dd>${v(L.manager, '責任者名')}</dd>
      <dt>所在地</dt><dd>${v(L.address, '所在地')}</dd>
      <dt>電話番号</dt><dd>${v(L.phone, '電話番号')}${L.hours ? `（受付時間 ${esc(L.hours)}）` : ''}</dd>
      <dt>メールアドレス</dt><dd>${v(L.email, 'メールアドレス')}</dd>
      ${c.kobutsu ? `<dt>古物商許可</dt><dd>${esc(c.kobutsu)}</dd>` : ''}
      <dt>販売価格</dt><dd>各商品ページに税込価格で表示しています。</dd>
      <dt>商品代金以外の必要料金</dt><dd>送料：全国一律 ${yen(c.shippingFee)}（${yen(c.freeShippingOver)}以上のご注文で送料無料${c.pickupEnabled ? '。店頭受け取りの場合は無料' : ''}）\n銀行振込の場合の振込手数料はお客様のご負担となります。</dd>
      <dt>お支払い方法</dt><dd>${esc(pays)}</dd>
      <dt>お支払い時期</dt><dd>${c.bankEnabled ? `銀行振込：ご注文から${c.paymentDays}日以内にお振込みください。期限を過ぎた場合は自動的にキャンセルとなります。\n` : ''}${c.cardEnabled ? 'クレジットカード：ご注文時に決済されます。' : ''}</dd>
      <dt>商品の引渡し時期</dt><dd>${L.delivery ? esc(L.delivery) : `${days}曜日に発送しています。${c.shipCutoffHour}時までにカード決済・ご入金確認ができたご注文は当日、それ以降は翌発送日に発送いたします。`}${c.pickupEnabled ? '\n店頭受け取りの場合は、準備ができ次第メールでお知らせします。' : ''}</dd>
      <dt>返品・交換について</dt><dd>${esc(L.returns)}</dd>
      ${L.extra ? `<dt>その他</dt><dd>${esc(L.extra)}</dd>` : ''}
    </dl>

    <h2 id="policy">ご注文・キャンセルについて</h2>
    <ul>
      <li>シングルカードは一点ものが多いため、ご注文確定時点で在庫を確保します。</li>
      <li>入金期限を過ぎたご注文は自動でキャンセルとなり、在庫は再販売されます。</li>
      <li>ご入金後のお客様都合によるキャンセルはお受けできません。</li>
      <li>商品の状態表記は当店基準です。</li>
      <li>転売目的と判断した場合や、不正な決済が疑われる場合はご注文をお断りすることがあります。</li>
    </ul>
    ${c.features.oripa ? `<h2 id="oripa">オリパについて</h2><ul>
      <li>${esc(c.oripa.notice)}</li><li>${esc(c.oripa.ageNotice)}</li>
      <li>総口数・${c.oripa.showQty ? '賞ごとの封入数・' : '賞品の内容・'}全体の残り口数は販売ページで公開しています。販売開始後に封入内容を変更することはありません。</li>
      ${c.features.coins ? `<li>オリパは${esc(c.coin.name)}で引き、結果はその場で表示されます。当選したカードはマイページの「獲得カード」から発送を依頼してください（実物の発送のみ）。</li>` : '<li>抽選はご注文時に行い、ご入金確認後に結果を開封できます。ご注文がキャンセル・期限切れとなった場合、抽選結果は無効となり山に戻ります。</li>'}</ul>` : ''}
    ${c.features.coins ? `<h2 id="coin">${esc(c.coin.name)}について</h2>
    <dl>
      <dt>名称</dt><dd>${esc(c.coin.name)}</dd>
      <dt>発行者</dt><dd>${v(L.seller, '販売業者')}</dd>
      <dt>使える場所</dt><dd>当サイトのオリパ（1${esc(c.coin.name)}＝1円相当）</dd>
      <dt>有効期限</dt><dd>${c.coin.expireMonths ? `付与から${c.coin.expireMonths}か月。期限を過ぎた${esc(c.coin.name)}は失効します。残高と期限はマイページで確認できます。` : '有効期限はありません。'}</dd>
      <dt>払い戻し</dt><dd>購入した${esc(c.coin.name)}の払い戻し・換金はできません（法令で定める場合を除く）。当選したカードを${esc(c.coin.name)}や現金に交換することもできません。</dd>
      <dt>お問い合わせ</dt><dd>${v(L.email, 'メールアドレス')}</dd>
    </dl>` : ''}
    ${c.features.points ? `<h2 id="points">ポイントについて</h2><ul>
      <li>会員登録で${c.points.signupBonus}ポイント、お買い物金額（送料・ポイント利用分を除く）の${c.points.rate}%を${c.points.grantOn === 'paid' ? '入金確認時' : '発送時'}に付与します。</li>
      <li>1ポイント＝1円として次回以降のお買い物にご利用いただけます。現金への交換はできません。</li>
      ${c.points.expireDays ? `<li>最後にポイントが増減した日から${c.points.expireDays}日間ご利用がない場合、ポイントは失効します。</li>` : ''}
      <li>ご注文がキャンセルとなった場合、利用したポイントは返却し、付与したポイントは取り消します。</li></ul>` : ''}

    <h2 id="privacy">プライバシーポリシー</h2>
    <p>当店は、ご注文・会員登録時にお預かりした氏名・住所・電話番号・メールアドレスを、商品の発送、ご注文・会員サービスに関するご連絡のためにのみ利用します。法令に基づく場合を除き、ご本人の同意なく第三者に提供することはありません。ただし、商品の配送のため配送業者に、決済処理のため決済代行会社（Stripe）に必要な範囲で提供します。</p>
    <p>個人情報の開示・訂正・削除のご依頼は、上記メールアドレスまでご連絡ください。会員の方はマイページから退会（会員情報の削除）ができます。</p>`;
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
})();
