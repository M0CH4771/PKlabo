// オリパの開封演出（ショップと管理画面の試し引きで共通）
// パックを破る → カードが配られる → 弱い賞から順にめくる → 当たりは「確定演出」→ いちばん上の賞は中央で大きく開封
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
    deal() { noise(0, 0.05, 0.06, 5000); },
    flip() { noise(0, 0.06, 0.12, 4200); tone(880, 0, 0.08, 'sine', 0.04); },
    tick(n) { tone(520 + n * 140, 0, 0.12, 'square', 0.035); },
    high() { [659, 784, 988, 1319].forEach((f, i) => tone(f, i * 0.07, 0.35, 'triangle', 0.09)); },
    top() {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.5, 'triangle', 0.1));
      [1047, 1319, 1568].forEach(f => tone(f, 0.42, 1.4, 'sawtooth', 0.035));
      [523, 659, 784].forEach(f => tone(f, 0.42, 1.4, 'triangle', 0.08));
    },
  };

  // ── 紙吹雪 ──
  function confetti(canvas, x, y, power) {
    const c = canvas.getContext('2d'), dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = ['#e3262f', '#ffe14d', '#ffffff', '#1f4e99', '#ffb800'];
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

  // 賞品リストから演出の強さを決める（管理画面の試し引き用。ショップではサーバーが決める）
  function tiers(prizes) {
    const t = new Map();
    const pool = prizes.filter(p => !p.is_last_one);
    const total = pool.reduce((s, p) => s + (+p.qty || 0), 0) || 1;
    const vals = pool.map(p => +p.value || 0);
    const max = Math.max(0, ...vals), min = Math.min(...vals);
    for (const p of prizes) {
      const v = +p.value || 0;
      t.set(p, p.is_last_one ? 'lo' : max > min && v === max ? 'top' : v > min && ((+p.qty || 0) / total <= 0.2 || v >= min * 3) ? 'high' : 'normal');
    }
    return t;
  }

  const ORDER = { normal: 0, high: 1, lo: 2, top: 3 };
  const label = d => d.is_last_one ? 'ラストワン賞' : (d.rank || '');

  function cardHtml(d, i, logo) {
    return `<div class="op-card t-${d.tier || 'normal'}" data-i="${i}"><div class="op-in">
      <div class="op-back"><span>${esc(logo)}</span></div>
      <div class="op-front">${d.image_url ? `<img src="${esc(d.image_url)}" alt="">` : '<div class="op-noimg"></div>'}
        <span class="op-rank">${esc(label(d))}</span><b>${esc(d.name)}</b></div>
    </div></div>`;
  }

  // draws: [{ rank, name, image_url, is_last_one, tier }]、opts: { title, logo, sub, actions: [{ key, label, primary }], onAction(key, close) }
  function play(draws, opts = {}) {
    const logo = opts.logo || 'PK';
    let skip = reduced();
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
        <div class="op-pack" aria-hidden="true"><div class="op-pack-top"></div><div class="op-pack-body"><span class="op-pack-logo">${esc(logo)}</span><small>${esc(opts.title || '')}</small><em>${draws.filter(d => !d.is_last_one).length}口</em></div></div>
        <p class="op-hint">タップして開封</p>
      </div>
      <div class="op-grid ${draws.length === 1 ? 'one' : draws.length <= 3 ? 'few' : ''}" hidden>${draws.map((d, i) => cardHtml(d, i, logo)).join('')}</div>
      <div class="op-spot" hidden></div>
      <div class="op-foot" hidden>
        ${opts.sub ? `<p>${opts.sub}</p>` : ''}
        <div class="op-acts">${(opts.actions || [{ key: 'close', label: '閉じる', primary: true }]).map(a => `<button type="button" class="btn ${a.primary ? 'primary' : ''}" data-act="${esc(a.key)}">${esc(a.label)}</button>`).join('')}</div>
      </div>`;
    // モーダルの小窓（管理画面の試し引きなど）が開いていたら、その上に出す
    ([...document.querySelectorAll('dialog[open]')].pop() || document.body).appendChild(ov);
    document.documentElement.classList.add('op-lock');
    const fx = ov.querySelector('.op-fx');
    const $ = s => ov.querySelector(s);
    const close = () => { ov.remove(); document.documentElement.classList.remove('op-lock'); };
    let wake = null;
    const sleep = ms => new Promise(r => { if (skip) return r(); const t = setTimeout(r, ms); wake = () => { clearTimeout(t); r(); }; });
    const waitTap = (ms) => new Promise(r => {
      if (skip) return r();
      const done = () => { clearTimeout(t); ov.removeEventListener('click', h); r(); };
      const h = e => { if (!e.target.closest('.op-bar')) done(); };
      const t = setTimeout(done, ms);
      ov.addEventListener('click', h);
      wake = done;
    });
    $('[data-snd]').onclick = e => { const on = !soundOn(); store.set('pk_sound', on ? '1' : '0'); e.target.textContent = on ? '音：あり' : '音：なし'; };
    $('[data-skip]').onclick = () => { skip = true; if (wake) wake(); };
    ov.querySelectorAll('[data-act]').forEach(b => b.onclick = () => (opts.onAction || (() => close()))(b.dataset.act, close));
    const onKey = e => { if (e.key === 'Escape') { skip = true; if (wake) wake(); } };
    document.addEventListener('keydown', onKey);

    (async () => {
      // 1. パックを破る
      $('.op-pack').classList.add('in');
      await waitTap(1600);
      $('.op-hint').hidden = true;
      if (!skip) { sfx.tear(); $('.op-pack').classList.add('torn'); }
      await sleep(520);
      $('.op-stage').hidden = true;

      // 2. 配る
      const grid = $('.op-grid');
      grid.hidden = false;
      const cards = [...grid.querySelectorAll('.op-card')];
      if (!skip) {
        cards.forEach((c, i) => { c.style.setProperty('--d', `${Math.min(i, 20) * 55}ms`); c.classList.add('deal'); });
        for (let i = 0; i < Math.min(cards.length, 8); i++) setTimeout(() => !skip && sfx.deal(), i * 55);
        await sleep(Math.min(cards.length, 20) * 55 + 450);
      }

      // 3. 弱い賞から順にめくる（いちばん上の賞は最後）
      const order = cards.map((c, i) => i).sort((a, b) => ORDER[draws[a].tier || 'normal'] - ORDER[draws[b].tier || 'normal'] || a - b);
      const normals = order.filter(i => (draws[i].tier || 'normal') === 'normal').length;
      for (const i of order) {
        const c = cards[i], tier = draws[i].tier || 'normal';
        if (skip) { c.classList.add('flip', 'shown'); continue; }
        c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        if (tier === 'normal') {
          c.classList.add('flip'); sfx.flip();
          await sleep(normals > 6 ? 90 : 170);
        } else if (tier === 'top') {
          await spotlight(draws[i], c);
        } else {
          c.classList.add('tease');
          for (let k = 0; k < 3; k++) { sfx.tick(k); await sleep(230); }
          c.classList.remove('tease'); c.classList.add('flip', 'shown');
          sfx.high();
          const r = c.getBoundingClientRect();
          if (!skip) confetti(fx, r.left + r.width / 2, r.top + r.height / 2, 'small');
          await sleep(650);
        }
      }
      cards.forEach(c => c.classList.add('flip'));
      $('[data-skip]').hidden = true;
      $('.op-foot').hidden = false;
      $('.op-foot .btn')?.focus();
    })();

    // いちばん上の賞：中央で大きく、光の中で開封
    async function spotlight(d, gridCard) {
      const spot = $('.op-spot');
      spot.innerHTML = `<div class="op-rays"></div>${cardHtml(d, -1, logo)}<div class="op-banner"><span>${esc(label(d))}</span><b>${esc(d.name)}</b></div>`;
      spot.hidden = false;
      ov.classList.add('focus');
      const big = spot.querySelector('.op-card');
      await sleep(350);
      big.classList.add('tease');
      for (let k = 0; k < 4; k++) { sfx.tick(k + 1); await sleep(260); }
      big.classList.remove('tease');
      spot.classList.add('lit');
      big.classList.add('flip', 'shown');
      sfx.top();
      try { navigator.vibrate && navigator.vibrate([60, 40, 120]); } catch { /* 非対応 */ }
      if (!skip) { confetti(fx, innerWidth / 2, innerHeight * 0.42, 'big'); setTimeout(() => !skip && confetti(fx, innerWidth / 2, innerHeight * 0.42, 'big'), 380); }
      await waitTap(2600);
      spot.hidden = true; spot.classList.remove('lit'); spot.innerHTML = '';
      ov.classList.remove('focus');
      gridCard.classList.add('flip', 'shown');
    }

    const obs = new MutationObserver(() => { if (!ov.isConnected) { document.removeEventListener('keydown', onKey); obs.disconnect(); } });
    obs.observe(document.body, { childList: true, subtree: true });
    return { close };
  }

  window.PKOpening = { play, tiers };
})();
