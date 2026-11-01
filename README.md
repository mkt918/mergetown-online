# マージタウン

六角形の街に区画を置いて会社をつくり、株を買って、合併で稼ぐ経済ゲーム（オリジナルルール）。
2〜6人、1ゲーム約10分。部屋コード（4桁の数字）で身内とオンライン対戦、またはCPU相手のひとりモード。

ルールは [docs/rules.md](docs/rules.md)。

## 現在の状況（2026-11-01）

| 項目 | 状態 |
|---|---|
| ルール（設立・成長・合併・中間決算・最終精算） | 完成。`node test/simulate.js 300` で不変条件を確認 |
| ひとりモード（CPU 1〜5体） | 完成。ブラウザで最後まで通しプレイ確認済み |
| チュートリアル（ひとりモード内。台本どおりに設立・成長・合併を体験、12手番） | 完成。`node test/tutorial.js` と、ブラウザでの通しプレイ確認済み |
| ルール早見表（ゲーム中の「ルール」ボタン） | 完成 |
| 部屋システム（作成・参加・CPU追加・ホスト引き継ぎ・代わりに進める） | 完成。ホスト＋CPU＋別アカウントのゲストで1ゲーム通し確認済み（ホスト引き継ぎ・代わりに進めるは実機未確認） |
| Firebase プロジェクト `mergetown-online`（Firestore asia-northeast1、匿名認証） | 作成済み・ルール適用済み |
| 公開（GitHub Pages） | https://mkt918.github.io/mergetown-online/ |
| ミニゲーム化 | のちに |

## ファイル

| パス | 中身 |
|---|---|
| `js/logic.js` | ルール本体。DOM を触らない純粋関数（`MergeTown`）。Node でも動く |
| `js/board.js` | 盤面の SVG 描画 |
| `js/tutorial.js` | チュートリアルの台本（盤面・手札・せんせいの動き・解説文）。DOM を触らない |
| `js/app.js` | 画面・Firestore 同期・ひとりモード・CPU の進行・解説パネルの表示 |
| `js/firebase-config.js` | Firebase のクライアント設定 |
| `css/tokens.css` | 色・余白・角丸の変数（ここ以外で色を書かない） |
| `firestore.rules` | 部屋ドキュメントのアクセス制御 |
| `test/simulate.js` | CPU だけで何百ゲームも流して不変条件を確かめる |

## 動かし方

```bash
npx --yes http-server -p 8123 -c-1
```

`http://localhost:8123` を開いて「ひとりで遊ぶ」。コンソールから `MergeTownApp.room` で状態を見られる。

ルールを変えたら必ず:

```bash
node test/simulate.js 300
node test/tutorial.js
```

チュートリアルは盤面の座標（`js/tutorial.js` の `T`）に依存している。盤面や置いたときの判定を変えたら、`test/tutorial.js` が通るか確かめる。
