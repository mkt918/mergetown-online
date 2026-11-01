// 画面と通信。ルールは js/logic.js（MergeTown）にだけ書く。
//   - オンライン: rooms/{4桁コード} の 1ドキュメントに部屋の全状態を置き、onSnapshot で購読する。
//     操作は runTransaction 内で doc を読み → MergeTown[関数名](room, uid, ...args, opts) → 書き戻す。
//   - ひとりモード: Firebase を使わず、同じ関数を手元の room にそのまま当てる。
(function () {
  'use strict';
  const L = window.MergeTown;
  const B = window.MergeTownBoard;
  const el = (id) => document.getElementById(id);

  const NAME_KEY = 'mergetown.name';
  const HEARTBEAT_MS = 20000;
  const CPU_DELAY_MS = 900;
  const LENGTH_LABEL = { short: 'みじかめ', normal: 'ふつう', long: 'ながめ' };

  let auth = null;
  let db = null;
  let uid = null;
  let realUid = null;
  let room = null;
  let roomCode = null;
  let solo = false;
  let unsubscribe = null;
  let heartbeatTimer = null;
  let cpuTimer = null;
  let busy = false;
  let serverOffset = 0;
  let buyDraft = {};
  let buyDraftKey = '';
  let seenNotice = null;
  let modalKind = null;

  const nowMs = () => Date.now() + serverOffset;
  const roomRef = () => db.collection('rooms').doc(roomCode);
  const myName = () => el('name-input').value.trim().slice(0, 12);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = (n) => Number(n).toLocaleString('ja-JP');

  // ---------------------------------------------------------------------------
  // 起動
  // ---------------------------------------------------------------------------
  function init() {
    try { el('name-input').value = localStorage.getItem(NAME_KEY) || ''; } catch (e) { /* 保存できない環境 */ }
    el('name-input').addEventListener('change', () => {
      try { localStorage.setItem(NAME_KEY, myName()); } catch (e) { /* 保存できない環境 */ }
    });
    el('create-btn').onclick = createRoom;
    el('join-btn').onclick = () => joinRoom(el('code-input').value.trim());
    el('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(el('code-input').value.trim()); });
    el('solo-btn').onclick = startSolo;
    el('wait-leave-btn').onclick = leaveRoom;
    el('game-leave-btn').onclick = () => {
      if (room && room.status === 'playing' && !solo && !confirm('ゲームの途中です。抜けても席は残り、ホストが代わりに進められます。退出しますか？')) return;
      leaveRoom();
    };
    el('copy-link-btn').onclick = copyLink;
    el('start-btn').onclick = () => act('startGame');
    el('add-cpu-btn').onclick = () => act('addCpu');
    el('wait-length').onchange = (e) => act('setLength', e.target.value);

    const params = new URLSearchParams(location.search);
    if (params.get('room')) el('code-input').value = params.get('room');

    if (typeof firebaseConfig === 'undefined' || !firebaseConfig || typeof firebase === 'undefined') {
      el('connection-status').textContent = 'オンラインは準備中（ひとりモードは遊べます）';
      el('create-btn').disabled = true;
      el('join-btn').disabled = true;
      return;
    }
    try {
      firebase.initializeApp(firebaseConfig);
      auth = firebase.auth();
      db = firebase.firestore();
    } catch (e) {
      el('connection-status').textContent = 'Firebase の初期化に失敗しました';
      console.error(e);
      return;
    }
    auth.onAuthStateChanged((user) => {
      if (!user) return;
      realUid = user.uid;
      if (!solo) uid = user.uid;
      el('connection-status').textContent = 'オンライン接続OK';
      const code = params.get('room');
      if (code && !roomCode && !solo && /^\d{4}$/.test(code) && myName()) joinRoom(code);
    });
    auth.signInAnonymously().catch((err) => {
      el('connection-status').textContent = '接続できませんでした: ' + err.message;
    });
  }

  // ---------------------------------------------------------------------------
  // 部屋
  // ---------------------------------------------------------------------------
  function needName() {
    if (myName()) return false;
    el('lobby-error').textContent = 'なまえを入れてね。';
    el('name-input').focus();
    return true;
  }

  async function createRoom() {
    el('lobby-error').textContent = '';
    if (needName()) return;
    if (!realUid) { el('lobby-error').textContent = '接続がまだ終わっていません。少し待ってね。'; return; }
    try { localStorage.setItem(NAME_KEY, myName()); } catch (e) { /* 保存できない環境 */ }
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
        const ref = db.collection('rooms').doc(code);
        const created = await db.runTransaction(async (tx) => {
          const doc = await tx.get(ref);
          // 1日以上前の部屋は上書きしてよい
          if (doc.exists && doc.data().updatedAt && nowMs() - doc.data().updatedAt.toMillis() < 86400000) return false;
          const base = L.createRoom({ uid: realUid, name: myName(), length: el('length-input').value, now: nowMs() });
          tx.set(ref, Object.assign(base, { code, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }));
          return true;
        });
        if (created) { enterRoom(code); return; }
      }
      throw new Error('空いている部屋コードが見つかりませんでした。もう一度押してね。');
    } catch (e) {
      el('lobby-error').textContent = '部屋をつくれませんでした: ' + friendly(e);
      console.error(e);
    }
  }

  async function joinRoom(code) {
    el('lobby-error').textContent = '';
    if (!/^\d{4}$/.test(code)) { el('lobby-error').textContent = '4けたの部屋コードを入れてね。'; return; }
    if (needName()) return;
    if (!realUid) { el('lobby-error').textContent = '接続がまだ終わっていません。少し待ってね。'; return; }
    try { localStorage.setItem(NAME_KEY, myName()); } catch (e) { /* 保存できない環境 */ }
    const ref = db.collection('rooms').doc(code);
    try {
      await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        if (!doc.exists) throw new Error('その部屋はありません。');
        const res = L.joinRoom(doc.data(), realUid, myName(), nowMs(), false);
        if (res.error) throw new Error(res.error);
        tx.update(ref, { players: res.room.players, order: res.room.order, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      });
      enterRoom(code);
    } catch (e) {
      el('lobby-error').textContent = friendly(e);
      console.error(e);
    }
  }

  function enterRoom(code) {
    solo = false;
    uid = realUid;
    roomCode = code;
    seenNotice = null;
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    history.replaceState({}, '', url);
    if (unsubscribe) unsubscribe();
    unsubscribe = roomRef().onSnapshot((doc) => {
      if (!doc.exists) { toast('部屋がなくなりました'); leaveRoom(); return; }
      room = doc.data();
      if (!doc.metadata.hasPendingWrites && room.updatedAt && room.updatedAt.toMillis) {
        serverOffset = room.updatedAt.toMillis() - Date.now();
      }
      render();
    }, (err) => { console.error(err); toast('接続エラー: ' + friendly(err)); });
    clearInterval(heartbeatTimer);
    const beat = () => {
      if (!roomCode) return;
      roomRef().update(new firebase.firestore.FieldPath('players', uid, 'lastSeenAt'), nowMs()).catch(() => {});
    };
    beat();
    heartbeatTimer = setInterval(() => { beat(); render(); }, HEARTBEAT_MS);
  }

  async function leaveRoom() {
    clearTimeout(cpuTimer);
    cpuTimer = null;
    closeModal();
    if (!solo && roomCode && room && room.status !== 'playing' && room.order.includes(uid)) {
      try { await runAction('leaveRoom'); } catch (e) { console.warn(e); }
    }
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    solo = false;
    uid = realUid;
    room = null;
    roomCode = null;
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState({}, '', url);
    render();
  }

  function startSolo() {
    el('lobby-error').textContent = '';
    const n = Number(el('cpu-count-input').value) || 2;
    solo = true;
    uid = 'you';
    roomCode = null;
    seenNotice = null;
    let r = L.createRoom({ uid, name: myName() || 'あなた', length: el('length-input').value, now: Date.now() });
    for (let i = 0; i < n; i++) r = L.addCpu(r, uid, {}).room;
    room = L.startGame(r, uid, { now: Date.now() }).room;
    render();
  }

  function copyLink() {
    const url = new URL(location.href);
    url.searchParams.set('room', roomCode);
    const text = url.toString();
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('リンクをコピーしました'), () => toast(text));
    else toast(text);
  }

  // ---------------------------------------------------------------------------
  // 操作
  // ---------------------------------------------------------------------------
  // CPU の手番だけ進める（人の手番を間違って進めないように中で確かめる）
  function cpuStep(r, _uid, opts) {
    const cur = L.currentUid(r);
    if (r.status !== 'playing' || !r.players[cur].cpu) return { error: 'skip' };
    return L.aiStep(r, opts);
  }
  function fnFor(name) { return name === 'cpuStep' ? cpuStep : L[name]; }

  async function runAction(name, ...args) {
    const fn = fnFor(name);
    if (solo) {
      const res = fn(room, uid, ...args, { now: Date.now() });
      if (res.error) throw new Error(res.error);
      room = res.room;
      render();
      return;
    }
    // まれに書き込みが一時的に permission-denied で弾かれることがあるので、1回だけやり直す
    try { await commit(fn, args); }
    catch (e) {
      if (e.code !== 'permission-denied') throw e;
      await new Promise((r) => setTimeout(r, 400));
      await commit(fn, args);
    }
  }

  function commit(fn, args) {
    const ref = roomRef();
    return db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      if (!doc.exists) throw new Error('部屋がありません。');
      const res = fn(doc.data(), uid, ...args, { now: nowMs() });
      if (res.error) throw new Error(res.error);
      const r = res.room;
      tx.update(ref, {
        status: r.status, hostUid: r.hostUid, order: r.order, players: r.players,
        settings: r.settings, game: r.game, updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
  }

  async function act(name, ...args) {
    if (busy) return;
    busy = true;
    try { await runAction(name, ...args); }
    catch (e) { if (e.message !== 'skip') { toast(friendly(e)); console.warn(name, e); } }
    finally { busy = false; }
    if (solo) scheduleCpu();
  }

  function friendly(e) {
    const m = (e && e.message) || String(e);
    if (/permission|PERMISSION/.test(m)) return '権限がありません（部屋の外から操作しようとしました）。';
    if (/offline|unavailable|network/i.test(m)) return '通信できませんでした。電波を確かめてね。';
    return m;
  }

  // CPU の手番: ひとりモードは手元で、オンラインはホストの端末だけが進める
  function scheduleCpu() {
    if (cpuTimer || !room || room.status !== 'playing' || modalKind === 'notice') return;
    if (!solo && room.hostUid !== uid) return;
    const cur = L.currentUid(room);
    if (!room.players[cur] || !room.players[cur].cpu) return;
    cpuTimer = setTimeout(async () => {
      cpuTimer = null;
      await act('cpuStep');
      if (!solo) scheduleCpu();
    }, CPU_DELAY_MS);
  }

  // ---------------------------------------------------------------------------
  // 描画
  // ---------------------------------------------------------------------------
  function show(screen) {
    for (const id of ['lobby-screen', 'wait-screen', 'game-screen']) el(id).classList.toggle('hidden', id !== screen);
  }

  function render() {
    if (!room) { show('lobby-screen'); return; }
    if (room.status === 'lobby') { closeModal(); renderWait(); show('wait-screen'); return; }
    renderGame();
    show('game-screen');
    checkNotice();
    scheduleCpu();
  }

  function isOffline(p) { return !solo && !p.cpu && nowMs() - (p.lastSeenAt || 0) > L.IDLE_MS; }

  function renderWait() {
    const isHost = room.hostUid === uid;
    el('wait-code').textContent = roomCode;
    el('wait-count').textContent = '（' + room.order.length + '/' + L.MAX_PLAYERS + '人）';
    el('wait-players').innerHTML = room.order.map((u) => {
      const p = room.players[u];
      const tags = (u === room.hostUid ? '<span class="tag">ホスト</span>' : '')
        + (p.cpu ? '<span class="tag">CPU</span>' : '')
        + (u === uid ? '<span class="tag">あなた</span>' : '')
        + (isOffline(p) ? '<span class="tag">通信なし</span>' : '');
      const kick = isHost && p.cpu ? '<button type="button" class="btn btn--small btn--ghost" data-kick="' + esc(u) + '">外す</button>' : '';
      return '<li><span>' + esc(p.name) + '</span>' + tags + '<span class="spacer"></span>' + kick + '</li>';
    }).join('');
    el('wait-players').querySelectorAll('[data-kick]').forEach((b) => { b.onclick = () => act('removeCpu', b.getAttribute('data-kick')); });
    el('host-tools').classList.toggle('hidden', !isHost);
    el('wait-length').value = room.settings.length;
    el('start-btn').disabled = room.order.length < L.MIN_PLAYERS;
    el('add-cpu-btn').disabled = room.order.length >= L.MAX_PLAYERS;
    const host = room.players[room.hostUid];
    el('wait-hint').textContent = isHost
      ? (room.order.length < L.MIN_PLAYERS ? 'あと' + (L.MIN_PLAYERS - room.order.length) + '人そろうと始められます（CPUも入れられます）。' : '')
      : 'ホスト（' + (host ? host.name : '?') + '）が始めるのを待っています。長さ: ' + LENGTH_LABEL[room.settings.length];
  }

  function renderGame() {
    const g = room.game;
    const cur = L.currentUid(room);
    const isMe = cur === uid && room.status === 'playing';
    el('topbar-room').textContent = solo ? 'ひとりモード' : '部屋 ' + roomCode;
    el('topbar-turn').textContent = room.status === 'ended'
      ? 'ゲーム終了'
      : '手番 ' + (g.turnCount + 1) + ' / ' + g.totalTurns + '・' + room.players[cur].name + ' の番';

    const myHand = g.hands[uid] || [];
    const playable = new Set(myHand.filter((t) => L.isPlayable(g, t)));
    B.render(el('board'), g, {
      hand: myHand,
      playable,
      onPick: (t) => { if (isMe && g.phase === 'place' && playable.has(t)) act('place', t); },
    });

    renderAction(g, cur, isMe, myHand, playable);
    renderCompanies(g);
    renderPlayers(g, cur);
    el('log').innerHTML = g.log.slice().reverse().map((t) => '<li>' + esc(t) + '</li>').join('');
  }

  const KIND_LABEL = { loose: '空き区画', found: '会社設立', grow: '成長', merge: '合併' };

  function renderAction(g, cur, isMe, myHand, playable) {
    const box = el('action-panel');
    const curName = esc(room.players[cur].name);
    if (room.status === 'ended') {
      box.innerHTML = '<p class="action-panel__title">ゲーム終了</p><button type="button" class="btn btn--primary" id="show-result">結果を見る</button>';
      el('show-result').onclick = showResults;
      return;
    }
    const handHtml = (clickable) => '<div class="hand">' + myHand.map((t) => {
      const a = L.analyzeTile(g.board, t);
      const ok = playable.has(t);
      let kind = ok ? KIND_LABEL[a.kind] : 'いまは置けない';
      if (ok && a.kind === 'grow') kind = L.companyName(a.companies[0]) + ' 成長';
      return '<button type="button" class="tile" data-tile="' + t + '"' + (clickable && ok ? '' : ' disabled') + '>'
        + '<span class="tile__label">' + L.CELLS[t].label + '</span><span class="tile__kind">' + kind + '</span></button>';
    }).join('') + (myHand.length ? '' : '<span class="hint">手札なし</span>') + '</div>';

    if (!isMe) {
      const doing = { place: '区画を選んでいます', found: '設立する会社を選んでいます', merge: '残す会社を選んでいます', buy: '株を選んでいます' }[g.phase];
      let html = '<p class="action-panel__title">' + curName + ' の番（' + doing + '）</p>';
      if (g.hands[uid]) html += '<p class="hint">あなたの手札</p>' + handHtml(false);
      const p = room.players[cur];
      if (!solo && !p.cpu && room.hostUid === uid && nowMs() - g.turnStartedAt >= L.IDLE_MS) {
        html += '<p class="hint">' + curName + ' が止まっているようです。</p><button type="button" class="btn" id="auto-turn">代わりに進める</button>';
      }
      const host = room.players[room.hostUid];
      if (!solo && room.hostUid !== uid && room.order.includes(uid) && host && isOffline(host)) {
        html += '<p class="hint">ホストとの通信が切れています。</p><button type="button" class="btn" id="take-host">ホストを引き継ぐ</button>';
      }
      box.innerHTML = html;
      if (el('auto-turn')) el('auto-turn').onclick = () => act('autoTurn');
      if (el('take-host')) el('take-host').onclick = () => act('takeHost');
      return;
    }

    if (g.phase === 'place') {
      box.innerHTML = '<p class="action-panel__title">あなたの番: 区画を1つ置こう</p>' + handHtml(true)
        + '<p class="hint">盤面の黄色いマスをタップしても置けます。</p>';
      box.querySelectorAll('.tile[data-tile]').forEach((b) => { b.onclick = () => act('place', Number(b.getAttribute('data-tile'))); });
      return;
    }
    if (g.phase === 'found' || g.phase === 'merge') {
      const ids = g.phase === 'found' ? L.availableCompanies(g) : g.pending.candidates;
      const title = g.phase === 'found' ? '設立する会社を選ぼう' : '同じ大きさなので、残す会社を選ぼう';
      box.innerHTML = '<p class="action-panel__title">' + title + '</p><div class="choice-list">'
        + ids.map((id) => '<button type="button" class="btn" data-co="' + id + '"><span class="dot dot--' + id + '"></span>' + L.companyName(id)
          + (g.phase === 'merge' ? '（' + L.sizeOf(g.board, id) + 'マス）' : '') + '</button>').join('') + '</div>';
      const fn = g.phase === 'found' ? 'chooseFound' : 'chooseSurvivor';
      box.querySelectorAll('[data-co]').forEach((b) => { b.onclick = () => act(fn, b.getAttribute('data-co')); });
      return;
    }
    renderBuy(box, g);
  }

  function renderBuy(box, g) {
    const key = g.turnCount + ':' + uid;
    if (buyDraftKey !== key) { buyDraft = {}; buyDraftKey = key; }
    const active = L.activeCompanies(g);
    const count = Object.values(buyDraft).reduce((a, b) => a + b, 0);
    const cost = active.reduce((s, id) => s + (buyDraft[id] || 0) * L.priceOf(g.board, id), 0);
    const cash = g.cash[uid];
    let html = '<p class="action-panel__title">株を買おう（' + L.MAX_BUY + '枚まで・所持金 ' + yen(cash) + '）</p>';
    if (!active.length) html += '<p class="hint">盤面に会社がないので買えません。</p>';
    else {
      html += '<ul class="buy-list">' + active.map((id) => {
        const price = L.priceOf(g.board, id);
        const n = buyDraft[id] || 0;
        const canAdd = count < L.MAX_BUY && L.sharesLeft(g, id) > n && cost + price <= cash;
        return '<li><span class="dot dot--' + id + '"></span><span class="name">' + L.companyName(id) + '　' + yen(price) + '<span class="hint">（残り' + L.sharesLeft(g, id) + '）</span></span>'
          + '<button type="button" class="btn btn--small" data-minus="' + id + '"' + (n ? '' : ' disabled') + '>−</button>'
          + '<span class="num">' + n + '</span>'
          + '<button type="button" class="btn btn--small" data-plus="' + id + '"' + (canAdd ? '' : ' disabled') + '>＋</button></li>';
      }).join('') + '</ul>';
    }
    html += '<div class="buy-summary"><span class="total">合計 ' + yen(cost) + '</span>'
      + '<button type="button" class="btn btn--primary" id="buy-done">' + (count ? '買って手番終了' : '買わずに手番終了') + '</button></div>';
    box.innerHTML = html;
    box.querySelectorAll('[data-plus]').forEach((b) => { b.onclick = () => { const id = b.getAttribute('data-plus'); buyDraft[id] = (buyDraft[id] || 0) + 1; renderBuy(box, g); }; });
    box.querySelectorAll('[data-minus]').forEach((b) => { b.onclick = () => { const id = b.getAttribute('data-minus'); buyDraft[id] = Math.max(0, (buyDraft[id] || 0) - 1); renderBuy(box, g); }; });
    el('buy-done').onclick = () => act('buy', Object.assign({}, buyDraft));
  }

  function renderCompanies(g) {
    el('company-rows').innerHTML = L.COMPANIES.map((c) => {
      const on = g.companies[c.id].active;
      const size = L.sizeOf(g.board, c.id);
      const pres = g.companies[c.id].president;
      return '<tr class="' + (on ? '' : 'off') + '"><td class="co"><span class="dot dot--' + c.id + '"></span>' + c.name + '</td>'
        + '<td class="mono">' + (on ? size : '–') + '</td>'
        + '<td class="mono">' + (on ? yen(size * 100) : '–') + '</td>'
        + '<td class="mono">' + L.sharesLeft(g, c.id) + '</td>'
        + '<td>' + (pres && room.players[pres] ? esc(room.players[pres].name) : '–') + '</td></tr>';
    }).join('');
  }

  function renderPlayers(g, cur) {
    el('player-rows').innerHTML = room.order.map((u) => {
      const p = room.players[u];
      const chips = L.IDS.filter((id) => g.shares[u][id] > 0)
        .map((id) => '<span class="chip chip--' + id + '">' + L.COMPANIES.find((c) => c.id === id).short + ' ' + g.shares[u][id]
          + (g.companies[id].president === u ? ' 社長' : '') + '</span>').join('');
      const tags = (p.cpu ? '<span class="tag">CPU</span>' : '') + (u === uid ? '<span class="tag">あなた</span>' : '')
        + (isOffline(p) ? '<span class="tag">通信なし</span>' : '');
      return '<li class="' + (u === cur && room.status === 'playing' ? 'is-turn' : '') + '"><div class="top"><span class="name">' + esc(p.name) + '</span>' + tags
        + '<span class="cash">' + yen(g.cash[u]) + '</span></div>' + (chips ? '<div class="chips">' + chips + '</div>' : '') + '</li>';
    }).join('');
  }

  // ---------------------------------------------------------------------------
  // お知らせ（合併・決算・結果）
  // ---------------------------------------------------------------------------
  function checkNotice() {
    const n = room.game.notice;
    const seq = n ? n.seq : 0;
    if (seenNotice === null) {
      // 途中から入ったときは過去のお知らせを出さない（終わっていれば結果だけ出す）
      seenNotice = seq;
      if (room.status === 'ended') showResults();
      return;
    }
    if (seq === seenNotice) return;
    seenNotice = seq;
    if (room.status === 'ended') { showResults(); return; }
    openModal('notice', '<h2>' + esc(n.title) + '</h2><ul class="modal__lines">' + n.lines.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>'
      + '<div class="modal__actions"><button type="button" class="btn btn--primary" data-close>OK</button></div>');
  }

  function showResults() {
    const g = room.game;
    const n = g.notice;
    const isHost = solo || room.hostUid === uid;
    const ranks = g.results.map((r) => '<li><span class="rank">' + r.rank + '位</span><span class="name">' + esc(room.players[r.uid].name)
      + (r.uid === uid ? '（あなた）' : '') + '</span><span class="cash">' + yen(r.cash) + '</span></li>').join('');
    openModal('result', '<h2>結果</h2><ol class="rank-list">' + ranks + '</ol>'
      + (n ? '<h3>' + esc(n.title) + '</h3><ul class="modal__lines">' + n.lines.map((l) => '<li>' + esc(l) + '</li>').join('') + '</ul>' : '')
      + '<div class="modal__actions">'
      + (isHost ? '<button type="button" class="btn btn--primary" id="again-btn">' + (solo ? 'もう一度' : '待合室へ戻る') + '</button>' : '')
      + '<button type="button" class="btn" data-close>盤面を見る</button>'
      + '<button type="button" class="btn btn--ghost" id="to-lobby-btn">ロビーへ</button></div>');
    if (el('again-btn')) el('again-btn').onclick = () => { closeModal(); if (solo) startSolo(); else act('rematch'); };
    el('to-lobby-btn').onclick = () => { closeModal(); leaveRoom(); };
  }

  function openModal(kind, html) {
    modalKind = kind;
    const m = el('modal');
    m.innerHTML = '<div class="modal__card">' + html + '</div>';
    m.classList.remove('hidden');
    m.querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => { closeModal(); scheduleCpu(); }; });
  }
  function closeModal() {
    modalKind = null;
    el('modal').classList.add('hidden');
    el('modal').innerHTML = '';
  }

  let toastTimer = null;
  function toast(text) {
    const t = el('toast');
    t.textContent = text;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  // 動作確認用（コンソールから呼べる）
  window.MergeTownApp = { get room() { return room; }, startSolo, act };

  init();
})();
