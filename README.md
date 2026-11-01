# マージタウン

六角形の街に区画を置いて会社をつくり、株を買って、合併で稼ぐ経済ゲーム（オリジナルルール）。
2〜6人、1ゲーム約10分。部屋コード（4桁の数字）で身内とオンライン対戦、またはCPU相手のひとりモード。

ルールは [docs/rules.md](docs/rules.md)。

## 現在の状況（2026-11-01）

| 項目 | 状態 |
|---|---|
| ルール（設立・成長・合併・中間決算・最終精算） | 完成。`node test/simulate.js 300` で不変条件を確認 |
| ひとりモード（CPU 1〜5体） | 完成。ブラウザで最後まで通しプレイ確認済み |
| 部屋システム（作成・参加・CPU追加・ホスト引き継ぎ・代わりに進める） | 完成。ホスト＋CPU＋別アカウントのゲストで1ゲーム通し確認済み（ホスト引き継ぎ・代わりに進めるは実機未確認） |
| Firebase プロジェクト `mergetown-online`（Firestore asia-northeast1、匿名認証） | 作成済み・ルール適用済み |
| 公開（GitHub Pages） | https://mkt918.github.io/mergetown-online/ |
| ミニゲーム化 | のちに |

## ファイル

| パス | 中身 |
|---|---|
| `js/logic.js` | ルール本体。DOM を触らない純粋関数（`MergeTown`）。Node でも動く |
| `js/board.js` | 盤面の SVG 描画 |
| `js/app.js` | 画面・Firestore 同期・ひとりモード・CPU の進行 |
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
```
