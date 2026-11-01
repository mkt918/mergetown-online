// マージタウンのルール本体。DOM を触らない（Node でテストできるように）。
// すべての操作は fn(room, uid, ...args, opts) → { room } か { error } を返す純粋関数。
// room は JSON にできる値だけで持つ（Firestore の 1ドキュメントにそのまま入れる）。
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // 盤面: 六角形（中心から半径4）の 61マス。軸座標 (q, r)
  // ---------------------------------------------------------------------------
  const RADIUS = 4;
  const ROWS = 'ABCDEFGHI';
  const CELLS = [];
  const INDEX = {};
  for (let r = -RADIUS; r <= RADIUS; r++) {
    let col = 0;
    for (let q = -RADIUS; q <= RADIUS; q++) {
      if (Math.abs(-q - r) > RADIUS) continue;
      col++;
      INDEX[q + ',' + r] = CELLS.length;
      CELLS.push({ q, r, label: ROWS[r + RADIUS] + col });
    }
  }
  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const NEIGHBORS = CELLS.map((c) => DIRS
    .map(([dq, dr]) => INDEX[(c.q + dq) + ',' + (c.r + dr)])
    .filter((i) => i !== undefined));

  const COMPANIES = [
    { id: 'a', name: 'あかね建設', short: 'あ' },
    { id: 'b', name: 'あおば交通', short: 'お' },
    { id: 'c', name: 'こがね銀行', short: 'こ' },
    { id: 'd', name: 'しろがね電機', short: 'し' },
    { id: 'e', name: 'むらさき不動産', short: 'む' },
  ];
  const IDS = COMPANIES.map((c) => c.id);
  const EMPTY = '';
  const LOOSE = '-';

  const SHARES_PER = 10;
  const START_CASH = 3000;
  const HAND_SIZE = 3;
  const MAX_BUY = 2;
  const INITIAL_LOTS = 3;
  const MIN_PLAYERS = 2;
  const MAX_PLAYERS = 6;
  const LENGTHS = { short: 24, normal: 36, long: 48 };
  const LOG_MAX = 40;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function round10(n) { return Math.round(n / 10) * 10; }
  function companyName(id) { return COMPANIES.find((c) => c.id === id).name; }
  function fail(msg) { return { error: msg }; }

  // ---------------------------------------------------------------------------
  // 盤面の計算
  // ---------------------------------------------------------------------------
  function sizeOf(board, id) {
    let n = 0;
    for (const v of board) if (v === id) n++;
    return n;
  }
  function priceOf(board, id) { return sizeOf(board, id) * 100; }

  // start からつながる「空でない」マスのかたまり
  function componentOf(board, start) {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const i = stack.pop();
      for (const j of NEIGHBORS[i]) {
        if (!seen.has(j) && board[j] !== EMPTY) { seen.add(j); stack.push(j); }
      }
    }
    return [...seen];
  }

  // tile を置いたら何が起きるか。空き区画は他の区画と隣り合わず、会社どうしも隣り合わない
  // （隣り合った時点で設立・成長・合併している）ので、隣のマスだけ見れば決まる。
  function analyzeTile(board, tile) {
    if (board[tile] !== EMPTY) return { kind: 'taken' };
    const comps = new Set();
    let loose = 0;
    for (const j of NEIGHBORS[tile]) {
      if (board[j] === LOOSE) loose++;
      else if (board[j] !== EMPTY) comps.add(board[j]);
    }
    const companies = [...comps];
    if (companies.length === 0) return { kind: loose > 0 ? 'found' : 'loose', companies };
    if (companies.length === 1) return { kind: 'grow', companies };
    return { kind: 'merge', companies };
  }

  function availableCompanies(game) {
    return IDS.filter((id) => !game.companies[id].active);
  }
  function activeCompanies(game) {
    return IDS.filter((id) => game.companies[id].active);
  }
  function isPlayable(game, tile) {
    const a = analyzeTile(game.board, tile);
    if (a.kind === 'taken') return false;
    if (a.kind === 'found') return availableCompanies(game).length > 0;
    return true;
  }
  function sharesLeft(game, id) {
    let held = 0;
    for (const u of Object.keys(game.shares)) held += game.shares[u][id];
    return SHARES_PER - held;
  }

  // ---------------------------------------------------------------------------
  // 部屋（ロビー）
  // ---------------------------------------------------------------------------
  function newPlayer(name, now, cpu) {
    return { name: String(name || '').slice(0, 12) || 'ななし', lastSeenAt: now || 0, cpu: !!cpu };
  }

  function createRoom({ uid, name, length, now }) {
    const players = {};
    players[uid] = newPlayer(name, now, false);
    return {
      status: 'lobby',
      hostUid: uid,
      order: [uid],
      players,
      settings: { length: LENGTHS[length] ? length : 'normal' },
      game: null,
    };
  }

  function joinRoom(room0, uid, name, now, cpu) {
    const room = clone(room0);
    if (room.order.includes(uid)) {
      room.players[uid].name = newPlayer(name).name;
      room.players[uid].lastSeenAt = now || 0;
      return { room };
    }
    if (room.status !== 'lobby') return fail('ゲームがもう始まっています。');
    if (room.order.length >= MAX_PLAYERS) return fail('部屋がいっぱいです（' + MAX_PLAYERS + '人まで）。');
    room.players[uid] = newPlayer(name, now, cpu);
    room.order.push(uid);
    return { room };
  }

  function leaveRoom(room0, uid) {
    const room = clone(room0);
    if (room.status === 'playing') return fail('ゲーム中は抜けられません。');
    if (!room.order.includes(uid)) return { room };
    room.order = room.order.filter((u) => u !== uid);
    delete room.players[uid];
    const human = room.order.find((u) => !room.players[u].cpu);
    if (room.hostUid === uid && human) room.hostUid = human;
    return { room };
  }

  // ホストが CPU を入れる・外す（CPU の手番はホストの端末が進める）
  function addCpu(room0, uid, opts) {
    if (room0.hostUid !== uid) return fail('ホストだけが操作できます。');
    let k = 1;
    while (room0.order.includes('cpu' + k)) k++;
    return joinRoom(room0, 'cpu' + k, 'CPU' + k, (opts || {}).now, true);
  }

  function removeCpu(room0, uid, target) {
    if (room0.hostUid !== uid) return fail('ホストだけが操作できます。');
    if (!room0.players[target] || !room0.players[target].cpu) return fail('CPU だけ外せます。');
    return leaveRoom(room0, target);
  }

  // ホストが通信を切ったまま戻らないとき、ほかの人がホストを引き継ぐ
  function takeHost(room0, uid, opts) {
    if (!room0.order.includes(uid) || room0.players[uid].cpu) return fail('参加者ではありません。');
    const host = room0.players[room0.hostUid];
    if (host && (opts || {}).now - host.lastSeenAt < IDLE_MS) return fail('ホストはまだ接続しています。');
    const room = clone(room0);
    room.hostUid = uid;
    return { room };
  }

  function setLength(room0, uid, length) {
    if (room0.hostUid !== uid) return fail('ホストだけが変えられます。');
    if (!LENGTHS[length]) return fail('長さの指定がおかしいです。');
    const room = clone(room0);
    room.settings.length = length;
    return { room };
  }

  // ---------------------------------------------------------------------------
  // ゲーム開始
  // ---------------------------------------------------------------------------
  function shuffle(arr, rand) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function startGame(room0, uid, opts) {
    const o = opts || {};
    const rand = o.rand || Math.random;
    if (room0.hostUid !== uid) return fail('ホストだけが始められます。');
    if (room0.status === 'playing') return fail('もう始まっています。');
    if (room0.order.length < MIN_PLAYERS) return fail(MIN_PLAYERS + '人以上で始められます。');
    const room = clone(room0);
    const n = room.order.length;
    const perPlayer = Math.ceil(LENGTHS[room.settings.length] / n);

    const board = CELLS.map(() => EMPTY);
    const bag = shuffle(CELLS.map((_, i) => i), rand);
    // 初期配置: たがいに隣り合わない3マス
    let placed = 0;
    for (let k = bag.length - 1; k >= 0 && placed < INITIAL_LOTS; k--) {
      const t = bag[k];
      if (NEIGHBORS[t].some((j) => board[j] !== EMPTY)) continue;
      board[t] = LOOSE;
      bag.splice(k, 1);
      placed++;
    }

    const hands = {};
    const cash = {};
    const shares = {};
    for (const u of room.order) {
      hands[u] = bag.splice(bag.length - HAND_SIZE, HAND_SIZE);
      cash[u] = START_CASH;
      shares[u] = {};
      for (const id of IDS) shares[u][id] = 0;
    }
    const companies = {};
    for (const id of IDS) companies[id] = { active: false, president: '' };

    const game = {
      board,
      bag,
      hands,
      cash,
      shares,
      companies,
      turnIdx: Math.floor(rand() * n),
      phase: 'place',
      pending: null,
      turnCount: 0,
      totalTurns: perPlayer * n,
      midDone: false,
      lastTile: -1,
      turnStartedAt: o.now || 0,
      log: [],
      notice: null,
      results: null,
    };
    room.game = game;
    room.status = 'playing';
    startTurn(room, o.now);
    pushLog(game, 'ゲーム開始！ ひとり' + perPlayer + '手番。' + nameOf(room, currentUid(room)) + ' から。');
    return { room };
  }

  function rematch(room0, uid) {
    if (room0.hostUid !== uid) return fail('ホストだけが操作できます。');
    if (room0.status !== 'ended') return fail('ゲームが終わっていません。');
    const room = clone(room0);
    room.status = 'lobby';
    room.game = null;
    return { room };
  }

  // ---------------------------------------------------------------------------
  // 手番
  // ---------------------------------------------------------------------------
  function currentUid(room) { return room.order[room.game.turnIdx]; }
  function nameOf(room, uid) { return room.players[uid] ? room.players[uid].name : '?'; }
  function pushLog(game, text) {
    game.log.push(text);
    if (game.log.length > LOG_MAX) game.log.splice(0, game.log.length - LOG_MAX);
  }
  function setNotice(game, title, lines) {
    const seq = game.notice ? game.notice.seq + 1 : 1;
    game.notice = { seq, title, lines };
  }

  function checkTurn(room, uid, phase) {
    if (room.status !== 'playing' || !room.game) return 'ゲーム中ではありません。';
    if (currentUid(room) !== uid) return 'あなたの番ではありません。';
    if (room.game.phase !== phase) return 'いまはその操作はできません。';
    return null;
  }

  function startTurn(room, now) {
    const game = room.game;
    game.phase = 'place';
    game.pending = null;
    game.turnStartedAt = now || 0;
    const u = currentUid(room);
    if (!game.hands[u].some((t) => isPlayable(game, t))) {
      game.phase = 'buy';
      pushLog(game, nameOf(room, u) + ' は置ける区画がないので、株を買うところから。');
    }
  }

  function place(room0, uid, tile, opts) {
    const err = checkTurn(room0, uid, 'place');
    if (err) return fail(err);
    const room = clone(room0);
    const game = room.game;
    const hand = game.hands[uid];
    if (!hand.includes(tile)) return fail('そのタイルは手札にありません。');
    if (!isPlayable(game, tile)) return fail('そのタイルはいま置けません。');
    const a = analyzeTile(game.board, tile);
    game.hands[uid] = hand.filter((t) => t !== tile);
    game.board[tile] = LOOSE;
    game.lastTile = tile;
    const who = nameOf(room, uid);
    const label = CELLS[tile].label;

    if (a.kind === 'loose') {
      pushLog(game, who + ' が ' + label + ' に区画を置いた。');
      game.phase = 'buy';
    } else if (a.kind === 'grow') {
      const id = a.companies[0];
      fill(game.board, tile, id);
      pushLog(game, who + ' が ' + label + ' に置いて ' + companyName(id) + ' が ' + sizeOf(game.board, id) + 'マスに。');
      game.phase = 'buy';
    } else if (a.kind === 'found') {
      const avail = availableCompanies(game);
      if (avail.length === 1) found(room, uid, tile, avail[0]);
      else { game.phase = 'found'; game.pending = { tile }; }
    } else {
      const sizes = a.companies.map((id) => sizeOf(game.board, id));
      const max = Math.max(...sizes);
      const candidates = a.companies.filter((id, k) => sizes[k] === max);
      if (candidates.length === 1) merge(room, uid, tile, candidates[0]);
      else { game.phase = 'merge'; game.pending = { tile, candidates }; }
    }
    return { room };
  }

  function fill(board, tile, id) {
    for (const i of componentOf(board, tile)) board[i] = id;
  }

  function found(room, uid, tile, id) {
    const game = room.game;
    fill(game.board, tile, id);
    game.companies[id] = { active: true, president: uid };
    game.shares[uid][id] += 1;
    game.phase = 'buy';
    game.pending = null;
    pushLog(game, nameOf(room, uid) + ' が ' + CELLS[tile].label + ' で ' + companyName(id) + ' を設立！（社長・株1枚）');
  }

  function chooseFound(room0, uid, id) {
    const err = checkTurn(room0, uid, 'found');
    if (err) return fail(err);
    if (!IDS.includes(id) || room0.game.companies[id].active) return fail('その会社は選べません。');
    const room = clone(room0);
    found(room, uid, room.game.pending.tile, id);
    return { room };
  }

  function chooseSurvivor(room0, uid, id) {
    const err = checkTurn(room0, uid, 'merge');
    if (err) return fail(err);
    if (!room0.game.pending.candidates.includes(id)) return fail('その会社は選べません。');
    const room = clone(room0);
    merge(room, uid, room.game.pending.tile, id);
    return { room };
  }

  // 合併: survivor 以外の会社を精算して吸収する
  function merge(room, uid, tile, survivor) {
    const game = room.game;
    const absorbed = analyzeTile(withEmpty(game.board, tile), tile).companies
      .filter((id) => id !== survivor)
      .sort((x, y) => sizeOf(game.board, y) - sizeOf(game.board, x));
    const lines = [];
    for (const id of absorbed) {
      const size = sizeOf(game.board, id);
      const price = size * 100;
      const parts = [];
      for (const u of room.order) {
        const n = game.shares[u][id];
        if (!n) continue;
        const pay = round10(n * price * 1.5);
        game.cash[u] += pay;
        game.shares[u][id] = 0;
        parts.push(nameOf(room, u) + ' ' + n + '株→+' + pay);
      }
      const pres = game.companies[id].president;
      if (pres && game.cash[pres] !== undefined) {
        game.cash[pres] += size * 100;
        parts.push('社長 ' + nameOf(room, pres) + ' +' + (size * 100));
      }
      lines.push(companyName(id) + '（' + size + 'マス・株価' + price + '）: ' + (parts.length ? parts.join(' / ') : '株主なし'));
      game.companies[id] = { active: false, president: '' };
    }
    fill(game.board, tile, survivor);
    const head = nameOf(room, uid) + ' が ' + CELLS[tile].label + ' に置いて合併！ ' + companyName(survivor) + ' が '
      + absorbed.map(companyName).join('・') + ' を吸収（' + sizeOf(game.board, survivor) + 'マスに）';
    pushLog(game, head);
    for (const l of lines) pushLog(game, '　' + l);
    setNotice(game, '合併！', [head].concat(lines));
    game.phase = 'buy';
    game.pending = null;
  }

  function withEmpty(board, tile) {
    const b = board.slice();
    b[tile] = EMPTY;
    return b;
  }

  // purchases: { 会社ID: 枚数 }。合計 MAX_BUY 枚まで。買ったら手番を終える
  function buy(room0, uid, purchases, opts) {
    const err = checkTurn(room0, uid, 'buy');
    if (err) return fail(err);
    const room = clone(room0);
    const game = room.game;
    const p = purchases || {};
    let total = 0;
    const bought = [];
    for (const id of Object.keys(p)) {
      const n = p[id] | 0;
      if (n <= 0) continue;
      if (!IDS.includes(id) || !game.companies[id].active) return fail('盤面にない会社の株は買えません。');
      if (sharesLeft(game, id) < n) return fail(companyName(id) + ' の株が足りません。');
      const cost = priceOf(game.board, id) * n;
      if (game.cash[uid] < cost) return fail('お金が足りません。');
      game.cash[uid] -= cost;
      game.shares[uid][id] += n;
      total += n;
      bought.push(companyName(id) + '×' + n);
    }
    if (total > MAX_BUY) return fail('株は1手番に' + MAX_BUY + '枚までです。');
    if (bought.length) pushLog(game, nameOf(room, uid) + ' が株を購入: ' + bought.join('、'));
    endTurn(room, uid, (opts || {}).now);
    return { room };
  }

  function endTurn(room, uid, now) {
    const game = room.game;
    refill(game, uid);
    game.turnCount++;
    if (!game.midDone && game.turnCount >= Math.floor(game.totalTurns / 2)) midterm(room);
    if (game.turnCount >= game.totalTurns) { finish(room); return; }
    game.turnIdx = (game.turnIdx + 1) % room.order.length;
    startTurn(room, now);
  }

  // 使えないタイルは山の底（配列の先頭）に戻して引き直す
  function refill(game, uid) {
    const hand = game.hands[uid];
    const keep = [];
    for (const t of hand) {
      if (isPlayable(game, t)) keep.push(t);
      else game.bag.unshift(t);
    }
    let tries = game.bag.length;
    while (keep.length < HAND_SIZE && game.bag.length && tries-- > 0) {
      const t = game.bag.pop();
      if (isPlayable(game, t)) keep.push(t);
      else game.bag.unshift(t);
    }
    game.hands[uid] = keep;
  }

  function midterm(room) {
    const game = room.game;
    game.midDone = true;
    const lines = [];
    for (const id of activeCompanies(game)) {
      const size = sizeOf(game.board, id);
      const parts = [];
      for (const u of room.order) {
        const n = game.shares[u][id];
        if (!n) continue;
        game.cash[u] += n * size * 10;
        parts.push(nameOf(room, u) + ' +' + (n * size * 10));
      }
      const pres = game.companies[id].president;
      if (pres && game.cash[pres] !== undefined) {
        game.cash[pres] += size * 30;
        parts.push('社長 ' + nameOf(room, pres) + ' +' + (size * 30));
      }
      lines.push(companyName(id) + '（' + size + 'マス）: ' + (parts.length ? parts.join(' / ') : '株主なし'));
    }
    if (!lines.length) lines.push('盤面に会社がないので配当なし');
    pushLog(game, '📊 中間決算！');
    for (const l of lines) pushLog(game, '　' + l);
    setNotice(game, '中間決算', lines);
  }

  function finish(room) {
    const game = room.game;
    const lines = [];
    for (const id of activeCompanies(game)) {
      const size = sizeOf(game.board, id);
      const price = size * 100;
      const parts = [];
      for (const u of room.order) {
        const n = game.shares[u][id];
        if (!n) continue;
        game.cash[u] += n * price;
        game.shares[u][id] = 0;
        parts.push(nameOf(room, u) + ' ' + n + '株→+' + (n * price));
      }
      const pres = game.companies[id].president;
      if (pres && game.cash[pres] !== undefined) {
        game.cash[pres] += size * 100;
        parts.push('社長 ' + nameOf(room, pres) + ' +' + (size * 100));
      }
      lines.push(companyName(id) + '（株価' + price + '）: ' + (parts.length ? parts.join(' / ') : '株主なし'));
    }
    const sorted = room.order.slice().sort((x, y) => game.cash[y] - game.cash[x]);
    const results = sorted.map((u) => ({ uid: u, cash: game.cash[u], rank: 1 + sorted.filter((v) => game.cash[v] > game.cash[u]).length }));
    game.results = results;
    game.phase = 'ended';
    game.pending = null;
    room.status = 'ended';
    pushLog(game, '🏁 ゲーム終了！');
    for (const l of lines) pushLog(game, '　' + l);
    setNotice(game, '最終精算', lines);
  }

  // ---------------------------------------------------------------------------
  // CPU の判断（ひとりモードの CPU と、ホストの「代わりに進める」で使う）
  // ---------------------------------------------------------------------------
  function scoreTile(room, uid, tile, rand) {
    const game = room.game;
    const a = analyzeTile(game.board, tile);
    const mine = game.shares[uid];
    let s = rand() * 0.8;
    if (a.kind === 'found') s += 4;
    else if (a.kind === 'grow') {
      const id = a.companies[0];
      s += mine[id] * 1.2 + (game.companies[id].president === uid ? 1.5 : 0);
      for (const u of room.order) if (u !== uid) s -= game.shares[u][id] * 0.4;
    } else if (a.kind === 'merge') {
      const sizes = a.companies.map((id) => sizeOf(game.board, id));
      const max = Math.max(...sizes);
      a.companies.forEach((id, k) => {
        if (sizes[k] === max) return;
        const gain = mine[id] * sizes[k] * 1.5 + (game.companies[id].president === uid ? sizes[k] : 0);
        let rival = 0;
        for (const u of room.order) if (u !== uid) rival += game.shares[u][id] * sizes[k] * 1.5;
        s += (gain - rival * 0.5) / 2;
      });
    }
    return s;
  }

  function aiPurchases(room, uid, rand) {
    const game = room.game;
    let cash = game.cash[uid];
    const reserve = 400;
    const picks = {};
    let count = 0;
    const ranked = activeCompanies(game).map((id) => {
      const size = sizeOf(game.board, id);
      const mine = game.shares[uid][id];
      let s = rand() * 2 + mine * 0.5;
      if (game.companies[id].president === uid) s += 1;
      if (size <= 6) s += 1;
      return { id, s, price: size * 100 };
    }).sort((x, y) => y.s - x.s);
    for (const c of ranked) {
      while (count < MAX_BUY && sharesLeft(game, c.id) - (picks[c.id] || 0) > 0 && cash - c.price >= reserve) {
        picks[c.id] = (picks[c.id] || 0) + 1;
        cash -= c.price;
        count++;
        if (rand() < 0.4) break;
      }
      if (count >= MAX_BUY) break;
    }
    return picks;
  }

  // 手番の人の操作を CPU の判断で 1段階だけ進める
  function aiStep(room0, opts) {
    const o = opts || {};
    const rand = o.rand || Math.random;
    if (room0.status !== 'playing') return fail('ゲーム中ではありません。');
    const uid = currentUid(room0);
    const game = room0.game;
    if (game.phase === 'place') {
      const tiles = game.hands[uid].filter((t) => isPlayable(game, t));
      let best = tiles[0];
      let bestS = -Infinity;
      for (const t of tiles) {
        const s = scoreTile(room0, uid, t, rand);
        if (s > bestS) { bestS = s; best = t; }
      }
      return place(room0, uid, best, o);
    }
    if (game.phase === 'found') {
      const avail = availableCompanies(game);
      return chooseFound(room0, uid, avail[Math.floor(rand() * avail.length)], o);
    }
    if (game.phase === 'merge') {
      // 自分の持ち株が少ない会社を残す（多いほうは 1.5倍で買い取ってもらう）
      const c = game.pending.candidates.slice().sort((x, y) => game.shares[uid][x] - game.shares[uid][y]);
      return chooseSurvivor(room0, uid, c[0], o);
    }
    if (game.phase === 'buy') return buy(room0, uid, aiPurchases(room0, uid, rand), o);
    return fail('進められません。');
  }

  // ホストが、止まっている人の手番を最後まで CPU の判断で進める
  const IDLE_MS = 60000;
  function autoTurn(room0, uid, opts) {
    const o = opts || {};
    if (room0.hostUid !== uid) return fail('ホストだけが操作できます。');
    if (room0.status !== 'playing') return fail('ゲーム中ではありません。');
    const target = currentUid(room0);
    if (target !== uid && (o.now || 0) - room0.game.turnStartedAt < IDLE_MS) return fail('まだ待ち時間中です。');
    let room = room0;
    while (room.status === 'playing' && currentUid(room) === target && room.game.turnCount === room0.game.turnCount) {
      const res = aiStep(room, o);
      if (res.error) return res;
      room = res.room;
    }
    return { room };
  }

  // ---------------------------------------------------------------------------
  const API = {
    RADIUS, CELLS, NEIGHBORS, COMPANIES, IDS, EMPTY, LOOSE,
    SHARES_PER, START_CASH, HAND_SIZE, MAX_BUY, MIN_PLAYERS, MAX_PLAYERS, LENGTHS, IDLE_MS,
    sizeOf, priceOf, analyzeTile, isPlayable, sharesLeft, availableCompanies, activeCompanies, companyName, currentUid,
    createRoom, joinRoom, leaveRoom, addCpu, removeCpu, takeHost, setLength, startGame, rematch,
    place, chooseFound, chooseSurvivor, buy, aiStep, autoTurn,
  };
  root.MergeTown = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
