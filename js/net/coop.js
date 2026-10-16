/* ============ coop.js — partida cooperativa (hasta 4 jugadores) ============
 *
 * Quién manda en qué:
 *   ANFITRIÓN   enemigos (aparición, IA, vida, muerte), objetos del suelo,
 *               experiencia y nivel del equipo, reloj, fin de la partida.
 *   CADA UNO    su propio Pokémon: posición, vida, ataques y lo que le golpea.
 *               Sus golpes a enemigos se mandan al anfitrión, que los aplica.
 *
 * Los invitados ven COPIAS de los enemigos del anfitrión (enemy.remote) y los
 * ataques de los compañeros como "fantasmas" que no hacen daño (ver combat.js).
 *
 * Quién está eligiendo (objeto o vínculo) y quién ha elegido carta de nivel va
 * además en CADA envío (no sólo en un aviso suelto): si un aviso se pierde
 * porque la conexión parpadea, el siguiente envío lo arregla y nadie se queda
 * esperando a otro para siempre (pasaba en 2026-10).
 *
 * Mensajes (por net.js, unas 15 veces por segundo; 5 si va por el relé):
 *   invitado -> anfitrión  { k:'f', p:[estado], ev:[eventos] }
 *   anfitrión -> invitado  { k:'f', t, lv, xp, xn, ki, bo, co, p:{uid:[estado]},
 *                            e:[[id,x,y,vida,anim,dir,estados]], ev:[eventos],
 *                            ja:[x,y,anim,dir] (Arceus, sólo en la Sentencia) }
 *   anfitrión -> todos     { k:'start', seed, host, members:[{uid,name,dex,shiny}] }
 *
 * Entrar con la partida empezada (nuevos y los que se cayeron):
 *   invitado -> anfitrión  { k:'rq' }  "quiero entrar" (botón de la sala, o al
 *                           perder la conexión y recuperarla)
 *   anfitrión -> invitado  { k:'jn', seed, host, members:[{uid,name,dex,shiny,ci}],
 *                            at:[x,y], team:{...}, pz }
 *     Si el invitado sigue en esa partida (se le cortó la conexión), continúa
 *     con su Pokémon tal cual; si no, empieza una run en el minuto en que va la
 *     partida (game.js). En su primer envío el anfitrión le manda todos los
 *     enemigos y objetos del suelo; y si le llega un enemigo que no conoce, lo
 *     pide (evento 'nd') y se lo vuelven a mandar.
 *   anfitrión -> invitado  { k:'kick' }  te ha expulsado
 *   Eventos nuevos: 'mj' entra un compañero, 'ml' se va; en cada envío del
 *   anfitrión, pz:1 si ha pausado la partida para todos.
 */
G.Coop = (() => {
  const ANIMS = ['Idle', 'Walk', 'Attack', 'Shoot', 'Charge', 'Hurt', 'Faint'];
  const COLORS = ['#ffcb3d', '#5fc8ff', '#7ee07a', '#ff8ad8'];
  // Mensajes por segundo: 15 por la conexión directa y 3 por el relé de la
  // Realtime Database (apagado: 1 $ el GB).
  const RATE_FAST = 1 / 15, RATE_SLOW = 1 / 3;
  const rateFor = u => (G.Net.slow(u) ? RATE_SLOW : RATE_FAST);
  const NEAR = 950;                     // radio de enemigos que se mandan a cada uno

  let active = false, host = false, me = null, hostUid = null;
  let local = null;                     // tu Player
  const mates = new Map();              // uid -> { uid, name, color, pl, connected, q:[], flushT, xpMul }
  let outEv = [];                       // invitado: eventos para el anfitrión
  let flushT = 0;
  let hitFrom = null;                   // invitado cuyo golpe se está aplicando (no repetirle el número)
  let api = {};                         // callbacks del juego (game.js)
  let waiting = new Set();              // subida de nivel: quién falta por elegir
  let holds = new Set();                // quién está eligiendo una fusión (la partida se para para todos)
  // El anfitrión mueve a los enemigos: si cambia de pestaña (o se le congela),
  // todo se para para todos. Antes los enemigos se quedaban quietos y los demás
  // seguían jugando con una ventaja enorme.
  let hostAway = false, stalled = false, lastHostAt = 0;
  // Cartas de nivel: número de la ronda (anfitrión), la última que te ha llegado
  // y la última que has elegido (invitado). Y el último "quién elige" aplicado.
  let levelSeq = 0, levelNow = 1, seenSeq = 0, doneSeq = 0, lastHo = '';
  const STALL_MS = 2500;
  let members = [];
  let seed = 0;
  // Pausa del anfitrión para todos.
  let paused = false;
  // Invitado: se ha cortado la conexión con el anfitrión. Se espera a que
  // vuelva (net.js reintenta) en vez de acabar la partida; si tarda demasiado, sí.
  const LOST_MS = 120000;
  let lostHost = false, lostAt = 0;
  // Invitado: enemigos que llegan en los envíos y no tienes (se piden de nuevo).
  const need = new Set();
  let needAt = 0;
  // Anfitrión: quién espera a entrar (en la grieta o la Sentencia no se entra)
  // y quién se ha ido por su cuenta (a ésos no se les mete solos, sólo si lo piden).
  const pendingJoin = new Set(), leftOnPurpose = new Set();
  const lastRq = new Map();

  // ---------------- escalado de dificultad ----------------

  const scaleRate = n => 1 + 0.75 * Math.max(0, n - 1);
  const scaleHp = n => 1 + 0.3 * Math.max(0, n - 1);

  // ---------------- arranque / fin ----------------

  /**
   * @param cfg   { seed, host, members }
   * @param pl    tu Player (ya creado)
   * @param cb    { levelStart(lv), resume(), waiting(names), over(data), lost(msg), team(t), shiny(dex) }
   */
  function begin(cfg, pl, cb) {
    active = true;
    me = G.Net.uid; hostUid = cfg.host;
    host = me === hostUid;
    local = pl;
    api = cb;
    seed = cfg.seed;
    // Cada uno con su color fijo (ci), también si entra o vuelve a mitad.
    members = cfg.members.map((m, i) => Object.assign({}, m, { ci: m.ci != null ? m.ci : i }));
    mates.clear();
    outEv = []; flushT = 0; waiting = new Set(); holds = new Set();
    hostAway = false; stalled = false; lastHostAt = performance.now();
    levelSeq = 0; levelNow = 1; seenSeq = 0; doneSeq = 0; lastHo = '';
    paused = !!cfg.pz; lostHost = false; need.clear();
    pendingJoin.clear(); leftOnPurpose.clear(); lastRq.clear();
    members.forEach((m, i) => {
      let x = (i - (members.length - 1) / 2) * 34, y = 0;
      // Entras a mitad: apareces junto al anfitrión.
      if (cfg.at) { x = cfg.at[0] + (i - (members.length - 1) / 2) * 34; y = cfg.at[1] + 30; }
      if (m.uid === me) { pl.x = x; pl.y = y; pl.uid = me; pl.coopHost = host; pl.tagColor = COLORS[m.ci]; return; }
      addMate(m, x, y);
    });
  }

  /** Crea (o reconecta) a un compañero. */
  function addMate(m, x, y) {
    const old = mates.get(m.uid);
    if (old) {
      old.connected = true; old.q = []; old.flushT = 0; old.state = null; old.fresh = true;
      if (x != null) { old.pl.x = x; old.pl.y = y; old.pl.net.x = x; old.pl.net.y = y; }
      return old;
    }
    const mon = G.DEX_BY[m.dex] || G.DEX_BY[25];
    const p = new G.Player(mon, {}, !!m.shiny);
    const color = COLORS[m.ci != null ? m.ci : 0];
    p.remote = true; p.uid = m.uid; p.tag = m.name; p.tagColor = color; p.revLabel = 'Quédate a su lado';
    p.x = x || 0; p.y = y || 0;
    p.net = { x: p.x, y: p.y, ang: Math.PI / 2, walk: 0, hp: p.maxHp, maxHp: p.maxHp, dead: 0, mv: G.startMoveOf(mon.dex), ml: 1, mag: 78, aim: Math.PI / 2, rev: 0 };
    G.Sprites.preload([mon.dex], 8000, p.shiny);
    const mate = { uid: m.uid, name: m.name, color, ci: m.ci, pl: p, connected: true, q: [], flushT: 0, xpMul: 1, fresh: true };
    mates.set(m.uid, mate);
    return mate;
  }

  function end() {
    active = false; host = false; local = null;
    mates.clear(); outEv = []; waiting = new Set(); holds = new Set();
    paused = false; lostHost = false; need.clear(); pendingJoin.clear();
  }

  /** Te vas de la partida (los demás siguen). */
  function leave() {
    if (!active) return;
    if (host) {
      // Si se va el anfitrión, la partida termina para todos.
      emit(['ov', Object.assign(api.summary ? api.summary() : {}, { why: 'host' })]);
      flushAll();
    } else {
      outEv.push(['bye']);
      flushClient(true);
    }
    end();
  }

  // ---------------- lista de jugadores ----------------

  function players() {
    const out = [local];
    for (const m of mates.values()) if (m.connected) out.push(m.pl);
    return out;
  }
  function puppets() { const out = []; for (const m of mates.values()) if (m.connected) out.push(m.pl); return out; }

  /**
   * Multiplicador de la experiencia del equipo: la media de los bonus de
   * cada uno, y repartida entre los que sois (en grupo cae mucho más, y si no
   * se subiría de nivel el triple de rápido que en solitario).
   */
  function xpFactor() {
    let s = local.xpMul, n = 1;
    for (const m of mates.values()) if (m.connected) { s += m.xpMul || 1; n++; }
    return (s / n) / local.xpMul / (1 + 0.6 * (n - 1));
  }

  // ---------------- estado de un jugador ----------------

  const r1 = v => Math.round(v), r2 = v => Math.round(v * 100) / 100;

  function myState() {
    // Con un vínculo se manda la órbita si la hay (es lo único que los demás no ven por los 'c').
    const g = local.activeGroup();
    const m = g.find(x => x.kind === 'orbit') || g[0];
    return [r1(local.x), r1(local.y), r2(local.moveAngle), local.walking ? 1 : 0, r1(local.hp), r1(local.maxHp),
            local.dead ? 1 : 0, m ? m.id : '', m ? m.lvl : 1, r1(local.magnet), r2(local.aim), r2(local.xpMul),
            r2(local.reviveT || 0), api.choosing && api.choosing() ? 1 : 0, doneSeq];
  }

  function readState(a) {
    return { x: a[0], y: a[1], ang: a[2], walk: a[3], hp: a[4], maxHp: a[5], dead: a[6], mv: a[7], ml: a[8],
             mag: a[9], aim: a[10], xpMul: a[11], rev: a[12], ch: a[13], ld: a[14] };
  }

  // ---------------- envío ----------------

  /** Anfitrión: evento para todos los invitados (menos `except`). */
  function emit(ev, except) {
    if (!host) return;
    for (const m of mates.values()) if (m.connected && m.uid !== except) m.q.push(ev);
  }

  /** Anfitrión: evento sólo para los que están cerca (números de daño). */
  function emitNear(ev, x, y, except) {
    for (const m of mates.values()) {
      if (!m.connected || m.uid === except) continue;
      if (G.U.dist2(m.pl.x, m.pl.y, x, y) > 700 * 700) continue;
      if (m.q.length > 400) continue;
      m.q.push(ev);
    }
  }

  function enemyList(near) {
    const out = [];
    const r2n = NEAR * NEAR;
    for (const e of G.EnemyMgr.all()) {
      if (e.dead || G.U.dist2(e.x, e.y, near.x, near.y) > r2n) continue;
      const a = ANIMS.indexOf(e.anim.cur);
      out.push([e.id, r1(e.x), r1(e.y), Math.ceil(e.hp), a < 0 ? 0 : a, e.anim.dir,
                (e.burn > 0 ? 1 : 0) | (e.poison > 0 ? 2 : 0) | (e.shield > 0 ? 4 : 0)]);
    }
    return out;
  }

  function hostFrame(m) {
    const st = api.team();
    const p = { [me]: myState() };
    for (const o of mates.values()) {
      if (o.connected && o.uid !== m.uid && o.state) p[o.uid] = o.state;
    }
    const ev = m.q; m.q = [];
    const f = { k: 'f', t: r2(st.time), lv: st.level, xp: r2(st.xp), xn: st.xpNext, ki: st.kills, bo: st.bosses, co: st.coins, tk: [st.t1, st.t10],
                p, e: enemyList(m.pl), ev };
    const ja = G.Judgment.netState();       // Arceus en la Sentencia
    if (ja) f.ja = ja;
    // Siempre: quién está eligiendo y, si hay cartas de nivel, cuáles (ver arriba).
    f.ho = holdNames();
    if (waiting.size) f.lu = [levelSeq, levelNow];
    if (paused) f.pz = 1;
    return f;
  }

  const neEv = e => ['ne', e.id, e.dex, r1(e.x), r1(e.y), e.boss ? 1 : 0, e.shiny ? 1 : 0, Math.ceil(e.maxHp), r2(e.dmg), e.behavior];

  /** Anfitrión: todo lo que hay en el mapa, para quien acaba de entrar. */
  function snapshotFor(m) {
    for (const e of G.EnemyMgr.all()) if (!e.dead && !e.remote) m.q.push(neEv(e));
    for (const o of G.Pickups.all()) if (o.id != null) m.q.push(['pk', o.id, o.kind, r1(o.x), r1(o.y), o.value]);
    const w = G.Weather.current;     // y el clima que haga ahora
    if (w && w.left > 1) m.q.push(['wx', w.kind, Math.round(w.left)]);
  }

  function flushAll() { for (const m of mates.values()) if (m.connected) G.Net.send(m.uid, hostFrame(m)); }

  function flushClient(force) {
    if (!force && !outEv.length && flushT > 0) return;
    G.Net.toHost({ k: 'f', p: myState(), ev: outEv });
    outEv = [];
  }

  /** Cada fotograma (también en la pantalla de subida de nivel). */
  function tick(dt) {
    if (!active) return;
    if (host) {
      for (const m of mates.values()) {
        if (!m.connected) continue;
        m.flushT -= dt;
        if (m.flushT > 0) continue;
        m.flushT = rateFor(m.uid);
        G.Net.send(m.uid, hostFrame(m));
      }
    } else {
      if (!stalled && performance.now() - lastHostAt > STALL_MS) { stalled = true; updateAway(); }
      if (lostHost && performance.now() - lostAt > LOST_MS) { endLost('No se ha podido volver a conectar con el anfitrión.'); return; }
      if (need.size && performance.now() - needAt > 1000) { needAt = performance.now(); outEv.push(['nd', [...need].slice(0, 80)]); need.clear(); }
      flushT -= dt;
      if (flushT <= 0) {
        flushT = rateFor(hostUid);
        G.Net.toHost({ k: 'f', p: myState(), ev: outEv });
        outEv = [];
      }
    }
  }

  // ---------------- recepción ----------------

  G.Net.on((from, msg) => {
    if (!msg) return;
    if (msg.k === 'start') { if (G.Flow.startCoop) G.Flow.startCoop(msg); return; }
    if (msg.k === 'rq') { onJoinRequest(from); return; }
    if (msg.k === 'jn') { if (from === G.Net.hostUid && G.Flow.joinCoop) G.Flow.joinCoop(msg); return; }
    if (msg.k === 'kick') { if (from === G.Net.hostUid) kickedOut(); return; }
    if (!active || msg.k !== 'f') return;
    if (host) onClientFrame(from, msg); else if (from === hostUid) onHostFrame(msg);
  });

  G.Net.onPeer((u, mode) => {
    // Anfitrión: alguien de la sala acaba de conectar (nuevo o que vuelve): adentro.
    if (mode === 'direct') {
      if (active && host && !leftOnPurpose.has(u)) tryJoin(u);
      return;
    }
    if (!active || (mode !== 'closed' && mode !== 'failed')) return;
    if (host) mateGone(u);
    else if (u === hostUid) hostLost();
  });

  /** Invitado: se ha cortado con el anfitrión. Si la sala sigue, se espera a que vuelva. */
  function hostLost() {
    if (!G.Social.room) { endLost('Se ha perdido la conexión con el anfitrión.'); return; }
    if (lostHost) return;
    lostHost = true; lostAt = performance.now();
    updateAway();
  }

  function endLost(text) {
    if (!active) return;
    const cb = api.lost;
    end();
    if (cb) cb(text);
  }

  /** Te han expulsado (aviso del anfitrión, o tu plaza de la sala ha desaparecido). */
  function kickedOut() {
    G.Social.kickedOut();             // avisa 'room-kicked': la partida (si la hay) se acaba abajo
    if (active && !host) endLost('El anfitrión te ha expulsado de la partida.');
  }

  // Si se cierra la sala (o te sacan de ella) a mitad de partida, se acaba.
  G.Social.on(what => {
    if (!active || host) return;
    if (what === 'room-kicked') endLost('El anfitrión te ha expulsado de la partida.');
    else if (what === 'room-closed') endLost('El anfitrión ha cerrado la sala.');
  });

  function mateGone(u, quiet) {
    const m = mates.get(u);
    if (!m || !m.connected) return;
    m.connected = false;
    G.Projectiles.clearOrbs(m.pl);
    if (!quiet) G.Spawner.say(m.name + ' ha dejado la partida', 2.6);
    emit(['ml', u]);
    if (waiting.has(u)) picked(u);
    if (holds.has(u)) holdOff(u);
    if (api.mateLeft) api.mateLeft(m);
  }

  // ---------------- entrar a mitad de partida ----------------

  /** Anfitrión: alguien pide entrar (o volver). */
  function onJoinRequest(u) {
    if (!active || !host) return;
    const t = performance.now();
    if (t - (lastRq.get(u) || 0) < 2500) return;
    lastRq.set(u, t);
    leftOnPurpose.delete(u);
    // Si lo pide es que no está en la partida, aunque aquí lo parezca.
    const m = mates.get(u);
    if (m && m.connected) mateGone(u, true);
    tryJoin(u);
  }

  /** Anfitrión: mete en la partida a `u` (de la sala y conectado directo). */
  function tryJoin(u) {
    if (!active || !host || u === me) return false;
    const room = G.Social.room;
    if (!room || G.Social.isBanned(u)) return false;
    const info = room.members.find(x => x.uid === u);
    if (!info || G.Net.mode(u) !== 'direct') return false;
    const old = mates.get(u);
    if (old && old.connected) return true;
    if (players().length >= G.Social.MAX_PLAYERS) return false;
    // En la grieta o la Sentencia no se puede entrar: al salir, sí.
    if (G.Rift.inArena || G.Judgment.active) { pendingJoin.add(u); return false; }
    pendingJoin.delete(u);
    // Su color: el que tenía o el primero libre.
    let rec = members.find(x => x.uid === u);
    if (!rec) {
      const used = new Set(members.filter(x => x.uid === me || (mates.get(x.uid) || {}).connected).map(x => x.ci));
      let ci = 0;
      while (used.has(ci) && ci < COLORS.length - 1) ci++;
      rec = { uid: u, name: info.name, dex: info.dex, shiny: !!info.shiny, ci };
      members.push(rec);
    } else if (!old) {
      Object.assign(rec, { name: info.name, dex: info.dex, shiny: !!info.shiny });
    }
    const m = addMate(rec, local.x + 34, local.y + 20);
    const list = members.filter(x => x.uid === me || x.uid === u || (mates.get(x.uid) || {}).connected);
    G.Net.send(u, {
      k: 'jn', seed, host: me, members: list, at: [r1(local.x), r1(local.y)], team: api.team(), pz: paused ? 1 : 0
    });
    m.flushT = 0.3;                    // un momento para que empiece su partida
    emit(['mj', rec], u);
    const text = rec.name + (old ? ' ha vuelto a la partida' : ' se ha unido a la partida');
    G.Spawner.say(text, 2.6);
    emit(['say', text, 2.6], u);
    return true;
  }

  // Cada segundo: los que esperaban a salir de la grieta.
  setInterval(() => {
    if (!active || !host || !pendingJoin.size || G.Rift.inArena || G.Judgment.active) return;
    for (const u of [...pendingJoin]) tryJoin(u);
  }, 1000);

  // Invitado sin conexión: cuando vuelve, pide entrar (por si el aviso del anfitrión no llega).
  setInterval(() => {
    if (!active || host || !lostHost || G.Net.mode(hostUid) !== 'direct') return;
    G.Net.send(hostUid, { k: 'rq' });
  }, 3000);

  /** Invitado: ya vuelves a estar con el anfitrión, en la misma partida. */
  function resume(cfg) {
    if (!active || host) return;
    lostHost = false; stalled = false; hostAway = false; lastHostAt = performance.now();
    const listed = new Set(cfg.members.map(m => m.uid));
    for (const m of cfg.members) if (m.uid !== me) { addMate(m); if (!members.some(x => x.uid === m.uid)) members.push(m); }
    for (const m of mates.values()) if (!listed.has(m.uid) && m.connected) { m.connected = false; G.Projectiles.clearOrbs(m.pl); }
    // Lo que veías del mapa ya es viejo: el anfitrión lo vuelve a mandar todo.
    G.EnemyMgr.clearRemote();
    G.Pickups.clear();
    paused = !!cfg.pz;
    if (api.paused) api.paused(paused ? nameOf(hostUid) : null);
    updateAway();
    flushClient(true);
  }

  /** Invitado: pide entrar en la partida que ya ha empezado (botón de la sala). */
  function requestJoin() {
    if (active || !G.Net.open_ || G.Net.isHost) return false;
    if (G.Net.mode(G.Net.hostUid) !== 'direct') return false;
    G.Net.send(G.Net.hostUid, { k: 'rq' });
    return true;
  }

  // ---------------- expulsar y pausar (anfitrión) ----------------

  function kick(u) {
    if (u === me) return;
    G.Net.send(u, { k: 'kick' });
    if (active && host) {
      const m = mates.get(u);
      if (m && m.connected) {
        mateGone(u, true);
        const text = m.name + ' ha sido expulsado';
        G.Spawner.say(text, 2.6); emit(['say', text, 2.6]);
      }
      pendingJoin.delete(u);
    }
    G.Social.kick(u);
  }

  function setPaused(v) {
    if (!active || !host) return;
    paused = !!v;
    flushAll();
    if (api.paused) api.paused(paused ? nameOf(me) : null);
  }

  // --- en el anfitrión ---

  function onClientFrame(from, msg) {
    const m = mates.get(from);
    if (!m || !m.connected) return;
    // Acaba de entrar (o volver): primero, todo lo que hay en el mapa.
    if (m.fresh) { m.fresh = false; snapshotFor(m); }
    if (msg.p) { m.state = msg.p; m.pl.net = readState(msg.p); m.xpMul = m.pl.net.xpMul || 1; reconcile(from, m.pl.net); }
    for (const ev of msg.ev || []) {
      switch (ev[0]) {
        case 'h': {
          const e = G.EnemyMgr.get(ev[1]);
          if (!e || e.dead || e.remote) break;
          hitFrom = from;
          e.hurt(ev[2], ev[3], ev[4], ev[5], ev[6]);
          hitFrom = null;
          break;
        }
        case 's': {
          const e = G.EnemyMgr.get(ev[1]);
          if (!e || e.dead) break;
          if (ev[2] === 'b') e.applyBurn(ev[3]);
          else if (ev[2] === 'p') e.applyPoison(ev[3]);
          else if (ev[2] === 's') e.applySlow(ev[3]);
          break;
        }
        case 'c':
          G.Combat.ghostCast(m.pl, ev[1], ev[2], ev[3], ev[4]);
          emit(['c', from, ev[1], ev[2], ev[3], ev[4]], from);
          break;
        case 'pb':
          G.World.breakAt(ev[1], ev[2]);
          emit(['pb', ev[1], ev[2]], from);
          break;
        case 'lp': picked(from); break;
        case 'hs': holdOn(from); break;
        case 'he': holdOff(from); break;
        case 're': G.Rift.enterRequest(); break;
        case 'bye': leftOnPurpose.add(from); mateGone(from); break;
        case 'nd':                       // enemigos que no tiene: se los vuelvo a mandar
          for (const id of (ev[1] || []).slice(0, 80)) {
            const e = G.EnemyMgr.get(id);
            if (e && !e.dead && !e.remote) m.q.push(neEv(e));
          }
          break;
      }
    }
  }

  /** Anfitrión: lo que dice cada envío del invitado manda sobre avisos que se hayan perdido. */
  function reconcile(from, n) {
    if (n.ch === undefined) return;                        // versión vieja del juego
    if (n.ch && !holds.has(from)) holdOn(from);
    else if (!n.ch && holds.has(from)) holdOff(from);
    if (waiting.has(from) && n.ld >= levelSeq) picked(from);
  }

  // --- en el invitado ---

  /** Invitado: se para (o sigue) según si el anfitrión está. */
  function updateAway() { if (api.away) api.away(hostAway || stalled || lostHost ? nameOf(hostUid) : null, lostHost); }

  // Anfitrión: al irse de la pestaña avisa a todos al momento (después ya no
  // podrá mandar nada) y al volver, que sigue.
  document.addEventListener('visibilitychange', () => {
    if (!active || !host) return;
    emit(['ha', document.hidden ? 1 : 0]);
    flushAll();
  });

  function onHostFrame(msg) {
    lastHostAt = performance.now();
    if (lostHost) return;              // conexión recuperada, pero aún sin volver a la partida ('jn')
    if (stalled) { stalled = false; updateAway(); }
    if (!!msg.pz !== paused) { paused = !!msg.pz; if (api.paused) api.paused(paused ? nameOf(hostUid) : null); }
    for (const ev of msg.ev || []) applyHostEvent(ev);
    if (msg.ja) G.Judgment.netApply(msg.ja);
    // Quién elige y las cartas de nivel, aunque se haya perdido algún aviso.
    if (msg.ho) {
      const k = msg.ho.join('|');
      if (k !== lastHo) { lastHo = k; api.hold && api.hold(msg.ho); }
      if (msg.lu && msg.lu[0] > seenSeq) { seenSeq = msg.lu[0]; api.levelStart(msg.lu[1]); }
      else if (!msg.lu && api.inLevelUp && api.inLevelUp()) api.resume();
    }
    api.syncTeam({ time: msg.t, level: msg.lv, xp: msg.xp, xpNext: msg.xn, kills: msg.ki, bosses: msg.bo, coins: msg.co,
                   t1: (msg.tk || [])[0], t10: (msg.tk || [])[1] });
    for (const u in msg.p || {}) {
      const m = mates.get(u);
      if (m) m.pl.net = readState(msg.p[u]);
    }
    const now = performance.now();
    for (const a of msg.e || []) {
      const e = G.EnemyMgr.get(a[0]);
      if (!e) { need.add(a[0]); continue; }
      if (!e.remote || e.dead) continue;
      const n = e.net;
      const dts = (now - (n.last || now)) / 1000;
      if (dts > 0.02 && dts < 1) {
        n.vx = G.U.clamp((a[1] - n.x) / dts, -600, 600);
        n.vy = G.U.clamp((a[2] - n.y) / dts, -600, 600);
      } else { n.vx = 0; n.vy = 0; }
      n.x = a[1]; n.y = a[2]; n.age = 0; n.last = now;
      e.hp = Math.min(e.maxHp, a[3]);
      n.anim = a[4]; n.dir = a[5]; n.st = a[6];
    }
  }

  function applyHostEvent(ev) {
    switch (ev[0]) {
      case 'ne':
        G.EnemyMgr.addRemote({ id: ev[1], dex: ev[2], x: ev[3], y: ev[4], boss: !!ev[5], shiny: !!ev[6], hp: ev[7], dmg: ev[8], beh: ev[9] });
        break;
      case 'ed': G.EnemyMgr.removeRemote(ev[1], true); break;
      case 'eg': G.EnemyMgr.removeRemote(ev[1], false); break;
      case 'hn': { const e = G.EnemyMgr.get(ev[1]); if (e && !e.dead) e.showHurt(ev[2], ev[3]); break; }
      case 'es':
        G.Projectiles.spawn({ x: ev[1], y: ev[2], vx: ev[3], vy: ev[4], dmg: ev[5], r: ev[6], life: ev[7],
                              friendly: false, color: '#ff7a9e', vis: G.VFX.forType(ev[8]), mtype: ev[8] });
        break;
      case 'c': { const m = mates.get(ev[1]); if (m) G.Combat.ghostCast(m.pl, ev[2], ev[3], ev[4], ev[5]); break; }
      case 'item': api.item(ev[1]); break;
      case 'pk': G.Pickups.addRemote(ev[1], ev[2], ev[3], ev[4], ev[5]); break;
      case 'pc': G.Pickups.removeId(ev[1]); break;
      case 'mag': G.Pickups.pullAll(); G.FX.ring(local.x, local.y, 10, 420, '#ff9ed8', 0.6, 4); break;
      case 'bomb':
        G.FX.ring(ev[1], ev[2], 20, G.Camera.outerRadius(), '#ff7b3d', 0.5, 6);
        if (G.U.dist2(ev[1], ev[2], local.x, local.y) < 500 * 500) G.Camera.kick(0.8);
        G.Audio.sfx('break');
        break;
      case 'pb': G.World.breakAt(ev[1], ev[2]); break;
      case 'say': G.Spawner.say(ev[1], ev[2]); break;
      case 'heal': if (!local.dead) { local.heal(local.maxHp * ev[1]); G.FX.ring(local.x, local.y, 6, 60, '#5fe08a', 0.4, 3); } break;
      case 'lu': if (!ev[2] || ev[2] > seenSeq) { seenSeq = ev[2] || seenSeq; api.levelStart(ev[1]); } break;
      case 'lw': api.waiting(ev[1]); break;
      case 'lr': api.resume(); break;
      case 'hp': lastHo = (ev[1] || []).join('|'); api.hold && api.hold(ev[1]); break;
      case 'ha': hostAway = !!ev[1]; updateAway(); break;
      case 'mj': {                        // entra (o vuelve) un compañero
        const r = ev[1];
        if (!r || r.uid === me) break;
        addMate(r);
        if (!members.some(x => x.uid === r.uid)) members.push(r);
        break;
      }
      case 'ml': {                        // se va un compañero
        const m = mates.get(ev[1]);
        if (m && m.connected) { m.connected = false; G.Projectiles.clearOrbs(m.pl); }
        break;
      }
      case 'sh': api.shiny(ev[1]); break;
      case 'ov': { const cb = api.over; const d = ev[1]; end(); cb(d); break; }
      case 'rift': case 'riftx': case 'arena': case 'aw': case 'al': G.Rift.onEvent(ev); break;
      case 'jd': case 'jk': G.Judgment.onEvent(ev); break;
      case 'wx': G.Weather.onEvent(ev); break;
      case 'ev': G.Events.onNet(ev); break;
      case 'hz': G.Hazards.add(ev[1], true); break;
      case 'fxr': G.FX.ring(ev[1], ev[2], 8, ev[3], ev[4], 0.5, 3); break;
    }
  }

  // ---------------- ganchos que llaman los módulos del juego ----------------

  /** Tu ataque: los demás lo repiten como fantasma. */
  function cast(pl, m) {
    if (!active || pl !== local) return;
    if (host) emit(['c', me, m.id, m.lvl, r2(pl.aim), m.evolved ? 1 : 0]);
    else outEv.push(['c', m.id, m.lvl, r2(pl.aim), m.evolved ? 1 : 0]);
  }

  // invitado
  function hit(e, d, color, dx, dy, knock) { outEv.push(['h', e.id, d, color, r1(dx), r1(dy), knock || 0]); }
  function status(e, kind, val) { outEv.push(['s', e.id, kind, val]); }

  // anfitrión
  function hurtShown(e, d, color) { emitNear(['hn', e.id, d, color], e.x, e.y, hitFrom); }
  function enemyAdded(e) { emit(neEv(e)); }
  function enemyGone(e, died) { emit([died ? 'ed' : 'eg', e.id]); }
  function enemyShot(p, type) { emit(['es', r1(p.x), r1(p.y), r1(p.vx), r1(p.vy), r2(p.dmg), p.r, p.life, type]); }
  function pickupAdded(o) { emit(['pk', o.id, o.kind, r1(o.x), r1(o.y), o.value]); }
  function pickupGone(id) { emit(['pc', id]); }
  function say(text, secs) { emit(['say', text, secs]); }

  function propBroken(p) {
    if (host) emit(['pb', p.tx, p.ty]);
    else outEv.push(['pb', p.tx, p.ty]);
  }

  /** Anfitrión: alguien ha cogido un objeto. Devuelve true si es para ti. */
  function collected(p, who) {
    emit(['pc', p.id]);
    if (p.kind === 'magnet') emit(['mag']);
    if (p.kind === 'bomb') emit(['bomb', r1(who.x), r1(who.y)]);
    if ((p.kind === 'heal' || p.kind === 'item') && who !== local) {
      const m = mates.get(who.uid);
      if (m) m.q.push(p.kind === 'heal' ? ['heal', 0.3] : ['item', p.value]);
    }
  }

  function shinyCaught(e) { emit(['sh', e.dex]); }

  // ---------------- subida de nivel compartida ----------------

  function levelStart(level) {
    waiting = new Set([me]);
    for (const m of mates.values()) if (m.connected) waiting.add(m.uid);
    levelSeq++; levelNow = level;
    emit(['lu', level, levelSeq]);
    flushAll();
    api.levelStart(level);
    sendWaiting();
  }

  function nameOf(u) { return u === me ? (G.Social.me ? G.Social.me.name : 'Tú') : (mates.get(u) || {}).name || '?'; }

  function sendWaiting() {
    const names = [...waiting].map(nameOf);
    emit(['lw', names]);
    api.waiting(names);
  }

  /** Alguien ha elegido carta (anfitrión). */
  function picked(u) {
    if (!waiting.delete(u)) return;
    if (waiting.size) { sendWaiting(); return; }
    emit(['lr']);
    flushAll();
    api.resume();
  }

  // ---------------- fusiones: pausa para todos ----------------
  // Mientras alguien elige qué movimientos fusiona (vínculo de un legendario),
  // la partida se para para todos, como con las cartas de nivel.

  function holdNames() { return [...holds].map(nameOf); }

  /** Anfitrión: `u` empieza a elegir. */
  function holdOn(u) {
    holds.add(u);
    emit(['hp', holdNames()]); flushAll();
    api.hold && api.hold(holdNames());
  }

  /** Anfitrión: `u` ha terminado (o se ha ido). */
  function holdOff(u) {
    if (!holds.delete(u)) return;
    emit(['hp', holdNames()]); flushAll();
    api.hold && api.hold(holdNames());
  }

  /** Tú empiezas / terminas de elegir fusión. */
  function holdStart() { if (host) holdOn(me); else { outEv.push(['hs']); flushClient(true); } }
  function holdEnd() { if (host) holdOff(me); else { outEv.push(['he']); flushClient(true); } }

  /** Has elegido tu carta. */
  function localPicked() {
    if (host) picked(me);
    else { doneSeq = seenSeq; outEv.push(['lp']); flushClient(true); }
  }

  /** Anfitrión: se acabó para todos. */
  function over(data) {
    emit(['ov', data]);
    flushAll();
    end();
  }

  return {
    ANIMS, COLORS, begin, end, leave, tick, players, puppets, xpFactor, scaleRate, scaleHp,
    cast, hit, status, hurtShown, enemyAdded, enemyGone, enemyShot, pickupAdded, pickupGone, say,
    propBroken, collected, shinyCaught, levelStart, localPicked, over, holdStart, holdEnd,
    resume, requestJoin, kick, setPaused,
    get paused() { return active && paused; },
    get seed() { return seed; },
    get hostUid() { return hostUid; },
    /** Los compañeros que están ahora en la partida. */
    get connectedMates() { return [...mates.values()].filter(m => m.connected); },
    /** Anfitrión: evento para todos. Invitado: evento para el anfitrión. */
    broadcast(ev) { emit(ev); },
    toHost(ev) { if (active && !host) { outEv.push(ev); flushClient(true); } },
    mate(u) { return mates.get(u); },
    get mates() { return [...mates.values()]; },
    get members() { return members; },
    get active() { return active; },
    get isHost() { return active && host; },
    get local() { return local; }
  };
})();
