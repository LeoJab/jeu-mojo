'use strict';
/* MOJO — effets spéciaux : sons synthétisés (WebAudio, aucun fichier), particules (canvas),
   secousses d'écran, flashs et gros textes. */
const FX = (() => {
  const reduce = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  let cv, cx, W = 0, H = 0, raf = 0, muted = false, ac = null, noiseBuf = null;
  const parts = [], rings = [];
  try { muted = localStorage.getItem('mojo-muted') === '1'; } catch (e) { /* ignoré */ }

  const PAL = ['#ffd426', '#ff3b55', '#46c3ff', '#3ddc84', '#ff8a1f', '#ffffff', '#c77dff'];

  /* ---------- canvas : particules ---------- */
  function init(canvas) {
    cv = canvas; cx = cv.getContext('2d');
    resize(); addEventListener('resize', resize);
  }
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth; H = innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(tick); }

  function burst(x, y, o = {}) {
    const n = Math.round((o.n || 24) * (reduce ? 0.35 : 1));
    const cols = o.colors || PAL;
    for (let i = 0; i < n; i++) {
      const a = o.angle !== undefined ? o.angle + (Math.random() - 0.5) * (o.spread || 1) : Math.random() * Math.PI * 2;
      const s = (o.speed || 6) * (0.35 + Math.random() * 0.9);
      parts.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - (o.lift || 0), g: o.g === undefined ? 0.22 : o.g,
        life: 0, max: (o.life || 55) * (0.6 + Math.random() * 0.7), size: (o.size || 7) * (0.6 + Math.random() * 0.8),
        color: cols[(Math.random() * cols.length) | 0], shape: o.shape || (Math.random() < 0.5 ? 'rect' : 'circle'),
        rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, drag: o.drag || 0.985
      });
    }
    kick();
  }
  function ring(x, y, color = '#ffd426', max = 160) {
    if (reduce) return;
    rings.push({ x, y, r: 6, max, color, life: 0 });
    kick();
  }
  function confetti(ms = 2000) {
    const t0 = performance.now();
    const iv = setInterval(() => {
      if (performance.now() - t0 > ms) return clearInterval(iv);
      for (let i = 0; i < (reduce ? 1 : 5); i++) {
        parts.push({
          x: Math.random() * W, y: -12, vx: (Math.random() - 0.5) * 3, vy: 1.5 + Math.random() * 3, g: 0.05,
          life: 0, max: 140 + Math.random() * 80, size: 8 + Math.random() * 6, color: PAL[(Math.random() * PAL.length) | 0],
          shape: 'rect', rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3, drag: 0.995
        });
      }
      kick();
    }, 60);
  }
  function fireworks(count = 6) {
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        const x = W * (0.15 + Math.random() * 0.7), y = H * (0.12 + Math.random() * 0.4);
        const c = PAL[(Math.random() * PAL.length) | 0];
        burst(x, y, { n: 46, speed: 7.5, g: 0.1, life: 70, size: 6, shape: 'circle', colors: [c, '#fff', c] });
        ring(x, y, c, 120);
        sound('boom');
      }, i * 380);
    }
  }
  function drawStar(r) {
    cx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 ? r * 0.45 : r;
      const a = (Math.PI / 5) * i - Math.PI / 2;
      cx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    cx.closePath(); cx.fill();
  }
  function tick() {
    raf = 0;
    cx.clearRect(0, 0, W, H);
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (++p.life > p.max) { parts.splice(i, 1); continue; }
      p.vx *= p.drag; p.vy = p.vy * p.drag + p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      cx.globalAlpha = Math.min(1, (p.max - p.life) / 18);
      cx.fillStyle = p.color;
      cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot);
      if (p.shape === 'circle') { cx.beginPath(); cx.arc(0, 0, p.size / 2, 0, 6.283); cx.fill(); }
      else if (p.shape === 'star') drawStar(p.size * 0.8);
      else cx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      cx.restore();
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.life++; r.r += (r.max - r.r) * 0.14;
      const a = 1 - r.life / 26;
      if (a <= 0) { rings.splice(i, 1); continue; }
      cx.globalAlpha = a; cx.strokeStyle = r.color; cx.lineWidth = 6 * a + 1;
      cx.beginPath(); cx.arc(r.x, r.y, r.r, 0, 6.283); cx.stroke();
    }
    cx.globalAlpha = 1;
    if (parts.length || rings.length) raf = requestAnimationFrame(tick);
  }

  /* ---------- DOM : secousse, flash, textes ---------- */
  function shake(power = 1) {
    if (reduce) return;
    const app = document.getElementById('app');
    app.style.setProperty('--amp', String(2 + power * 3));
    app.classList.remove('shake'); void app.offsetWidth; app.classList.add('shake');
    setTimeout(() => app.classList.remove('shake'), 460);
  }
  function flash(color = '#fff', ms = 300) {
    const d = document.createElement('div');
    d.className = 'flash'; d.style.background = color; d.style.animationDuration = ms + 'ms';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), ms + 60);
  }
  function big(text, o = {}) {
    const box = document.getElementById('big');
    box.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'bigtext ' + (o.cls || '');
    const t = document.createElement('span'); t.textContent = text; d.appendChild(t);
    if (o.sub) { const s = document.createElement('small'); s.textContent = o.sub; d.appendChild(s); }
    d.style.animationDuration = (o.ms || 1500) + 'ms';
    box.appendChild(d);
    setTimeout(() => d.remove(), (o.ms || 1500) + 50);
  }
  function floatText(x, y, text, color = '#fff') {
    const d = document.createElement('div');
    d.className = 'floater'; d.textContent = text;
    d.style.left = x + 'px'; d.style.top = y + 'px'; d.style.color = color;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 1200);
  }
  function vibrate(ms) { try { if (!reduce && navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignoré */ } }

  /* ---------- sons ---------- */
  function A() {
    if (!ac) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      try { ac = new C(); } catch (e) { return null; }
    }
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    return ac;
  }
  function tone(f, d, o = {}) {
    if (muted) return;
    const a = A(); if (!a) return;
    const t = a.currentTime + (o.at || 0);
    const osc = a.createOscillator(), g = a.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(f, t);
    if (o.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, f + o.slide), t + d);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.vol || 0.12, t + (o.attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    osc.connect(g); g.connect(a.destination);
    osc.start(t); osc.stop(t + d + 0.05);
  }
  function noise(d, o = {}) {
    if (muted) return;
    const a = A(); if (!a) return;
    if (!noiseBuf) {
      noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
      const ch = noiseBuf.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    }
    const t = a.currentTime + (o.at || 0);
    const src = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    src.buffer = noiseBuf; f.type = o.type || 'lowpass'; f.frequency.value = o.freq || 1800;
    g.gain.setValueAtTime(o.vol || 0.15, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    src.connect(f); f.connect(g); g.connect(a.destination);
    src.start(t); src.stop(t + d + 0.05);
  }
  const S = {
    pop() { tone(620, 0.06, { type: 'triangle', vol: 0.08 }); },
    card() { noise(0.08, { vol: 0.2, freq: 2200 }); tone(120, 0.1, { type: 'triangle', vol: 0.22, slide: -50 }); },
    up() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.15, { type: 'triangle', vol: 0.11, at: i * 0.06 })); },
    down() { tone(330, 0.2, { type: 'sawtooth', vol: 0.06, slide: -150 }); },
    eq(n = 1) { for (let i = 0; i < Math.min(n + 1, 5); i++) tone(660 * Math.pow(1.122, i * 2), 0.18, { type: 'square', vol: 0.07, at: i * 0.07 }); },
    draw() { noise(0.16, { vol: 0.1, freq: 3500, type: 'highpass' }); },
    deal() { for (let i = 0; i < 6; i++) noise(0.05, { vol: 0.1, freq: 3000, at: i * 0.05 }); },
    turn() { tone(880, 0.12, { type: 'sine', vol: 0.1 }); tone(1320, 0.2, { type: 'sine', vol: 0.09, at: 0.1 }); },
    alarm() {
      for (let i = 0; i < 4; i++) tone(i % 2 ? 560 : 820, 0.2, { type: 'sawtooth', vol: 0.09, at: i * 0.2 });
      tone(70, 0.8, { type: 'sine', vol: 0.3, slide: -30 });
    },
    tick(left = 3) { const f = 700 + (4 - Math.min(left, 4)) * 160; tone(f, 0.07, { type: 'square', vol: 0.07 }); tone(f / 2, 0.07, { type: 'square', vol: 0.05, at: 0.12 }); },
    reveal() { noise(0.12, { vol: 0.12, freq: 1500, type: 'bandpass' }); tone(440, 0.2, { type: 'triangle', vol: 0.1, slide: 440 }); },
    roundend() { tone(100, 0.7, { type: 'sine', vol: 0.35, slide: -60 }); noise(0.5, { vol: 0.2, freq: 900 }); },
    zero() { [784, 988, 1175, 1568].forEach((f, i) => tone(f, 0.35, { type: 'triangle', vol: 0.12, at: i * 0.09 })); },
    penalty() { tone(180, 0.5, { type: 'sawtooth', vol: 0.14, slide: -110 }); tone(150, 0.5, { type: 'square', vol: 0.08, at: 0.1, slide: -90 }); },
    boom() { noise(0.4, { vol: 0.25, freq: 600 }); tone(90, 0.4, { type: 'sine', vol: 0.3, slide: -50 }); },
    win() {
      [523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, { type: 'triangle', vol: 0.13, at: i * 0.14 }));
      tone(1047, 0.9, { type: 'triangle', vol: 0.12, at: 0.9 });
    },
    lose() { [392, 349, 311, 262].forEach((f, i) => tone(f, 0.3, { type: 'triangle', vol: 0.1, at: i * 0.2 })); }
  };
  function sound(name, arg) { try { if (S[name]) S[name](arg); } catch (e) { /* ignoré */ } }
  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem('mojo-muted', muted ? '1' : '0'); } catch (e) { /* ignoré */ }
  }
  const isMuted = () => muted;
  const unlock = () => { A(); };

  return { init, burst, ring, confetti, fireworks, shake, flash, big, floatText, vibrate, sound, setMuted, isMuted, unlock, reduce };
})();
