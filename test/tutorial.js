// チュートリアルの台本どおりに進むか確かめる。使い方: node test/tutorial.js
'use strict';
const assert = require('assert');
const L = require('../js/logic.js');
const Tut = require('../js/tutorial.js');
const { T, ME, CPU } = Tut;
const opts = { now: 0 };

let room = Tut.createRoom('テスト', 0);
const tut = Tut.begin();
const ok = (res, label) => { assert(!res.error, label + ': ' + res.error); return res.room; };
const cpuTurn = () => {
  while (room.status === 'playing' && L.currentUid(room) === CPU && room.game.turnCount < Tut.SCRIPT_END) {
    const res = Tut.cpuScript(room, opts);
    assert(res, 'cpuScript が null (turn ' + room.game.turnCount + ' ' + room.game.phase + ')');
    room = ok(res, 'cpu');
  }
};

// 初期状態
assert.strictEqual(room.game.totalTurns, 12);
assert.strictEqual(L.currentUid(room), ME);
assert.deepStrictEqual(room.game.hands[ME], [T.found, T.grow, T.merge]);

// 0,1: 説明（置けない）
assert.deepStrictEqual(Tut.gate(tut, room), []);
assert.strictEqual(Tut.current(tut, room).button, 'つぎへ');
Tut.next(tut);
assert.deepStrictEqual(Tut.gate(tut, room), []);
Tut.next(tut);
assert.deepStrictEqual(Tut.gate(tut, room), [T.found]);

// 1手番め: 設立 → 株購入
assert.strictEqual(L.analyzeTile(room.game.board, T.found).kind, 'found');
room = ok(L.place(room, ME, T.found, opts), 'place found');
assert.strictEqual(room.game.phase, 'found');
assert.strictEqual(Tut.current(tut, room).title, '会社を設立！');
room = ok(L.chooseFound(room, ME, 'a', opts), 'chooseFound');
assert.strictEqual(Tut.current(tut, room).title, '② 株を買おう');
room = ok(L.buy(room, ME, { a: 2 }, opts), 'buy a');
assert.strictEqual(room.game.turnCount, 1);

// 2手番め: せんせいが別の会社を設立
cpuTurn();
assert.strictEqual(room.game.turnCount, 2);
assert.strictEqual(room.game.companies.b.president, CPU);
assert.strictEqual(Tut.current(tut, room).title, '会社を成長させよう');
assert.deepStrictEqual(Tut.gate(tut, room), [T.grow]);

// 3手番め: 成長 → せんせいの会社の株を買う
assert.strictEqual(L.analyzeTile(room.game.board, T.grow).kind, 'grow');
room = ok(L.place(room, ME, T.grow, opts), 'place grow');
assert.strictEqual(L.sizeOf(room.game.board, 'a'), 3);
assert.strictEqual(Tut.current(tut, room).title, '株の選びかた');
room = ok(L.buy(room, ME, { b: 2 }, opts), 'buy b');

// 4手番め: せんせい
cpuTurn();
assert.strictEqual(room.game.turnCount, 4);
assert.strictEqual(room.game.board[T.cpuLoose], L.LOOSE);
assert.strictEqual(Tut.current(tut, room).title, '③ 合併！');
assert.deepStrictEqual(Tut.gate(tut, room), [T.merge]);

// 5手番め: 合併（a=3マス が b=2マス を吸収）
assert.strictEqual(L.analyzeTile(room.game.board, T.merge).kind, 'merge');
const before = room.game.cash[ME];
room = ok(L.place(room, ME, T.merge, opts), 'place merge');
assert.strictEqual(room.game.phase, 'buy', '同じ大きさではないので選択なしで合併する');
assert.strictEqual(room.game.companies.b.active, false);
assert.strictEqual(L.sizeOf(room.game.board, 'a'), 6);
assert.strictEqual(room.game.cash[ME] - before, 600, 'b を2枚: 200×1.5×2');
assert.strictEqual(room.game.notice.title, '合併！');
assert.strictEqual(Tut.current(tut, room).title, '合併のおさらい');
room = ok(L.buy(room, ME, {}, opts), 'buy none');
assert.strictEqual(room.game.turnCount, 5);

// 台本の終わり: ボタンで先へ、制限なし
assert.strictEqual(Tut.current(tut, room).button, 'ゲームをつづける');
assert.strictEqual(Tut.gate(tut, room), null);
assert.strictEqual(Tut.cpuScript(room, opts), null);
Tut.next(tut);
assert.strictEqual(Tut.current(tut, room), null);

// 残りを普通に最後まで（中間決算も通る）
let guard = 0;
while (room.status === 'playing') {
  room = ok(L.aiStep(room, {}), 'aiStep');
  if (++guard > 500) throw new Error('終わらない');
}
assert.strictEqual(room.game.midDone, true);
assert.strictEqual(room.game.turnCount, 12);
assert.strictEqual(Tut.current(tut, room), null);

// 何回やっても台本が崩れない（手札以外の引きが毎回ちがう）
for (let k = 0; k < 200; k++) {
  let r = Tut.createRoom('x', 0);
  const run = (res) => { assert(!res.error, res.error); r = res.room; };
  run(L.place(r, ME, T.found, opts)); run(L.chooseFound(r, ME, 'c', opts)); run(L.buy(r, ME, { c: 2 }, opts));
  for (let s = 0; s < 3; s++) { const res = Tut.cpuScript(r, opts); assert(res, 'cpu ' + k); run(res); }
  assert.strictEqual(r.game.companies[L.IDS.find((id) => r.game.companies[id].president === CPU)].president, CPU);
  run(L.place(r, ME, T.grow, opts)); run(L.buy(r, ME, {}, opts));
  for (let s = 0; s < 2; s++) run(Tut.cpuScript(r, opts));
  run(L.place(r, ME, T.merge, opts));
  assert.strictEqual(r.game.phase, 'buy');
}
console.log('tutorial OK');
