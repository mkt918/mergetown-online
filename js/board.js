// 盤面の SVG 描画。状態は変えない。
(function (root) {
  'use strict';
  const L = root.MergeTown;
  const SIZE = 22; // 六角形の中心から角までの長さ
  const SQ3 = Math.sqrt(3);

  function center(c) {
    return { x: SIZE * SQ3 * (c.q + c.r / 2), y: SIZE * 1.5 * c.r };
  }
  function hexPoints(x, y, s) {
    const pts = [];
    for (let k = 0; k < 6; k++) {
      const a = Math.PI / 180 * (60 * k - 30);
      pts.push((x + s * Math.cos(a)).toFixed(1) + ',' + (y + s * Math.sin(a)).toFixed(1));
    }
    return pts.join(' ');
  }

  // opts: { hand: [tile], playable: Set, focus: tile, onPick(tile) }
  function render(svg, game, opts) {
    const o = opts || {};
    const hand = new Set(o.hand || []);
    const w = SIZE * SQ3 * (L.RADIUS * 2 + 1);
    const h = SIZE * (L.RADIUS * 3 + 2);
    svg.setAttribute('viewBox', (-w / 2 - 4) + ' ' + (-h / 2 - 4) + ' ' + (w + 8) + ' ' + (h + 8));
    const short = {};
    for (const c of L.COMPANIES) short[c.id] = c.short;

    let html = '';
    L.CELLS.forEach((c, i) => {
      const { x, y } = center(c);
      const v = game.board[i];
      let cls = 'cell';
      let lbl = '<text class="lbl" x="' + x + '" y="' + y + '">' + c.label + '</text>';
      if (v === L.LOOSE) cls += ' cell--loose';
      else if (v !== L.EMPTY) {
        cls += ' cell--' + v;
        lbl = '<text class="lbl lbl--on" x="' + x + '" y="' + y + '">' + short[v] + '</text>';
      } else if (hand.has(i)) {
        cls += ' cell--hand' + (o.playable && !o.playable.has(i) ? ' cell--dead' : '') + (o.focus === i ? ' cell--focus' : '');
        lbl = '<text class="lbl lbl--hand" x="' + x + '" y="' + y + '">' + c.label + '</text>';
      } else cls += ' cell--empty';
      html += '<polygon class="' + cls + '" data-tile="' + i + '" points="' + hexPoints(x, y, SIZE - 1) + '"></polygon>' + lbl;
    });
    if (game.lastTile >= 0) {
      const { x, y } = center(L.CELLS[game.lastTile]);
      html += '<polygon class="last" points="' + hexPoints(x, y, SIZE - 4) + '"></polygon>';
    }
    svg.innerHTML = html;
    svg.onclick = (e) => {
      const t = e.target.closest('[data-tile]');
      if (!t || !o.onPick) return;
      const tile = Number(t.getAttribute('data-tile'));
      if (hand.has(tile)) o.onPick(tile);
    };
  }

  root.MergeTownBoard = { render };
})(typeof globalThis !== 'undefined' ? globalThis : this);
