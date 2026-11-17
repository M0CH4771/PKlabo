// オリパの開封演出（ショップと管理画面の試し引きで共通）
// パックを破る → カードが出てくる → 「自動でめくる」か「自分でめくる」を選ぶ
// B賞以上は中央で大きくなり、青 → 赤（A賞）→ 金（S賞）→ 虹（SS賞）と段階的に「昇格」してからめくれる。
// どの段階でも止まるまでの間は同じ長さなので、どこまで行くかは最後まで分からない
(() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* 保存できない環境 */ } },
  };
  const reduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── 効果音（ファイルを使わずブラウザで合成） ──
  let ac = null;
  const soundOn = () => store.get('pk_sound', '1') === '1';
  function audio() {
    if (!soundOn()) return null;
    try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === 'suspended') ac.resume(); return ac; } catch { return null; }
  }
  function tone(freq, at, dur, type = 'triangle', vol = 0.12) {
    const a = audio(); if (!a) return;
    const t = a.currentTime + at, o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur + 0.05);
  }
  function noise(at, dur, vol = 0.18, freq = 2400) {
    const a = audio(); if (!a) return;
    const len = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain(), t = a.currentTime + at;
    f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.8; g.gain.value = vol;
    s.buffer = buf; s.connect(f).connect(g).connect(a.destination); s.start(t);
  }
  const sfx = {
    tear() { noise(0, 0.32, 0.22, 3200); noise(0.08, 0.2, 0.12, 1800); },
    slide() { noise(0, 0.25, 0.07, 1200); },
    deal() { noise(0, 0.05, 0.06, 5000); },
    flip() { noise(0, 0.06, 0.12, 4200); tone(880, 0, 0.08, 'sine', 0.04); },
    // 溜め：段階が上がるほど高く速く
    charge(lv) { for (let k = 0; k < 5; k++) tone(330 * Math.pow(1.26, lv - 1) * (1 + k * 0.06), k * 0.17, 0.12, 'square', 0.03); },
    // 昇格の瞬間
    up(lv) { noise(0, 0.35, 0.16, 900 + lv * 500); const b = [392, 523, 659, 784][lv - 1] || 784; [b, b * 1.25, b * 1.5, b * 2].forEach((f, i) => tone(f, i * 0.05, 0.3, 'triangle', 0.08)); },
    reveal(lv) {
      if (lv <= 1) { [784, 988, 1175].forEach((f, i) => tone(f, i * 0.06, 0.3, 'triangle', 0.07)); return; }
      if (lv === 2) { [659, 784, 988, 1319].forEach((f, i) => tone(f, i * 0.07, 0.4, 'triangle', 0.09)); return; }
      [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.5, 'triangle', 0.1));
      [1047, 1319, 1568].forEach(f => tone(f, 0.42, 1.4, 'sawtooth', 0.035));
      [523, 659, 784].forEach(f => tone(f, 0.42, 1.4, 'triangle', 0.08));
      if (lv >= 4) [2093, 2637, 3136, 2637, 3136, 4186].forEach((f, i) => tone(f, 0.9 + i * 0.08, 0.25, 'sine', 0.05));
    },
  };

  // ── 紙吹雪 ──
  function confetti(canvas, x, y, power) {
    const c = canvas.getContext('2d'), dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = power === 'rainbow' ? ['#ff3b5c', '#ff9f1a', '#ffe14d', '#3ddc84', '#2fb7ff', '#8a5cff', '#ffffff'] : ['#e3262f', '#ffe14d', '#ffffff', '#1f4e99', '#ffb800'];
    if (power === 'rainbow') power = 'big';
    const n = power === 'big' ? 160 : 50;
    const parts = Array.from({ length: n }, () => {
      const a = Math.random() * Math.PI * 2, v = (power === 'big' ? 7 : 4.5) * (0.4 + Math.random());
      return { x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (power === 'big' ? 6 : 3), w: 5 + Math.random() * 6, h: 3 + Math.random() * 4, r: Math.random() * 6, vr: (Math.random() - .5) * .4, col: colors[Math.floor(Math.random() * colors.length)], life: 0 };
    });
    canvas._parts = (canvas._parts || []).concat(parts);
    if (canvas._run) return;
    canvas._run = true;
    const step = () => {
      c.clearRect(0, 0, innerWidth, innerHeight);
      canvas._parts = canvas._parts.filter(p => p.life < 170 && p.y < innerHeight + 40);
      for (const p of canvas._parts) {
        p.life++; p.vy += 0.16; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
        c.save(); c.translate(p.x, p.y); c.rotate(p.r); c.globalAlpha = Math.max(0, 1 - p.life / 170);
        c.fillStyle = p.col; c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.life / 6))); c.restore();
      }
      if (canvas._parts.length && canvas.isConnected) requestAnimationFrame(step); else { canvas._run = false; c.clearRect(0, 0, innerWidth, innerHeight); }
    };
    requestAnimationFrame(step);
  }

  // 演出の段階（0=なし 1=青 2=赤 3=金 4=虹）。サーバーと同じ決め方（管理画面の試し引き用）
  function fxLevel(p, { total, max, min }) {
    if (p.fx !== null && p.fx !== undefined && p.fx !== '' && p.fx !== 'auto') return Math.max(0, Math.min(4, Number(p.fx) || 0));
    const r = String(p.rank || '').normalize('NFKC').toUpperCase().replace(/\s/g, '');
    if (/^SS/.test(r) || /^(SSR|UR)/.test(r)) return 4;
    if (/^S/.test(r)) return 3;
    if (/^A/.test(r)) return 2;
    if (/^B/.test(r)) return 1;
    if (p.is_last_one) return 3;
    if (/^[C-Z]/.test(r)) return 0;
    const v = +p.value || 0;
    if (max > min && v === max) return 3;
    if (v > min && ((+p.qty || 0) / total <= 0.2 || v >= min * 3)) return 2;
    return 0;
  }
  function tiers(prizes) {
    const t = new Map();
    const pool = prizes.filter(p => !p.is_last_one);
    const total = pool.reduce((s, p) => s + (+p.qty || 0), 0) || 1;
    const vals = pool.map(p => +p.value || 0);
    const max = Math.max(0, ...vals), min = Math.min(...vals);
    for (const p of prizes) t.set(p, fxLevel(p, { total, max, min }));
    return t;
  }

  const lvOf = d => Math.max(0, Math.min(4, Number(d.fx) || 0));
  const label = d => d.is_last_one ? 'ラストワン賞' : (d.rank || '');
  const backHtml = (logo, slot) => `<div class="op-back"><i class="op-frame"></i><span class="op-emb"><b>${esc(logo)}</b></span>${slot ? `<em class="op-no">${slot}番</em>` : ''}</div>`;

  function cardHtml(d, i, logo) {
    return `<div class="op-card fx-${lvOf(d)}" data-i="${i}"><div class="op-in">
      ${backHtml(logo, d.slot)}
      <div class="op-front">${d.image_url ? `<img src="${esc(d.image_url)}" alt="">` : '<div class="op-noimg"></div>'}
        <span class="op-rank">${esc(label(d))}</span><b>${esc(d.name)}</b>${d.slot ? `<em class="op-no">${d.slot}番</em>` : ''}</div>
    </div></div>`;
  }

  // draws: [{ rank, name, image_url, is_last_one, tier, slot }]
  // opts: { title, logo, shop, sub, actions: [{ key, label, primary }], onAction(key, close) }
  function play(draws, opts = {}) {
    const logo = opts.logo || 'PK';
    let skip = reduced();
    const n = draws.filter(d => !d.is_last_one).length;
    const ov = document.createElement('div');
    ov.className = 'op-ov';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', '開封結果');
    ov.innerHTML = `
      <canvas class="op-fx" aria-hidden="true"></canvas>
      <div class="op-bar"><b>${esc(opts.title || '')}</b><span>
        <button type="button" class="op-btn" data-snd>${soundOn() ? '音：あり' : '音：なし'}</button>
        <button type="button" class="op-btn" data-skip>スキップ</button></span></div>
      <div class="op-stage">
        <div class="op-glow" aria-hidden="true"></div>
        <div class="op-pack" aria-hidden="true">
          <div class="op-stack"><div class="op-sc"></div><div class="op-sc"></div><div class="op-sc"></div></div>
          <div class="op-crimp top"></div>
          <div class="op-perf"><span>ここから開けてください</span></div>
          <div class="op-pack-body">
            <span class="op-pack-sub">${esc(opts.shop || '')}オリジナルパック</span>
            <span class="op-pack-logo">${esc(logo)}</span>
            <small>${esc(opts.title || '')}</small>
            <em>${n}口${draws.some(d => d.is_last_one) ? '＋ラストワン賞' : ''}</em>
          </div>
          <div class="op-crimp bottom"></div>
        </div>
        <p class="op-hint">タップして開封</p>
      </div>
      <div class="op-grid ${draws.length === 1 ? 'one' : draws.length <= 3 ? 'few' : ''}" hidden>${draws.map((d, i) => cardHtml(d, i, logo)).join('')}</div>
      <div class="op-spot" hidden></div>
      <div class="op-choose op-dock" hidden>
        <p>めくり方を選んでください</p>
        <div class="op-acts"><button type="button" class="btn" data-mode="manual">自分でめくる</button><button type="button" class="btn primary" data-mode="auto">自動でめくる</button></div>
      </div>
      <div class="op-manual op-dock" hidden><p>カードをタップしてめくってください</p><div class="op-acts"><button type="button" class="btn" data-rest>残りを自動でめくる</button></div></div>
      <div class="op-foot op-dock" hidden>
        ${opts.sub ? `<p>${opts.sub}</p>` : ''}
        <div class="op-acts">${(opts.actions || [{ key: 'close', label: '閉じる', primary: true }]).map(a => `<button type="button" class="btn ${a.primary ? 'primary' : ''}" data-act="${esc(a.key)}">${esc(a.label)}</button>`).join('')}</div>
      </div>`;
    // モーダルの小窓（管理画面の試し引きなど）が開いていたら、その上に出す
    ([...document.querySelectorAll('dialog[open]')].pop() || document.body).appendChild(ov);
    document.documentElement.classList.add('op-lock');
    const fx = ov.querySelector('.op-fx');
    const $ = s => ov.querySelector(s);
    let wake = null, chooseResolve = null, manualDone = null;
    const onKey = e => { if (e.key === 'Escape') doSkip(); };
    const close = () => { ov.remove(); document.documentElement.classList.remove('op-lock'); document.removeEventListener('keydown', onKey); };
    const sleep = ms => new Promise(r => { if (skip) return r(); const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
    const waitTap = (ms, area) => new Promise(r => {
      if (skip) return r();
      const el = area || ov;
      const done = () => { clearTimeout(t); el.removeEventListener('click', h); r(); };
      const h = e => { if (!e.target.closest('.op-bar')) done(); };
      const t = ms ? setTimeout(done, ms) : 0;
      el.addEventListener('click', h);
      wake = done;
    });
    const doSkip = () => {
      skip = true;
      if (wake) wake();
      if (chooseResolve) chooseResolve('auto');
      if (manualDone) manualDone();
    };
    $('[data-snd]').onclick = e => { const on = !soundOn(); store.set('pk_sound', on ? '1' : '0'); e.target.textContent = on ? '音：あり' : '音：なし'; };
    $('[data-skip]').onclick = doSkip;
    ov.querySelectorAll('[data-act]').forEach(b => b.onclick = () => (opts.onAction || (() => close()))(b.dataset.act, close));
    document.addEventListener('keydown', onKey);

    const cards = () => [...ov.querySelectorAll('.op-grid .op-card')];
    const finish = () => {
      cards().forEach(c => c.classList.add('flip'));
      $('[data-skip]').hidden = true;
      $('.op-choose').hidden = true;
      $('.op-manual').hidden = true;
      $('.op-grid').classList.remove('tap');
      $('.op-foot').hidden = false;
      $('.op-foot .btn')?.focus();
    };

    // 1枚めくる（B賞以上は中央で昇格演出）
    let busy = false;
    async function reveal(i) {
      const c = cards()[i];
      if (!c || c.classList.contains('flip')) return;
      if (skip) { c.classList.add('flip', 'shown'); return; }
      busy = true;
      c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (!lvOf(draws[i])) { c.classList.add('flip', 'shown'); sfx.flip(); }
      else await spotlight(draws[i], c);
      busy = false;
    }
    const allOpen = () => cards().every(c => c.classList.contains('flip'));
    const autoRest = async () => {
      const order = cards().map((c, i) => i).filter(i => !cards()[i].classList.contains('flip'))
        .sort((a, b) => lvOf(draws[a]) - lvOf(draws[b]) || a - b);
      const normals = order.filter(i => !lvOf(draws[i])).length;
      for (const i of order) { await reveal(i); if (!lvOf(draws[i])) await sleep(normals > 6 ? 90 : 170); }
    };

    (async () => {
      // 1. パックを破って、中のカードを引き出す
      $('.op-pack').classList.add('in');
      await waitTap(0, $('.op-stage'));
      $('.op-hint').hidden = true;
      if (!skip) {
        sfx.tear(); $('.op-pack').classList.add('torn');
        await sleep(450);
        sfx.slide(); $('.op-pack').classList.add('out');
        await sleep(750);
      }
      $('.op-stage').hidden = true;

      // 2. 配る
      const grid = $('.op-grid');
      grid.hidden = false;
      if (!skip) {
        cards().forEach((c, i) => { c.style.setProperty('--d', `${Math.min(i, 20) * 55}ms`); c.classList.add('deal'); });
        for (let i = 0; i < Math.min(cards().length, 8); i++) setTimeout(() => !skip && sfx.deal(), i * 55);
        await sleep(Math.min(cards().length, 20) * 55 + 450);
      }
      if (skip) { finish(); return; }

      // 3. めくり方を選ぶ（前回の選び方にフォーカス）
      const choose = $('.op-choose');
      choose.hidden = false;
      choose.querySelector(`[data-mode="${store.get('pk_flip_mode', 'auto')}"]`)?.focus();
      const mode = await new Promise(r => { chooseResolve = r; choose.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => r(b.dataset.mode)); });
      chooseResolve = null;
      choose.hidden = true;
      if (!skip) store.set('pk_flip_mode', mode);

      if (mode === 'auto' || skip) { await autoRest(); finish(); return; }

      // 4. 自分でめくる：タップした順に1枚ずつ
      const manual = $('.op-manual');
      manual.hidden = false;
      grid.classList.add('tap');
      await new Promise(done => {
        manualDone = done;
        cards().forEach((c, i) => c.onclick = async () => {
          if (busy || c.classList.contains('flip')) return;
          await reveal(i);
          if (allOpen()) done();
        });
        manual.querySelector('[data-rest]').onclick = async () => {
          if (busy) return;
          manual.hidden = true; grid.classList.remove('tap');
          await autoRest(); done();
        };
      });
      manualDone = null;
      finish();
    })();

    // 昇格演出：中央で大きく → 青から始まり、その賞の段階まで 赤 → 金 → 虹 と上がってからめくる
    async function spotlight(d, gridCard) {
      const lv = Math.max(1, lvOf(d));
      const spot = $('.op-spot');
      spot.innerHTML = `<div class="op-rays"></div><div class="op-flash"></div>${cardHtml(d, -1, logo)}<div class="op-banner"><span>${esc(label(d))}</span><b>${esc(d.name)}</b></div>`;
      spot.hidden = false;
      ov.classList.add('focus');
      gridCard.classList.add('away');
      const big = spot.querySelector('.op-card');
      await sleep(420);
      const hold = async L => {
        spot.dataset.lv = L;
        sfx.charge(L);
        await sleep(1050);   // どの段階でも同じ長さ（ここで止まるか、まだ上がるかは分からない）
      };
      await hold(1);
      for (let L = 2; L <= lv; L++) {
        if (skip) break;
        spot.classList.remove('up'); void spot.offsetWidth; spot.classList.add('up');
        sfx.up(L);
        try { navigator.vibrate && navigator.vibrate(L >= 4 ? [40, 30, 40, 30, 80] : 50); } catch { /* 非対応 */ }
        await hold(L);
      }
      spot.dataset.lv = lv;
      spot.classList.add('lit');
      big.classList.add('flip', 'shown');
      sfx.reveal(lv);
      try { lv >= 3 && navigator.vibrate && navigator.vibrate([60, 40, 140]); } catch { /* 非対応 */ }
      if (!skip && lv >= 2) {
        const kind = lv >= 4 ? 'rainbow' : lv >= 3 ? 'big' : 'small';
        confetti(fx, innerWidth / 2, innerHeight * 0.42, kind);
        if (lv >= 3) setTimeout(() => !skip && confetti(fx, innerWidth / 2, innerHeight * 0.42, kind), 380);
        if (lv >= 4) setTimeout(() => !skip && confetti(fx, innerWidth / 2, innerHeight * 0.3, kind), 800);
      }
      await waitTap(lv >= 3 ? 2800 : 1800);
      spot.hidden = true; spot.classList.remove('lit', 'up'); delete spot.dataset.lv; spot.innerHTML = '';
      ov.classList.remove('focus');
      gridCard.classList.remove('away');
      gridCard.classList.add('flip', 'shown');
    }

    return { close };
  }

  window.PKOpening = { play, tiers };
})();
