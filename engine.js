'use strict';
/* MOJO — moteur de règles (pur, sans DOM). Marche dans le navigateur et dans Node.
   Toutes les fonctions modifient l'état `st` en place et renvoient true si l'action est valide. */
(function (root) {
  const COLORS = [
    { key: 'blue',   name: 'Bleu',   sym: '●' },
    { key: 'green',  name: 'Vert',   sym: '✚' },
    { key: 'yellow', name: 'Jaune',  sym: '■' },
    { key: 'orange', name: 'Orange', sym: '◆' },
    { key: 'red',    name: 'Rouge',  sym: '★' }
  ];
  // [couleur, valeurs, nombre d'exemplaires de chaque valeur] -> 78 cartes
  const SPEC = [
    [0, [0, 1], 4],
    [1, [2, 3, 4], 5],
    [2, [5, 6, 7], 6],
    [3, [8, 9, 10], 7],
    [4, [11, 12], 8]
  ];
  const DECK = [];
  SPEC.forEach(([c, vals, n]) => vals.forEach(v => { for (let i = 0; i < n; i++) DECK.push({ c, v }); }));

  const HAND_SIZE = 8;
  const TARGET = 50;

  const val = id => DECK[id].v;
  const col = id => DECK[id].c;
  const threshold = n => (n <= 2 ? 2 : 3); // cartes max pour lancer le décompte

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function seatIndex(st, id) { return st.seats.findIndex(s => s.id === id); }
  function nameOf(st, id) { const s = st.seats[seatIndex(st, id)]; return s ? s.name : '?'; }
  function log(st, t) { st.log.push(t); if (st.log.length > 40) st.log.shift(); }
  const plural = (n, a, b) => (n > 1 ? b : a);

  // Score d'un ensemble de cartes : seule la plus haute de chaque couleur compte.
  function scoreOf(ids) {
    const best = [null, null, null, null, null];
    ids.forEach(id => { const c = col(id); if (best[c] === null || val(id) > val(best[c])) best[c] = id; });
    const kept = best.filter(x => x !== null);
    return { total: kept.reduce((s, id) => s + val(id), 0), kept };
  }

  function winners(st) {
    const min = Math.min(...st.seats.map(s => st.tot[s.id]));
    return st.seats.filter(s => st.tot[s.id] === min).map(s => s.id);
  }

  function newGame(seats, gid, v0) {
    const st = {
      v: v0 || 0, gid, phase: 'play', round: 0,
      seats: seats.map(s => ({ id: s.id, name: s.name })),
      tot: {}, mojo: { holder: null, side: 0 },
      hand: {}, down: {}, up: {}, draw: [], disc: [],
      turn: null, must: false, combo: 0, rec: null, over: false, win: [], ev: [], log: []
    };
    seats.forEach(s => { st.tot[s.id] = 0; });
    startRound(st, null);
    return st;
  }

  function startRound(st, starter) {
    st.round++;
    st.phase = 'play'; st.rec = null; st.must = false; st.combo = 0;
    const deck = shuffle(DECK.map((_, i) => i));
    st.hand = {}; st.down = {}; st.up = {};
    st.seats.forEach(s => { st.hand[s.id] = deck.splice(0, HAND_SIZE); st.down[s.id] = []; st.up[s.id] = []; });
    st.disc = [deck.shift()];
    st.draw = deck;
    const i = starter ? seatIndex(st, starter) : Math.floor(Math.random() * st.seats.length);
    st.turn = st.seats[i < 0 ? 0 : i].id;
    st.ev = [{ k: 'deal' }];
    log(st, `— Manche ${st.round} : ${nameOf(st, st.turn)} ouvre —`);
  }

  function drawCard(st, pid) {
    if (!st.draw.length) {
      const top = st.disc.pop();
      st.draw = shuffle(st.disc);
      st.disc = [top];
      st.ev.push({ k: 'reshuffle' });
    }
    if (!st.draw.length) return;
    const c = st.draw.pop();
    st.hand[pid].push(c);
    st.ev.push({ k: 'draw', p: pid, card: c });
  }

  function endTurn(st, pid) {
    st.must = false; st.combo = 0;
    const h = st.hand[pid];
    if (h.length && h.length <= threshold(st.seats.length)) {
      const first = !st.seats.some(s => st.down[s.id].length);
      st.down[pid] = h.splice(0);
      st.ev.push({ k: 'mojotime', p: pid, n: st.down[pid].length, first });
      log(st, `⏳ ${nameOf(st, pid)} lance le décompte (${st.down[pid].length} ${plural(st.down[pid].length, 'carte cachée', 'cartes cachées')})`);
    }
    st.turn = st.seats[(seatIndex(st, pid) + 1) % st.seats.length].id;
  }

  function endRound(st, taker, how) {
    const rows = st.seats.map(s => {
      const all = [...st.hand[s.id], ...st.down[s.id], ...st.up[s.id]];
      const sc = scoreOf(all);
      return { id: s.id, raw: sc.total, pts: sc.total, kept: sc.kept, cards: all.slice().sort((a, b) => col(a) - col(b) || val(a) - val(b)) };
    });
    const tk = rows.find(r => r.id === taker);
    const others = rows.filter(r => r.id !== taker).map(r => r.raw);
    const ok = tk.raw <= Math.min(...others);
    tk.pts = ok ? 0 : tk.raw + 10;
    rows.forEach(r => { st.tot[r.id] += r.pts; });
    st.mojo = { holder: taker, side: ok ? 0 : 10 };
    st.over = Object.values(st.tot).some(t => t >= TARGET);
    st.rec = { taker, ok, how, rows };
    st.phase = 'recap';
    st.must = false; st.combo = 0;
    st.ev.push({ k: 'roundend', p: taker, how, ok });
    log(st, `🏁 ${nameOf(st, taker)} prend le Mojo : ${ok ? '0 point !' : '+10 de pénalité'}`);
  }

  function play(st, pid, card) {
    if (st.phase !== 'play' || st.turn !== pid || st.down[pid].length) return false;
    const h = st.hand[pid];
    const i = h.indexOf(card);
    if (i < 0) return false;
    st.ev = [];
    h.splice(i, 1);
    const top = st.disc[st.disc.length - 1];
    st.disc.push(card);
    const a = val(card), b = val(top);
    const rel = a > b ? 'up' : a < b ? 'down' : 'eq';
    if (rel === 'eq') st.combo++;
    st.ev.push({ k: 'play', p: pid, card, rel, combo: rel === 'eq' ? st.combo : 0 });
    log(st, `${nameOf(st, pid)} joue ${a} ${rel === 'up' ? '▲ pioche' : rel === 'down' ? '▼' : '＝ rejoue'}`);
    if (!h.length) { endRound(st, pid, 'empty'); return true; } // main vidée en un tour
    if (rel === 'up') { drawCard(st, pid); endTurn(st, pid); }
    else if (rel === 'down') endTurn(st, pid);
    else st.must = true; // égalité : on doit rejouer
    return true;
  }

  function reveal(st, pid, card) {
    if (st.phase !== 'play' || st.turn !== pid) return false;
    const d = st.down[pid];
    const i = d.indexOf(card);
    if (i < 0) return false;
    st.ev = [];
    d.splice(i, 1);
    st.up[pid].push(card);
    st.ev.push({ k: 'reveal', p: pid, card, left: d.length });
    log(st, `${nameOf(st, pid)} révèle un ${val(card)}`);
    if (!d.length) { endRound(st, pid, 'reveal'); return true; } // dernière carte révélée
    endTurn(st, pid);
    return true;
  }

  function next(st) {
    if (st.phase !== 'recap') return false;
    if (st.over) {
      st.ev = [{ k: 'gameover' }];
      st.phase = 'end';
      st.win = winners(st);
      log(st, `🏆 Fin de partie : ${st.win.map(id => nameOf(st, id)).join(' & ')}`);
    } else startRound(st, st.mojo.holder);
    return true;
  }

  function apply(st, pid, a) {
    if (!a) return false;
    if (a.t === 'play') return play(st, pid, a.card);
    if (a.t === 'reveal') return reveal(st, pid, a.card);
    if (a.t === 'next') return next(st);
    return false;
  }

  // Petit cerveau pour les bots (mode entraînement) et les joueurs absents.
  function botAct(st, pid) {
    if (st.phase !== 'play' || st.turn !== pid) return null;
    if (st.down[pid].length) {
      const d = st.down[pid].slice().sort((a, b) => val(a) - val(b));
      return { t: 'reveal', card: d[0] };
    }
    const h = st.hand[pid];
    const topV = val(st.disc[st.disc.length - 1]);
    let best = null, bs = Infinity;
    h.forEach(c => {
      const rest = h.filter(x => x !== c);
      let s = scoreOf(rest).total + Math.random() * 1.2;
      if (val(c) > topV) s += 2.5; else if (val(c) === topV) s -= 4;
      if (!rest.length) s -= 50;
      if (s < bs) { bs = s; best = c; }
    });
    return best === null ? null : { t: 'play', card: best };
  }

  const api = { COLORS, DECK, HAND_SIZE, TARGET, val, col, threshold, scoreOf, winners, nameOf, seatIndex, newGame, apply, botAct };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Mojo = api;
})(typeof window !== 'undefined' ? window : globalThis);
