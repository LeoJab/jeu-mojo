'use strict';
/* MOJO — réseau (salle du hub), interface et mise en scène.
   Les règles sont dans engine.js, les effets (sons, particules) dans fx.js.

   Modèle réseau : le premier joueur de la salle est l'HÔTE. Les joueurs lui envoient leurs actions
   ({t:'act'}), il les valide avec le moteur puis diffuse l'état complet versionné ({t:'state'}, keep:true).
   Un joueur absent ou un bot est joué par l'hôte. */
(() => {
  const M = window.Mojo;

  /* ---------- petits outils ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = o => JSON.parse(JSON.stringify(o));
  const hash = s => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h; };
  const SDK = () => window.ChadGang || null;
  const BOT_NAMES = ['Robo-Chad', 'Mojo-Bot', 'Cartouche', 'Bluffy', 'Jokerino', 'Tilt', 'Gaston'];
  const ABSENT_GRACE = 6000;   // ms avant que l'hôte joue à la place d'un joueur déconnecté
  const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

  /* ---------- état ---------- */
  let me = { id: 'local', name: 'Joueur', avatar: null };
  let myId = 'local';
  let room = null, code = '', local = false, botCount = 3;
  let roster = [];            // joueurs présents dans la salle (le premier = hôte)
  let st = null;              // dernier état de partie connu
  let screen = 'home';
  let avatars = {};           // id -> url de la photo
  let sel = null;             // carte sélectionnée (1er appui)
  let pending = null;         // action envoyée à l'hôte, en attente de sa réponse
  let absent = {};            // id -> moment du départ
  let reported = '';          // partie déjà envoyée au classement
  let botTimer = 0;
  let recapAt = 0, nextReadyAt = 0, shownKey = '';
  let gates = 0, modalGate = false;
  let fxChain = Promise.resolve();
  let handRects = {}, skipEnter = new Set(), dealStagger = false, lastEmo = 0;
  const handEls = new Map();

  const isHost = () => roster.length > 0 && roster[0].id === myId;
  const isHere = id => roster.some(p => p.id === id);
  const seated = () => !!(st && st.seats && st.seats.some(s => s.id === myId));
  const nameIn = (s, id) => (s && s.seats ? M.nameOf(s, id) : '?');
  const canAct = () => !!(st && room && st.phase === 'play' && st.turn === myId && !pending && seated());
  const isBotId = id => String(id).indexOf('bot-') === 0;

  /* ---------- cartes (HTML) ---------- */
  const rotOf = id => ((id * 53) % 15) - 7;
  function cardHtml(id, o = {}) {
    const c = M.DECK[id];
    return `<div class="card c${c.c}${c.v >= 10 ? ' two' : ''} ${o.cls || ''}" data-card="${id}" style="${o.style || ''}">` +
      `<i class="tl">${c.v}</i><i class="sy">${M.COLORS[c.c].sym}</i><b class="big">${c.v}</b><i class="br">${c.v}</i><span class="rel"></span>${o.extra || ''}</div>`;
  }
  const backHtml = cls => `<div class="card back ${cls || ''}"><b>M</b></div>`;
  const chip = id => `<span class="chip c${M.col(id)}">${M.val(id)}</span>`;
  function relOf(id) {
    const top = st.disc[st.disc.length - 1];
    const a = M.val(id), b = M.val(top);
    return a > b ? 'up' : a < b ? 'down' : 'eq';
  }
  function avatarHtml(id, name) {
    const url = id === myId ? me.avatar : avatars[id];
    if (url) return `<img class="av" src="${esc(url)}" data-chadgang-id="${esc(id)}" alt="">`;
    return `<div class="av" data-chadgang-id="${esc(id)}" style="--h:${hash(id) % 360}">${esc((name || '?').trim().charAt(0).toUpperCase())}</div>`;
  }

  /* ================= DÉMARRAGE ================= */
  async function boot() {
    FX.init($('#fx'));
    bindUI();
    if (SDK()) {
      try {
        const m = await SDK().me();
        me = { id: m.id, name: m.name || 'Joueur', avatar: m.avatar || null };
      } catch (e) { /* on joue avec un pseudo par défaut */ }
    } else {
      $('#btnLocal').hidden = false;
    }
    myId = me.id;
    $('#homeWho').innerHTML = `${avatarHtml(me.id, me.name)}<span>${esc(me.name)}</span>`;
    const r = SDK() && SDK().room ? SDK().room() : null;
    if (r) joinRoom(String(r), false);
    setInterval(hostTick, 400);
    setInterval(retryPending, 1000);
    setInterval(tickNextButton, 250);
  }

  function msg(t) { $('#homeMsg').textContent = t || ''; }
  function show(name) {
    screen = name;
    ['home', 'lobby', 'table'].forEach(n => { $('#' + n).hidden = n !== name; });
  }
  function syncScreen() {
    if (!room) show('home');
    else if (st && st.phase && st.phase !== 'lobby' && st.seats) show('table');
    else show('lobby');
  }

  /* ================= SALLE (hub) ================= */
  function randomCode() {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)];
    return c;
  }
  function joinRoom(c, create) {
    c = String(c).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length < 4) return msg('Le code doit faire au moins 4 caractères.');
    if (!SDK()) return msg('Ouvre le jeu depuis le hub pour jouer en ligne.');
    leaveRoom(true);
    code = c; local = false; msg('');
    try { room = SDK().join(c, { create }); } catch (e) { room = null; return msg('Impossible de rejoindre la salle.'); }
    wireRoom(room);
    renderAll();
  }
  function wireRoom(r) {
    r.on('ready', info => {
      myId = info.me || myId;
      roster = (info.players || []).map(p => ({ id: p.id, name: p.name }));
      sendHi();
      const l = info.last && (info.last.t ? info.last : info.last.data);
      if (l && l.t === 'state' && l.s) acceptState(l.s, true);
      markAbsent(); renderAll();
    });
    r.on('players', list => {
      roster = (list || []).map(p => ({ id: p.id, name: p.name }));
      markAbsent(); sendHi(); renderAll();
    });
    r.on('message', (d, from) => onMsg(d, from || {}));
    r.on('error', m => {
      leaveRoom(true); show('home');
      msg(typeof m === 'string' && m ? m : 'Salle introuvable ou pleine.');
    });
  }
  function leaveRoom(silent) {
    try { if (room && room.leave) room.leave(); } catch (e) { /* ignoré */ }
    room = null; st = null; roster = []; pending = null; sel = null; absent = {}; local = false;
    $$('#recap,#end').forEach(m => { m.hidden = true; });
    shownKey = ''; gates = 0; modalGate = false;
    if (!silent) { show('home'); renderAll(); }
  }
  function sendHi() { if (room && !local && me.avatar) room.send({ t: 'hi', av: me.avatar }); }
  function markAbsent() {
    if (!st || !st.seats) return;
    st.seats.forEach(s => {
      if (isHere(s.id)) delete absent[s.id];
      else if (!absent[s.id]) absent[s.id] = Date.now();
    });
  }

  /* ----- mode entraînement (hors hub) : salle fictive avec des bots ----- */
  function syncLocalRoster() {
    roster = [{ id: me.id, name: me.name }];
    for (let i = 1; i <= botCount; i++) roster.push({ id: 'bot-' + i, name: BOT_NAMES[(i - 1) % BOT_NAMES.length] });
  }
  function startLocal() {
    leaveRoom(true);
    local = true; code = 'LOCAL'; myId = me.id; botCount = 3;
    room = { on() {}, send() {}, leave() {} };
    syncLocalRoster();
    renderAll();
  }

  /* ================= MESSAGES ================= */
  function onMsg(d, from) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'state' && d.s) acceptState(d.s, false);
    else if (d.t === 'act') { if (isHost() && from.id) hostAct(from.id, d.a); }
    else if (d.t === 'hi') { if (from.id && d.av && avatars[from.id] !== d.av) { avatars[from.id] = d.av; renderAll(); } }
    else if (d.t === 'emo') { if (from.id) reaction(from.id, String(d.e || '').slice(0, 4)); }
  }
  function broadcast(s) { if (room) room.send({ t: 'state', s }, { keep: true }); }

  function acceptState(ns, initial) {
    if (!ns || typeof ns.v !== 'number') return;
    if (st && ns.v <= st.v) return;
    const old = st;
    st = ns; pending = null;
    onNewState(old, ns, !!initial);
  }

  /* ================= HÔTE ================= */
  function hostAct(pid, a) {
    if (!st || !isHost()) return;
    const ns = clone(st);
    if (!M.apply(ns, pid, a)) return;
    ns.v = st.v + 1;
    broadcast(ns);
    const old = st;
    st = ns; pending = null;
    onNewState(old, ns, false);
  }
  function startGame() {
    if (!isHost()) return;
    const seats = roster.slice(0, 8).map(p => ({ id: p.id, name: p.name }));
    if (seats.length < 2) return;
    const gid = code + '-' + Date.now().toString(36);
    const ns = M.newGame(seats, gid, (st ? st.v : 0) + 1);
    broadcast(ns);
    const old = st;
    st = ns; sel = null; pending = null;
    onNewState(old, ns, false);
  }
  function controlled(pid) {
    if (isBotId(pid)) return true;
    return !!absent[pid] && Date.now() - absent[pid] > ABSENT_GRACE;
  }
  function hostTick() {
    if (!room || !st || !isHost() || botTimer) return;
    if (st.phase === 'play' && controlled(st.turn)) {
      const pid = st.turn, v = st.v;
      botTimer = setTimeout(() => {
        botTimer = 0;
        if (!st || st.v !== v || st.turn !== pid || !isHost()) return;
        hostAct(pid, M.botAct(st, pid));
      }, 1300 + Math.random() * 700);
    } else if (st.phase === 'recap' && Date.now() - recapAt > 50000) {
      hostAct(myId, { t: 'next' });
    }
  }

  /* ================= ACTIONS DU JOUEUR ================= */
  function sendAct(a) {
    if (!room) return;
    if (isHost()) { hostAct(myId, a); return; }
    pending = { a, at: Date.now(), tries: 0 };
    room.send({ t: 'act', a });
    renderControls();
  }
  function retryPending() {
    if (!pending || !room) return;
    if (Date.now() - pending.at < 3000) return;
    if (++pending.tries > 3) { pending = null; renderAll(); return; }
    pending.at = Date.now();
    room.send({ t: 'act', a: pending.a });
  }
  function nudge() { const h = $('#hand'); h.animate([{ translate: '0' }, { translate: '-6px' }, { translate: '6px' }, { translate: '0' }], { duration: 220 }); }

  function onPick(id) {
    if (!canAct()) { nudge(); return; }
    const inDown = st.down[myId].includes(id), inHand = st.hand[myId].includes(id);
    if (!inDown && !inHand) return;
    if (st.down[myId].length && inHand) return;
    if (sel === id) { confirmPick(); return; }
    sel = id; FX.sound('pop');
    renderMine(); layoutHand(sortedHand()); renderBanner(); renderControls();
  }
  function confirmPick() {
    if (!canAct() || sel == null) return;
    const a = st.down[myId].includes(sel) ? { t: 'reveal', card: sel } : { t: 'play', card: sel };
    sel = null;
    snapshotHandRects();
    sendAct(a);
  }
  function reaction(pid, e) {
    if (!e) return;
    const s = seatEl(pid);
    const r = s ? s.getBoundingClientRect() : null;
    const x = r ? r.left + r.width / 2 : innerWidth / 2, y = r ? r.bottom : innerHeight / 3;
    const d = document.createElement('div');
    d.className = 'floater emo'; d.textContent = e; d.style.left = x + 'px'; d.style.top = y + 'px';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 1200);
    FX.sound('pop');
  }

  /* ================= NOUVEL ÉTAT : rendu + mise en scène ================= */
  function onNewState(old, ns, initial) {
    snapshotHandRects();
    const evs = initial ? [] : (ns.ev || []);
    skipEnter = new Set(evs.filter(e => e.k === 'draw' && e.p === myId).map(e => e.card));
    dealStagger = evs.some(e => e.k === 'deal');
    if (ns.phase === 'recap' && (!old || old.phase !== 'recap')) { recapAt = Date.now(); nextReadyAt = Date.now() + 2800; }
    markAbsent();
    const mineCards = (ns.hand && ns.hand[myId] || []).concat(ns.down && ns.down[myId] || []);
    if (sel != null && !(canAct() && mineCards.includes(sel))) sel = null;
    renderAll();
    if (initial || !old) { maybeReport(); return; }

    if (ns.phase === 'play' && ns.turn === myId && seated() && (old.turn !== myId || old.phase !== 'play')) { FX.sound('turn'); FX.vibrate(40); }
    evs.forEach(e => {
      if (e.k === 'play') animatePlay(e);
      else if (e.k === 'draw') animateDraw(e);
      else if (e.k === 'mojotime') popSeat(e.p);
    });
    queueFx(evs, ns);
    maybeReport();
  }

  function maybeReport() {
    if (local || !st || st.phase !== 'end' || reported === st.gid || !seated()) return;
    reported = st.gid;
    try {
      const sdk = SDK();
      if (sdk && sdk.finPartie) Promise.resolve(sdk.finPartie({ gagne: st.win.includes(myId), partie: st.gid })).catch(() => {});
    } catch (e) { /* ignoré */ }
  }

  /* ---------- animations immédiates (vol de cartes) ---------- */
  function seatEl(pid) { return $$('.seat').find(e => e.dataset.seat === pid) || null; }
  const center = r => (r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: innerWidth / 2, y: innerHeight / 2 });
  function snapshotHandRects() {
    handRects = {};
    handEls.forEach((el, id) => { handRects[id] = el.getBoundingClientRect(); });
  }
  function fly(html, from, to, o = {}) {
    if (FX.reduce || !from || !to) return Promise.resolve();
    const d = document.createElement('div');
    d.className = 'fly'; d.innerHTML = html;
    d.style.left = from.left + 'px'; d.style.top = from.top + 'px'; d.style.setProperty('--cw', from.width + 'px');
    document.body.appendChild(d);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2), dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const sc = Math.max(0.2, to.width / from.width);
    const a = d.animate(
      [{ transform: 'translate(0,0) scale(1) rotate(0deg)' }, { transform: `translate(${dx}px,${dy}px) scale(${sc}) rotate(${o.rot || 0}deg)` }],
      { duration: o.dur || 420, delay: o.delay || 0, easing: 'cubic-bezier(.3,.7,.3,1)', fill: 'both' }
    );
    return a.finished.catch(() => {}).then(() => d.remove());
  }
  function animatePlay(e) {
    FX.sound('card');
    const el = $('#discard .card.top');
    if (!el || FX.reduce) return;
    let from = null;
    if (e.p === myId && handRects[e.card]) from = handRects[e.card];
    else { const s = seatEl(e.p); if (s) from = s.getBoundingClientRect(); }
    if (!from) return;
    const to = el.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (to.left + to.width / 2), dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const r = rotOf(e.card);
    el.animate([
      { transform: `translate(${dx}px,${dy}px) scale(${from.width < to.width ? 0.6 : 0.9}) rotate(${r - 25}deg)`, opacity: 0.3 },
      { transform: `translate(0,0) scale(1.22) rotate(${r}deg)`, opacity: 1, offset: 0.72 },
      { transform: `translate(0,0) scale(1) rotate(${r}deg)`, opacity: 1 }
    ], { duration: 460, easing: 'cubic-bezier(.25,.8,.3,1)' });
  }
  function animateDraw(e) {
    const pile = $('#drawpile');
    if (!pile) return;
    FX.sound('draw');
    const from = pile.getBoundingClientRect();
    if (e.p === myId) {
      const el = handEls.get(e.card);
      if (!el) return;
      el.style.visibility = 'hidden';
      const restore = () => { el.style.visibility = ''; };
      setTimeout(restore, 1100);
      fly(cardHtml(e.card), from, el.getBoundingClientRect(), { delay: 180, dur: 420, rot: 0 }).then(restore);
    } else {
      const s = seatEl(e.p);
      if (s) fly(backHtml(), from, s.getBoundingClientRect(), { delay: 180, dur: 380, rot: 20 });
    }
  }
  function popSeat(pid) {
    const s = seatEl(pid);
    if (s) { s.classList.add('pop'); setTimeout(() => s.classList.remove('pop'), 600); }
  }

  /* ---------- mise en scène (file d'attente) ---------- */
  function queueFx(evs, ns) {
    if (!evs.length) return;
    const gated = evs.some(e => e.k === 'roundend' || e.k === 'gameover');
    if (gated) { gates++; modalGate = true; }
    fxChain = fxChain.then(() => runFx(evs, ns)).catch(() => {}).then(() => {
      if (gated) { gates = Math.max(0, gates - 1); modalGate = gates > 0; updateModals(); }
    });
  }
  const comboTitle = k => (k === 1 ? '＝ ÉGAL !' : k === 2 ? 'DOUBLE ÉGAL !' : k === 3 ? 'TRIPLE ÉGAL !!' : 'COMBO x' + k + ' !!!');

  async function runFx(evs, ns) {
    for (const e of evs) {
      const who = nameIn(ns, e.p);
      switch (e.k) {
        case 'deal': {
          FX.sound('deal');
          FX.big('MANCHE ' + ns.round, { cls: 'blue', sub: nameIn(ns, ns.turn) + ' ouvre la danse', ms: 1200 });
          await sleep(900); break;
        }
        case 'reshuffle': {
          FX.sound('deal'); const c = center(($('#drawpile') || {}).getBoundingClientRect ? $('#drawpile').getBoundingClientRect() : null);
          FX.floatText(c.x, c.y, '🔀 pioche remélangée', '#fff'); break;
        }
        case 'play': {
          await sleep(220);
          const c = center($('#discard') ? $('#discard').getBoundingClientRect() : null);
          if (e.rel === 'up') {
            FX.sound('up');
            FX.burst(c.x, c.y, { n: 18, colors: ['#3ddc84', '#b8ffd0', '#fff'], speed: 5, shape: 'star' });
            FX.floatText(c.x, c.y - 80, '▲ PIOCHE', '#7dffa0');
            await sleep(300);
          } else if (e.rel === 'down') {
            FX.sound('down');
            FX.burst(c.x, c.y, { n: 8, colors: ['#cfcde0', '#8d8aa8'], speed: 3, g: 0.08 });
            FX.floatText(c.x, c.y - 80, '▼', '#cfcde0');
            await sleep(200);
          } else {
            const k = e.combo;
            FX.sound('eq', k); FX.ring(c.x, c.y, '#ffd426', 110 + k * 40);
            FX.burst(c.x, c.y, { n: 14 + k * 12, colors: ['#ffd426', '#fff', '#ff8a1f'], speed: 6 + k, shape: 'star' });
            FX.shake(Math.min(k, 3)); FX.vibrate(30 * k);
            FX.big(comboTitle(k), { cls: 'gold', sub: who + (k > 1 ? ' enchaîne !' : ' rejoue'), ms: 1100 });
            await sleep(700);
          }
          break;
        }
        case 'mojotime': {
          if (e.first) {
            FX.sound('alarm'); FX.flash('#ff1e46', 450); FX.shake(3); FX.vibrate([80, 40, 80]);
            FX.big('MOJO TIME !', { cls: 'red', sub: who + ' lance le décompte', ms: 1500 });
            await sleep(1300);
          } else {
            FX.sound('tick', 2);
            const s = seatEl(e.p);
            if (s) { const c = center(s.getBoundingClientRect()); FX.floatText(c.x, c.y + 24, '⏳ décompte', '#ffb3be'); FX.ring(c.x, c.y, '#ff3b55', 90); }
            await sleep(450);
          }
          break;
        }
        case 'reveal': {
          FX.sound('reveal');
          revealPop(e.card, who, e.left);
          await sleep(e.left === 0 ? 1200 : 900);
          if (e.left > 0) FX.sound('tick', e.left);
          break;
        }
        case 'roundend': {
          FX.sound('roundend'); FX.flash('#fff', 380); FX.shake(2);
          const mj = $('#mojo'); if (mj) { mj.classList.remove('slam'); void mj.offsetWidth; mj.classList.add('slam'); }
          FX.big('FIN DE MANCHE', { cls: 'blue', sub: who + ' prend le Mojo', ms: 1500 });
          await sleep(1500);
          if (ns.rec && ns.rec.ok) {
            FX.sound('zero'); FX.confetti(1800);
            FX.big('MOJO ! 0 POINT', { cls: 'gold', sub: who + ' s\'en sort en beauté', ms: 1500 });
          } else {
            FX.sound('penalty'); FX.flash('#ff3b55', 500); FX.shake(3); FX.vibrate([120, 60, 120]);
            FX.big('RATÉ ! +10', { cls: 'red', sub: 'Le Mojo se retourne contre ' + who, ms: 1500 });
          }
          await sleep(1500);
          break;
        }
        case 'gameover': {
          const win = ns.win.includes(myId);
          FX.sound(win ? 'win' : 'lose'); FX.fireworks(7); FX.confetti(4000);
          FX.big('FIN DE PARTIE', { cls: 'gold', sub: ns.win.map(id => nameIn(ns, id)).join(' & ') + (ns.win.length > 1 ? ' gagnent !' : ' gagne !'), ms: 2200 });
          await sleep(2300);
          break;
        }
        default: break;
      }
    }
  }
  function revealPop(card, who, left) {
    const box = $('#big');
    box.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'revealpop';
    const txt = who + ' révèle un ' + M.val(card) + (left === 0 ? ' — DERNIÈRE CARTE !' : left === 1 ? ' — plus qu\'une !' : '');
    d.innerHTML = cardHtml(card) + '<span></span>';
    d.lastChild.textContent = txt;
    box.appendChild(d);
    setTimeout(() => d.remove(), 1450);
  }

  /* ================= RENDU ================= */
  function renderAll() {
    syncScreen();
    if (screen === 'lobby') renderLobby();
    else if (screen === 'table') renderTable();
    updateModals();
  }

  function renderLobby() {
    $('#codeBtn').textContent = local ? 'ENTRAÎNEMENT' : code;
    $('#lobbyPlayers').innerHTML = roster.map((p, i) =>
      `<div class="lp ${p.id === myId ? 'me' : ''}">${avatarHtml(p.id, p.name)}<span>${esc(p.name)}</span>${i === 0 ? '<em>hôte</em>' : ''}</div>`).join('');
    const host = isHost();
    $('#lobbyBots').hidden = !local;
    $('#btnStart').hidden = !host;
    $('#btnStart').disabled = roster.length < 2;
    $('#lobbyWait').textContent = host
      ? (roster.length < 2 ? 'Il faut au moins 2 joueurs (3 à 8, c\'est l\'idéal).' : roster.length + ' joueurs prêts. Tu peux lancer !')
      : 'En attente de l\'hôte (' + (roster[0] ? roster[0].name : '…') + ')…';
  }

  function renderTable() {
    $('#roundNo').textContent = 'Manche ' + st.round;
    $('#roomCode').textContent = local ? 'Entraînement' : 'Salle ' + code;
    $('#app').classList.toggle('mojotime', st.phase === 'play' && st.seats.some(s => st.down[s.id].length > 0));
    $('#btnSound').textContent = FX.isMuted() ? '🔇' : '🔊';
    renderSeats(); renderCenter(); renderMine(); renderHand(); renderBanner(); renderControls(); renderLog();
  }

  function renderSeats() {
    $('#seats').innerHTML = st.seats.map(s => {
      const turn = st.phase === 'play' && st.turn === s.id;
      const down = st.down[s.id] || [], up = st.up[s.id] || [];
      return `<div class="seat ${turn ? 'turn' : ''} ${s.id === myId ? 'me' : ''} ${isHere(s.id) ? '' : 'gone'} ${down.length ? 'counting' : ''}" data-seat="${esc(s.id)}">` +
        avatarHtml(s.id, s.name) +
        `<div class="sname">${esc(s.name)}${st.mojo.holder === s.id ? ' <span class="crown" title="Carte Mojo">👑</span>' : ''}</div>` +
        `<div class="stot">${st.tot[s.id]}<small>pts</small></div>` +
        `<div class="sinfo"><span class="mini"></span><b>${(st.hand[s.id] || []).length}</b>${down.length ? `<span class="dn">⏳${down.length}</span>` : ''}</div>` +
        (up.length ? `<div class="sup">${up.map(chip).join('')}</div>` : '') +
        '</div>';
    }).join('');
  }

  function renderCenter() {
    $('#drawCount').textContent = st.draw.length;
    $('#drawpile').innerHTML = st.draw.length ? backHtml() + backHtml() + backHtml() : '<div class="empty">vide</div>';
    const tops = st.disc.slice(-3);
    $('#discard').innerHTML = tops.map((c, i) =>
      cardHtml(c, { cls: i === tops.length - 1 ? 'top' : 'under', style: `transform:rotate(${rotOf(c)}deg)` })).join('');
    const mj = st.mojo;
    const mel = $('#mojo');
    mel.className = 'mojo' + (mj.side === 10 ? ' bad' : '') + (mj.holder ? ' held' : '');
    mel.innerHTML = `<span class="mt">MOJO</span><b>${mj.side === 10 ? '+10' : '0'}</b>`;
    $('#mojoWho').textContent = mj.holder ? nameIn(st, mj.holder) : 'au centre';

    const cd = st.phase === 'play'
      ? st.seats.filter(s => st.down[s.id].length).sort((a, b) => st.down[a.id].length - st.down[b.id].length)[0]
      : null;
    const box = $('#countdown');
    box.hidden = !cd;
    if (cd) {
      const n = st.down[cd.id].length;
      box.className = 'countdown' + (n === 1 ? ' last' : '');
      box.innerHTML = `<span class="bomb">💣</span><b>${n}</b><span>${n === 1 ? 'dernière carte' : 'cartes avant la fin'} · ${esc(cd.name)}</span>`;
    }
  }

  function renderMine() {
    const box = $('#mine');
    if (!seated()) { box.innerHTML = ''; return; }
    const dn = st.down[myId] || [], up = st.up[myId] || [], hd = st.hand[myId] || [];
    const sc = M.scoreOf([...hd, ...dn, ...up]);
    const rev = canAct() && dn.length > 0;
    box.innerHTML =
      `<div class="myscore"><span>Mon score en jeu</span><b>${sc.total}</b><span class="kept">${sc.kept.map(chip).join('')}</span></div>` +
      `<div class="mycards">` +
      dn.map(c => cardHtml(c, { cls: 'mini hidden-mine' + (rev ? ' rev' : '') + (sel === c ? ' sel' : ''), extra: '<i class="lock">🔒</i>' })).join('') +
      up.map(c => cardHtml(c, { cls: 'mini' })).join('') +
      `</div>`;
  }

  function sortedHand() {
    const h = seated() && st.phase !== 'end' ? (st.hand[myId] || []) : [];
    return h.slice().sort((a, b) => M.val(a) - M.val(b) || M.col(a) - M.col(b));
  }
  function renderHand() {
    const box = $('#hand');
    const sorted = sortedHand();
    handEls.forEach((el, id) => { if (!sorted.includes(id)) { el.remove(); handEls.delete(id); } });
    sorted.forEach((id, i) => {
      if (handEls.has(id)) return;
      const t = document.createElement('div');
      t.innerHTML = cardHtml(id);
      const el = t.firstElementChild;
      if (!skipEnter.has(id)) {
        el.classList.add('enter');
        el.style.animationDelay = (dealStagger ? i * 70 : 0) + 'ms';
        el.addEventListener('animationend', () => el.classList.remove('enter'), { once: true });
      }
      box.appendChild(el);
      handEls.set(id, el);
    });
    layoutHand(sorted);
    box.classList.toggle('myturn', canAct());
  }
  function layoutHand(sorted) {
    const box = $('#hand');
    const W = box.clientWidth, cw = $('#probe').offsetWidth || 50, n = sorted.length;
    if (!W || !st) return;
    const step = n > 1 ? Math.min(cw * 1.1, (W - cw) / (n - 1)) : 0;
    const x0 = (W - (cw + step * (n - 1))) / 2, mid = (n - 1) / 2;
    const topV = st.disc.length ? M.val(st.disc[st.disc.length - 1]) : null;
    sorted.forEach((id, i) => {
      const el = handEls.get(id);
      if (!el) return;
      el.style.left = (x0 + step * i).toFixed(1) + 'px';
      el.style.zIndex = i + 1;
      el.style.setProperty('--rot', ((i - mid) * Math.min(3.2, 22 / Math.max(n, 1))).toFixed(2) + 'deg');
      el.style.setProperty('--y', (Math.pow(Math.abs(i - mid), 1.7) * 1.1).toFixed(1) + 'px');
      el.classList.toggle('sel', id === sel);
      const v = M.val(id);
      const rel = topV === null ? '' : v > topV ? 'up' : v < topV ? 'down' : 'eq';
      el.dataset.rel = rel;
      el.querySelector('.rel').textContent = rel === 'up' ? '▲' : rel === 'down' ? '▼' : '＝';
    });
  }

  function hintFor(id) {
    const v = M.val(id);
    if (st.down[myId].includes(id)) return `🔒 Révéler le ${v} ? Touche encore pour confirmer`;
    const r = relOf(id);
    return r === 'up' ? `▲ Le ${v} est plus fort : tu piocheras` : r === 'down' ? `▼ Le ${v} est plus faible : pas de pioche` : `＝ Le ${v} est égal : tu rejoueras !`;
  }
  function renderBanner() {
    const b = $('#banner');
    let t = '', cls = 'banner';
    if (st.phase === 'recap') t = '🏁 Manche terminée !';
    else if (st.phase === 'end') t = '🏆 Partie terminée !';
    else if (!seated()) t = '👀 Tu regardes la partie — tour de ' + nameIn(st, st.turn);
    else if (st.turn === myId) {
      cls += ' mine';
      if (sel != null) t = hintFor(sel);
      else if (st.down[myId].length) t = '⏳ DÉCOMPTE ! Révèle une de tes cartes cachées';
      else if (st.must) t = '＝ ÉGALITÉ ! Rejoue une carte';
      else t = '🔥 À TOI DE JOUER !';
    } else {
      const n = nameIn(st, st.turn);
      t = st.down[st.turn] && st.down[st.turn].length ? '⏳ ' + n + ' révèle une carte…' : n + (st.must ? ' rejoue (égalité) …' : ' réfléchit…');
      if (!isHere(st.turn)) t = n + ' est parti… un bot le remplace';
    }
    b.className = cls; b.textContent = t;
  }
  function renderControls() {
    const btn = $('#btnPlay');
    const can = canAct();
    const isDown = sel != null && st && st.down[myId] && st.down[myId].includes(sel);
    btn.disabled = !(can && sel != null);
    btn.textContent = pending ? '…' : sel == null ? (can ? 'CHOISIS UNE CARTE' : 'PATIENCE…') : (isDown ? 'RÉVÉLER' : 'JOUER');
    $('.actions').hidden = !seated();
  }
  function renderLog() {
    const p = $('#log');
    if (p.hidden) return;
    p.innerHTML = st.log.slice().reverse().map(l => `<div>${esc(l)}</div>`).join('');
  }

  /* ================= MODALES ================= */
  function updateModals() {
    const recapOn = !!st && st.phase === 'recap' && !modalGate && screen === 'table';
    const endOn = !!st && st.phase === 'end' && !modalGate && screen === 'table';
    const rec = $('#recap'), end = $('#end');
    if (!recapOn) rec.hidden = true;
    else if (rec.hidden || shownKey !== 'r' + st.gid + st.round) { shownKey = 'r' + st.gid + st.round; fillRecap(); rec.hidden = false; }
    if (!endOn) end.hidden = true;
    else if (end.hidden || shownKey !== 'e' + st.gid) { shownKey = 'e' + st.gid; fillEnd(); end.hidden = false; }
    if (!recapOn && !endOn && st && st.phase === 'play') shownKey = '';
  }

  function barClass(t) { return t >= 40 ? 'danger' : t >= 25 ? 'warn' : ''; }
  function countUp(el, from, to, ms) {
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / ms);
      el.firstChild.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function fillRecap() {
    const r = st.rec;
    $('#recapTitle').textContent = 'Fin de manche ' + st.round;
    $('#recapTaker').innerHTML = `${avatarHtml(r.taker, nameIn(st, r.taker))}<span><b>${esc(nameIn(st, r.taker))}</b> prend le Mojo →</span> ` +
      (r.ok ? '<b class="good">0 point ! 🎉</b>' : '<b class="bad">+10 de pénalité 💥</b>');
    $('#recapRows').innerHTML = r.rows.map(row => {
      const prev = st.tot[row.id] - row.pts, isT = row.id === r.taker;
      const ptxt = isT ? (r.ok ? `${row.raw} <i class="z">→ 0</i>` : `${row.raw} <i>+10</i>`) : `${row.raw}`;
      return `<div class="rrow ${isT ? 'taker' : ''}"><div class="nm">${avatarHtml(row.id, nameIn(st, row.id))}<span>${esc(nameIn(st, row.id))}${isT ? ' 👑' : ''}</span></div>` +
        `<div class="rpts">${ptxt} pt</div>` +
        `<div class="rcards">${row.cards.map(c => `<span class="chip c${M.col(c)} ${row.kept.includes(c) ? 'k' : 'd'}">${M.val(c)}</span>`).join('')}</div>` +
        `<div class="rtot"><div class="bar"><i data-w="${Math.min(100, st.tot[row.id] / M.TARGET * 100)}" style="width:${Math.min(100, prev / M.TARGET * 100)}%"></i></div><b data-from="${prev}" data-to="${st.tot[row.id]}"><span>${prev}</span><small> /${M.TARGET}</small></b></div></div>`;
    }).join('');
    setTimeout(() => {
      $$('#recapRows .bar i').forEach(i => { i.style.width = i.dataset.w + '%'; i.className = barClass(parseFloat(i.dataset.w) / 100 * M.TARGET); });
      $$('#recapRows .rtot b').forEach(b => countUp(b, +b.dataset.from, +b.dataset.to, 900));
    }, 350);
  }
  function tickNextButton() {
    const btn = $('#btnNext');
    if (!st || st.phase !== 'recap' || $('#recap').hidden) return;
    const left = Math.ceil((nextReadyAt - Date.now()) / 1000);
    const label = st.over ? 'Voir le résultat final 🏆' : 'Manche suivante ▶';
    btn.disabled = left > 0;
    btn.textContent = left > 0 ? label + ' (' + left + ')' : label;
    if (!seated()) btn.disabled = true;
  }
  function fillEnd() {
    const rows = st.seats.slice().sort((a, b) => st.tot[a.id] - st.tot[b.id]);
    const win = st.win.includes(myId);
    $('#endTitle').textContent = !seated() ? 'Fin de partie' : win ? '🏆 VICTOIRE !' : 'Fin de partie';
    let rank = 0, last = null;
    $('#endRows').innerHTML = rows.map((s, i) => {
      if (st.tot[s.id] !== last) { rank = i + 1; last = st.tot[s.id]; }
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank + '.';
      return `<div class="rrow ${st.win.includes(s.id) ? 'win' : ''}"><div class="nm"><span class="medal">${medal}</span>${avatarHtml(s.id, s.name)}<span>${esc(s.name)}${st.win.includes(s.id) ? ' 👑' : ''}</span></div>` +
        `<div class="rpts"><b>${st.tot[s.id]}</b> pts</div></div>`;
    }).join('');
    const host = isHost();
    $('#btnAgain').hidden = !host;
    $('#endWait').textContent = host ? '' : 'L\'hôte (' + (roster[0] ? roster[0].name : '…') + ') peut relancer une partie.';
  }

  /* ================= INTERFACE ================= */
  function bindUI() {
    addEventListener('pointerdown', () => FX.unlock(), { once: true });
    addEventListener('resize', () => { if (screen === 'table' && st) layoutHand(sortedHand()); });

    $('#btnCreate').onclick = () => joinRoom(randomCode(), true);
    $('#joinForm').onsubmit = e => { e.preventDefault(); joinRoom($('#code').value, false); };
    $('#btnLocal').onclick = startLocal;
    $('#btnLeave').onclick = () => leaveRoom(false);
    $('#btnStart').onclick = startGame;
    $('#botPlus').onclick = () => { if (botCount < 7) { botCount++; syncLocalRoster(); renderAll(); } };
    $('#botMinus').onclick = () => { if (botCount > 1) { botCount--; syncLocalRoster(); renderAll(); } };
    $('#codeBtn').onclick = () => {
      if (local) return;
      try { navigator.clipboard.writeText(code); FX.floatText(innerWidth / 2, 120, 'Code copié !', '#ffd426'); } catch (e) { /* ignoré */ }
    };

    $$('[data-act="rules"]').forEach(b => { b.onclick = () => { $('#rules').hidden = false; }; });
    $$('[data-act="closeRules"]').forEach(b => { b.onclick = () => { $('#rules').hidden = true; }; });
    $('#rules').addEventListener('click', e => { if (e.target.id === 'rules') $('#rules').hidden = true; });

    $('#btnSound').onclick = () => { FX.setMuted(!FX.isMuted()); $('#btnSound').textContent = FX.isMuted() ? '🔇' : '🔊'; };
    $('#btnLog').onclick = () => { const p = $('#log'); p.hidden = !p.hidden; renderLog(); };
    let sure = 0;
    $('#btnQuit').onclick = () => {
      if (Date.now() < sure) { leaveRoom(false); return; }
      sure = Date.now() + 3000;
      const b = $('#btnQuit'); b.classList.add('sure'); b.textContent = '❓';
      setTimeout(() => { b.classList.remove('sure'); b.textContent = '🚪'; }, 3000);
    };

    $('#hand').addEventListener('click', e => { const c = e.target.closest('.card'); if (c && c.dataset.card) onPick(+c.dataset.card); });
    $('#mine').addEventListener('click', e => { const c = e.target.closest('.card.rev'); if (c) onPick(+c.dataset.card); });
    $('#btnPlay').onclick = confirmPick;
    $$('.emos button').forEach(b => {
      b.onclick = () => {
        if (Date.now() - lastEmo < 700 || !room) return;
        lastEmo = Date.now();
        reaction(myId, b.dataset.emo);
        if (!local) room.send({ t: 'emo', e: b.dataset.emo });
      };
    });

    $('#btnNext').onclick = () => { if (!$('#btnNext').disabled) sendAct({ t: 'next' }); };
    $('#btnAgain').onclick = startGame;
    $('#btnEndQuit').onclick = () => leaveRoom(false);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
