# PKlabo — ポケカ買取ラボ オンラインショップ

GitHub Pages（画面）＋ Cloudflare Workers ＋ D1（API・データ）で動く、自前のECサイトです。

- 支払い：**銀行振込（前払い）**。Stripe のキーを登録するとクレジットカード払いが追加されます
- 在庫：注文した瞬間に在庫を確保 → 入金期限切れで自動キャンセルして在庫を戻す（15分ごと）
- 管理画面：注文（入金確認・発送・キャンセル）、商品の追加・編集・在庫の増減、CSVで一括登録

```
docs/            … GitHub Pages で公開する画面
  index.html     … ショップ（一覧・詳細・カート・購入・注文確認）
  admin.html     … 管理画面
  legal.html     … 特定商取引法に基づく表記・返品・プライバシー
  config.js      … API の URL などの設定
  style.css
worker/          … Cloudflare Worker（API）
  src/index.js
  schema.sql     … D1 のテーブル
  wrangler.toml
```

## セットアップ

### 1. D1 と Worker を作る

```bash
cd worker
npx wrangler login
npx wrangler d1 create pklabo-db
# 表示された database_id を wrangler.toml に貼る
npx wrangler d1 execute pklabo-db --remote --file=schema.sql
npx wrangler secret put ADMIN_KEY      # 管理画面のログインキー（長めのランダム文字列）
npx wrangler deploy
```

`wrangler.toml` の `[vars]` で、振込先（`BANK_INFO`）・送料・送料無料ライン・支払期限の日数を設定します。

### 2. 画面を公開する

1. `docs/config.js` の `API_BASE` を、デプロイした Worker の URL（`https://pklabo-api.xxxx.workers.dev`）に書き換える
2. GitHub の Settings → Pages → Branch: `main` / フォルダ: `/docs` で公開
3. `docs/legal.html` の【要記入】を実際の情報に書き換える

公開 URL：`https://m0ch4771.github.io/pklabo/`（管理画面は `/admin.html`）

### 3. 古物商の URL 届出

中古品をネットで販売するので、公開したサイトの URL を、許可を受けた警察署経由で届け出てください。

## 任意の設定

| 設定 | 内容 |
| --- | --- |
| `STRIPE_SECRET_KEY` | 入れるとカード払いが有効になります（`wrangler secret put`） |
| `STRIPE_WEBHOOK_SECRET` | Stripe の Webhook エンドポイント `https://<worker>/api/stripe/webhook` に `checkout.session.completed` と `checkout.session.expired` を登録して表示される署名シークレット |
| `RESEND_API_KEY` / `MAIL_FROM` | 注文・入金確認・発送のメールを自動送信（Resend でドメイン認証が必要） |
| `ADMIN_EMAIL` | 新規注文をメールで通知 |
| `DISCORD_WEBHOOK_URL` | 新規注文を Discord に通知 |

メールを設定しない場合も、お客様は注文完了ページ（ブックマーク用URL）で振込先と状況を確認できます。

## 運用の流れ（振込）

1. お客様が注文 → 在庫確保、振込先と注文番号が表示される
2. 通帳・ネットバンクの振込名義の先頭6桁（注文番号）で照合 → 管理画面で「入金確認」
3. 発送したら追跡番号を入れて「発送済みにする」
4. 期限内に入金がない注文は自動で「期限切れ」になり、在庫が戻る

## CSV 一括登録の形式

1行目に見出し（日本語でもOK）：

```
商品名,弾,型番,レアリティ,状態,カテゴリ,価格,在庫,画像URL,説明
リザードンex,黒炎の支配者,201/165,SAR,A,シングル,12800,1,https://...,センタリング良好
```

カテゴリは `シングル` / `PSA鑑定品` / `BOX` / `サプライ`（または single / psa / box / supply）。
