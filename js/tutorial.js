// チュートリアル（ひとりモード）。決まった盤面と手札で、設立・成長・合併をひととおり体験させる。
// DOM を触らない。画面側（app.js）は current() が返す「いまの解説」を表示するだけ。
//
// 台本（あなた = you、せんせい = cpu1）:
//   1手番め あなた  : 空き区画のとなりに置く → 会社設立 → 株を買う
//   2手番め せんせい: 別の会社を設立する
//   3手番め あなた  : 自分の会社のとなりに置く → 成長 → せんせいの会社の株を買う
//   4手番め せんせい: 空き区画を置く
//   5手番め あなた  : 2社のあいだに置く → 合併（大きい会社が残る）
//   6手番め以降     : 自由に遊ぶ（中間決算・最終精算も体験）
(function (root) {
  'use strict';
  const L = root.MergeTown || (typeof require === 'function' ? require('./logic.js') : null);
  const ME = 'you';
  const CPU = 'cpu1';
  const TOTAL_TURNS = 12;
  const SCRIPT_END = 5; // この手番数より前は台本どおりに進める

  const idx = (q, r) => L.CELLS.findIndex((c) => c.q === q && c.r === r);
  const T = {
    p1: idx(-2, 0),        // 初めからある空き区画（左）
    p2: idx(2, 0),         // 初めからある空き区画（右）
    found: idx(-1, 0),     // あなた1回め: p1 のとなり → 会社設立
    grow: idx(-1, -1),     // あなた2回め: 自分の会社のとなり → 成長
    merge: idx(0, 0),      // あなた3回め: 2社のあいだ → 合併
    cpuFound: idx(1, 0),   // せんせい1回め: p2 のとなり → 会社設立
    cpuLoose: idx(0, -3),  // せんせい2回め: どこともつながらない → 空き区画
  };

  const companyOf = (g, who) => L.IDS.find((id) => g.companies[id].president === who);
  const co = (id) => (id
    ? '<span class="chip chip--' + id + '">' + L.companyName(id) + '</span>'
    : '<strong>あなたの会社</strong>');
  const lbl = (t) => '<strong>' + L.CELLS[t].label + '</strong>';

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function createRoom(name, now) {
    let room = L.createRoom({ uid: ME, name: name || 'あなた', length: 'short', now });
    room = L.addCpu(room, ME, { now }).room;
    room.players[CPU].name = 'せんせい';
    room = L.startGame(room, ME, { now }).room;
    const g = room.game;
    g.board = L.CELLS.map(() => L.EMPTY);
    g.board[T.p1] = L.LOOSE;
    g.board[T.p2] = L.LOOSE;
    const mine = [T.found, T.grow, T.merge];
    const theirs = [T.cpuFound, T.cpuLoose];
    const used = new Set([T.p1, T.p2].concat(mine, theirs));
    const rest = shuffle(L.CELLS.map((_, i) => i).filter((i) => !used.has(i)));
    theirs.push(rest.pop());
    g.hands[ME] = mine;
    g.hands[CPU] = theirs;
    g.bag = rest;
    g.turnIdx = 0;
    g.turnCount = 0;
    g.totalTurns = TOTAL_TURNS;
    g.midDone = false;
    g.phase = 'place';
    g.pending = null;
    g.lastTile = -1;
    g.turnStartedAt = now || 0;
    g.log = ['チュートリアル開始！'];
    g.notice = null;
    g.results = null;
    return room;
  }

  // せんせい（CPU）の台本どおりの動き。台本が終わったら null（あとは普通の CPU）
  function cpuScript(room, opts) {
    const g = room.game;
    if (g.turnCount >= SCRIPT_END || L.currentUid(room) !== CPU) return null;
    if (g.turnCount === 1) {
      if (g.phase === 'place') return L.place(room, CPU, T.cpuFound, opts);
      if (g.phase === 'found') return L.chooseFound(room, CPU, L.availableCompanies(g)[0], opts);
      if (g.phase === 'buy') {
        const own = companyOf(g, CPU);
        return L.buy(room, CPU, own ? { [own]: 1 } : {}, opts);
      }
    }
    if (g.turnCount === 3) {
      if (g.phase === 'place') return L.place(room, CPU, T.cpuLoose, opts);
      if (g.phase === 'buy') {
        const yours = companyOf(g, ME);
        return L.buy(room, CPU, yours ? { [yours]: 1 } : {}, opts);
      }
    }
    return null;
  }

  // 解説の台本。done(g) が true になったら次へ。button があるものは押して次へ。
  // tiles: そのあいだ置いてよい区画（[] = どれも置けない）。focus: 盤面で目立たせる区画
  function build(g) {
    const me = companyOf(g, ME);
    const cpu = companyOf(g, CPU);
    const A = co(me);
    const B = co(cpu);
    const aSize = me ? L.sizeOf(g.board, me) : 2;
    return [
      { // 0
        title: 'ようこそ、マージタウンへ！', button: 'つぎへ', tiles: [],
        body: '<p>区画を置いて<strong>会社</strong>をつくり、<strong>株</strong>を買い、<strong>合併</strong>で稼ぐゲームです。'
          + 'ゲームが終わったときに<strong>いちばんお金を持っている人</strong>の勝ち。</p>'
          + '<p>六角形のマスが街です。茶色のマスは<strong>空き区画</strong>（まだどの会社でもない区画）、'
          + '黄色いマスは<strong>あなたの手札</strong>。会社は色つきで表示されます。</p>',
      },
      { // 1
        title: '1回の手番でやること', button: 'つぎへ', tiles: [],
        body: '<ol><li><strong>区画を1枚置く</strong></li><li><strong>株を買う</strong>（最大2枚・買わなくてもOK）</li>'
          + '<li>山札から自動で引いて、手札が3枚にもどる</li></ol>'
          + '<p>全員が同じ回数だけ手番をします。このチュートリアルは6手番ずつ。まず1枚置いてみましょう。</p>',
      },
      { // 2
        title: '① 区画を置こう', tiles: [T.found], focus: T.found,
        done: (gg) => gg.board[T.found] !== L.EMPTY,
        body: '<p>空き区画（茶色）のとなりに置くと、2つがつながって<strong>会社が生まれます</strong>。</p>'
          + '<p>太い枠の ' + lbl(T.found) + ' をタップして置いてみよう。</p>',
      },
      { // 3
        title: '会社を設立！',
        done: (gg) => !!companyOf(gg, ME),
        body: '<p>どの会社にするか、好きなものを選んでください。</p>'
          + '<p>つくった人は<strong>社長</strong>になり、その会社の<strong>株を1枚</strong>もらえます。</p>',
      },
      { // 4
        title: '② 株を買おう',
        done: (gg) => gg.turnCount >= 1,
        body: '<p>' + A + 'は' + aSize + 'マス。<strong>株価 = マス数 × 100</strong> なので、1株 ' + (aSize * 100) + ' です。</p>'
          + '<p>株は1手番に<strong>2枚まで</strong>。ゲームの最後に、持っている株は株価でお金に変わります。'
          + '会社が大きくなるほど株は値上がり！</p>'
          + '<p>下の「＋」で2枚選んで「買って手番終了」を押そう。</p>',
      },
      { // 5
        title: 'せんせいの番', cpu: true,
        done: (gg) => gg.turnCount >= 2,
        body: '<p>せんせい（CPU）の番です。何をするか見ていよう。</p>',
      },
      { // 6
        title: '会社を成長させよう', tiles: [T.grow], focus: T.grow,
        done: (gg) => gg.board[T.grow] !== L.EMPTY,
        body: '<p>せんせいは' + B + 'をつくりました。</p>'
          + '<p>会社の<strong>となり</strong>に区画を置くと、その会社が大きくなります（つながった空き区画もまとめて取りこみます）。</p>'
          + '<p>' + lbl(T.grow) + ' を置くと、' + A + 'が3マス・株価300になります。</p>',
      },
      { // 7
        title: '株の選びかた',
        done: (gg) => gg.turnCount >= 3,
        body: '<p>' + B + 'はまだ小さな会社で、株が安い（1株200）。</p>'
          + '<p><strong>小さい会社の株は、あとでおいしくなることがあります。</strong>理由は次の手番で！</p>'
          + '<p>' + B + 'を2枚買ってみよう。</p>',
      },
      { // 8
        title: 'せんせいの番', cpu: true,
        done: (gg) => gg.turnCount >= 4,
        body: '<p>せんせいの番です。見ていよう。</p>',
      },
      { // 9
        title: '③ 合併！', tiles: [T.merge], focus: T.merge,
        done: (gg) => gg.board[T.merge] !== L.EMPTY,
        body: '<p>盤面に2つの会社が向かい合っています。そのあいだの ' + lbl(T.merge) + ' に置くと、<strong>合併</strong>が起きます。</p>'
          + '<p><strong>大きい会社が小さい会社を吸収</strong>します。' + A + '（3マス）と' + B + '（2マス）なので、' + A + 'が残ります。</p>'
          + '<p>' + lbl(T.merge) + ' を置いてみよう。</p>',
      },
      { // 10
        title: '合併のおさらい',
        done: (gg) => gg.turnCount >= 5,
        body: '<p>吸収された会社の株を持っていた人は、1枚につき<strong>株価×1.5</strong>で買い取ってもらえます。'
          + 'さっきの「小さい会社の株」がここで効きます。</p>'
          + '<p>吸収された会社の<strong>社長</strong>には、さらにボーナス（マス数×100）。'
          + '吸収された会社は盤面から消えて、また新しく設立できるようになります。</p>'
          + '<p>買い取りのお金が入ったら、株をもう一度買って手番を終えよう。</p>',
      },
      { // 11
        title: 'あとは自由に！', button: 'ゲームをつづける', tiles: null,
        body: '<ul><li>ゲームの半分（6手番め）で<strong>中間決算</strong>：株1枚ごとにマス数×10の配当、社長はさらにマス数×30</li>'
          + '<li>最後に<strong>最終精算</strong>：株は株価でお金に、社長にはマス数×100</li>'
          + '<li>コツ：社長になる／いくつもの会社の株を持つ／合併のタイミングをねらう</li></ul>'
          + '<p>わからなくなったら、右上の「ルール」で早見表が見られます。</p>',
      },
    ];
  }

  function begin() { return { step: 0 }; }

  // いまの解説（終わっていれば null）。条件を満たした解説は先へ進める
  function current(tut, room) {
    if (!tut || !room || !room.game || room.status === 'ended') return null;
    const g = room.game;
    const steps = build(g);
    while (tut.step < steps.length && steps[tut.step].done && steps[tut.step].done(g)) tut.step++;
    return tut.step < steps.length ? steps[tut.step] : null;
  }

  function next(tut) { tut.step++; }

  // 置いてよい区画。null = 制限なし（台本が終わった）
  function gate(tut, room) {
    if (!tut || !room || !room.game || room.status === 'ended') return null;
    if (room.game.turnCount >= SCRIPT_END) return null;
    const step = current(tut, room);
    if (!step || step.tiles === null) return null;
    return step.tiles || [];
  }

  const NOTES = {
    '中間決算': 'ゲームの半分が終わったので配当です。株を持っているだけでお金がもらえ、社長はさらに多くもらえます。',
    '合併！': '合併です。吸収された会社の株主は1枚=株価×1.5で買い取り、社長にはボーナスが入ります。',
    '最終精算': 'ゲーム終了です。持っている株は株価でお金に変わり、社長にはさらにボーナス。いちばんお金を持っている人の勝ち！',
  };
  function noticeNote(title) { return NOTES[title] || ''; }

  const API = { createRoom, begin, current, next, gate, cpuScript, noticeNote, T, ME, CPU, SCRIPT_END };
  root.MergeTownTutorial = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
