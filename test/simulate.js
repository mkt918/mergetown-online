// CPU だけでゲームを最後まで流し、ルールの不変条件と結果の傾向を確かめる。
// 使い方: node test/simulate.js [ゲーム数]
'use strict';
const L = require('../js/logic.js');

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function check(room, label) {
  const g = room.game;
  const fail = (m) => { throw new Error(label + ': ' + m); };
  for (const id of L.IDS) {
    if (L.sharesLeft(g, id) < 0) fail(id + ' の株が配りすぎ');
    const cells = g.board.map((v, i) => (v === id ? i : -1)).filter((i) => i >= 0);
    if (g.companies[id].active !== (cells.length > 0)) fail(id + ' の active と盤面が食い違い');
    if (cells.length && cells.length < 2) fail(id + ' が1マス');
  }
  // 設立・合併の選択待ちのあいだは、置いたマスが仮に空き区画になっている
  if (!g.pending) g.board.forEach((v, i) => {
    if (v === L.EMPTY) return;
    for (const j of L.NEIGHBORS[i]) {
      const w = g.board[j];
      if (w === L.EMPTY) continue;
      if (v === L.LOOSE || w === L.LOOSE) fail('空き区画が隣り合っている ' + i + '-' + j);
      if (v !== w) fail('会社どうしが隣り合っている ' + v + w);
    }
  });
  for (const u of room.order) {
    if (g.cash[u] < 0) fail(u + ' の所持金がマイナス');
    if (g.hands[u].length > L.HAND_SIZE) fail(u + ' の手札が多すぎ');
  }
}

const games = Number(process.argv[2] || 200);
const stats = { merges: 0, founds: 0, turns: 0, winCash: 0, lowCash: 0, games: 0, steps: 0 };
const byN = {};
for (let k = 0; k < games; k++) {
  const rand = seeded(k + 1);
  const n = 2 + (k % 5);
  let room = L.createRoom({ uid: 'p0', name: 'P0', length: 'normal', now: 0 });
  for (let i = 1; i < n; i++) room = L.joinRoom(room, 'p' + i, 'P' + i, 0, true).room;
  room = L.startGame(room, 'p0', { rand }).room;
  let guard = 0;
  while (room.status === 'playing') {
    const res = L.aiStep(room, { rand });
    if (res.error) throw new Error('game ' + k + ': ' + res.error + ' phase=' + room.game.phase);
    const before = room.game;
    room = res.room;
    if (room.game.notice && (!before.notice || room.game.notice.seq !== before.notice.seq) && room.game.notice.title === '合併！') stats.merges++;
    if (L.activeCompanies(room.game).length > L.activeCompanies(before).length) stats.founds++;
    check(room, 'game ' + k);
    if (++guard > 1000) throw new Error('game ' + k + ' が終わらない');
    stats.steps++;
  }
  const g = room.game;
  stats.turns += g.turnCount;
  stats.winCash += g.results[0].cash;
  stats.lowCash += g.results[g.results.length - 1].cash;
  stats.games++;
  byN[n] = byN[n] || { games: 0, first: 0 };
  byN[n].games++;
}
const avg = (x) => Math.round(x / stats.games);
console.log('games', stats.games, 'OK');
console.log('平均手番', avg(stats.turns), '/ 合併', (stats.merges / stats.games).toFixed(1), '/ 設立', (stats.founds / stats.games).toFixed(1));
console.log('1位の平均', avg(stats.winCash), '/ 最下位の平均', avg(stats.lowCash));
