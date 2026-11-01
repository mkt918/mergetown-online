# マージタウン（20_acquire）

アクワイアと同じジャンル（タイル配置・会社設立・株・合併）の**オリジナル**経済ゲーム。プレーン HTML/CSS/JS（ビルドなし）。詳細は README.md、ルールは docs/rules.md。

## 守ること

- 既存ゲーム（アクワイア）のルールをそのまま写さない。ルールを足すときもオリジナルの仕組みにする。
- ルールは `js/logic.js` にだけ書き、DOM を触らない。変えたら `docs/rules.md` も直し、`node test/simulate.js 300` を通す。
- `room` は JSON にできる値だけ（Firestore の 1ドキュメント。配列の中に配列を入れない）。
- 色・余白・角丸は `css/tokens.css` の変数だけを使う。
- 部屋コードは4桁の数字。最大6人（`MAX_PLAYERS` と `firestore.rules` の両方）。
- 1ゲーム約10分が目標（「ふつう」= 手番合計36）。
