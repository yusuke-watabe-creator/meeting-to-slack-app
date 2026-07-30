# 商談メモ → Slack / Gmail 連携ツール（ブラウザ単体版）

Cowork非依存。静的ファイル一式をhttp(s)で配信するだけで動く。文字起こしのAI抽出だけ、APIキーを安全に保つための小さな中継サーバー（Cloudflare Worker）を使う。

## ファイル構成
- `index.html` — UI本体
- `config.js` — 環境設定値（Slack Webhook URL / Google OAuth クライアントID / 抽出Worker URL）※要編集
- `constants.js` — 固定値（社内ドメイン、CCアドレス、担当者メンション一覧）
- `slack.js` — Slack Incoming Webhookへの投稿処理
- `gmail.js` — Google Identity Services認証、Gmail検索・スレッド取得・下書き作成（Gmail REST API直接呼び出し）
- `app.js` — UIイベントのワイヤリング
- `worker/` — 文字起こし→AI抽出プロキシ（Cloudflare Worker）。GEMINI_API_KEYはここにだけ保管し、ブラウザには渡さない。同じWorkerが商談前準備（企業分析・商談トーク生成）のプロキシも兼ねる。
- `office.html` / `orders.html` / `prep.html` — バーチャルオフィス／資料作成会社／商談前準備（企業分析）の各画面。いずれもFirebase Realtime DBでタスク・発注・売上目標を共有する。

## セットアップ手順

### 1. Slack Incoming Webhookの発行
Slack管理画面で `#渡部チーム--26年` チャンネル宛のIncoming Webhookを発行し、URLを `config.js` の `SLACK_WEBHOOK_URL` に設定する。

> 注意: Incoming Webhook経由の投稿は「Incoming Webhook」というアプリ名で投稿され、投稿者本人のアカウント名にはならない。事前にチームへ共有しておくこと。
> また、ブラウザからのfetchはCORSの都合上レスポンスを読み取れない（`mode:'no-cors'`で送信）ため、アプリ上では送信成否を確認できない。到達確認はSlack側で行うこと。

### 2. Google Cloud OAuth設定（Gmail連携・バーチャルオフィスのカレンダー連携用）
1. Google Cloud Consoleでプロジェクトを作成
2. OAuth同意画面: **User Type: Internal**（`gmotech.jp`組織限定）に設定 → Google審査不要
3. OAuth 2.0 クライアントID（種類: **ウェブアプリケーション**）を作成
   - 「承認済みのJavaScript生成元」に、実際にホスティングするURL（例: `https://xxx.example.com`）を登録
4. 発行されたクライアントIDを `config.js` の `GOOGLE_CLIENT_ID` に設定
5. **Gmail API** と **Calendar API** をそれぞれ「APIとサービス」→「ライブラリ」から有効化する
6. 必要スコープ（コード側で要求済み、Console側の追加設定は不要）:
   - `gmail.readonly`（スレッド検索・ヘッダー取得）
   - `gmail.compose`（下書き作成）
   - `calendar.freebusy`（バーチャルオフィス: 予定の詳細は見ず「今Busyかどうか」だけ取得）
   - Calendar連携は、閲覧する側のGoogleアカウントが対象者の空き時間（Free/Busy）を見られる権限を持っている必要がある。同一Google Workspaceドメイン内であれば通常デフォルトで閲覧可能。

### 3. 文字起こしAI抽出用Workerのデプロイ（Cloudflare + Gemini API）
課金・クレジットカード登録が一切不要な組み合わせ（Google Gemini APIの無料枠 + Cloudflare Workersの無料枠）を採用。

1. [Google AI Studio](https://aistudio.google.com/apikey)でAPIキーを発行する（Googleアカウントのみで可、カード登録不要）
2. [Cloudflareアカウント](https://dash.cloudflare.com/sign-up)を用意する（無料プランでOK、カード登録不要）
3. ローカルに `wrangler` CLIを用意し、`worker/` フォルダで認証する
   ```
   npm install -g wrangler
   cd worker
   wrangler login
   ```
   （ブラウザが開くのでCloudflareアカウントで承認する）
4. APIキーをシークレットとして登録する（このコマンドは自分の端末で実行し、キー自体はプロンプトに直接貼り付ける。ファイルやコードには一切書かない）
   ```
   wrangler secret put GEMINI_API_KEY
   ```
5. デプロイする
   ```
   wrangler deploy
   ```
   完了すると `https://meeting-to-slack-extract.<あなたのアカウント>.workers.dev` のようなURLが発行される。
6. そのURLを `config.js` の `EXTRACT_API_URL` に設定する
7. `worker/src/index.js` 内の `ALLOWED_ORIGIN` が実際のホスティング先URLと一致しているか確認する（異なる場合はCORSエラーになる）
8. 商談前準備（`prep.html`）の企業分析は、Anthropic APIではなく既存と同じ`GEMINI_API_KEY`・同じWorkerで動く（**追加のAPIキーや課金設定は不要**）。ただしGemini APIの「Google検索グラウンディング」機能は無料枠では使えず429エラーになることを確認したため、**Web検索は行わずGemini自身の学習知識だけで回答する方式**に変更済み（店舗数や最新の競合動向などの精度は下がるが、課金設定なしで動く）。既存Workerを更新した際は `wrangler deploy` の再実行を忘れないこと。

### 4. ホスティング
社内向けの静的ホスティング環境（GitHub Pages等）にファイル一式をアップロードする。

> **重要:** `file://` で開くとGoogle OAuthのオリジン制約に引っかかるため使用不可。必ずhttp(s)で配信されるURLでアクセスすること。

## 動作確認
- ローカルで確認する場合は `npx serve .` などの簡易静的サーバー経由で開く（`file://`不可）。
- Slack送信・Gmail連携・AI抽出は、それぞれ実際の `SLACK_WEBHOOK_URL` / `GOOGLE_CLIENT_ID` / `EXTRACT_API_URL` を設定するまでダミー値のままでOK（未設定時は明示的なエラーメッセージが表示される）。

## 既知の制約
- Slack投稿の成否はアプリ上では確認できない（Incoming WebhookのCORS仕様のため）。
- Gmail下書き作成はブラウザ発行のアクセストークン（Google Identity Services Token Client）に依存するため、トークンの有効期限が切れた場合は初回操作時と同様に再度Googleログインが求められる。
- AI抽出（Worker経由）はGoogle Gemini APIの無料枠を利用。社内利用規模なら無料枠内に収まる想定で、課金設定は不要。
- 商談前準備（`prep.html`）の企業分析は、当初の仕様書ではAnthropic API（Claude + web_searchツール）を想定していたが、課金・カード登録が一切できない制約があるため代替実装にしている。まずGemini APIの「Google検索グラウンディング」機能を試したが、無料枠では429エラー（quota exceeded、課金設定が実質必要）になることを確認したため、**Web検索を行わずGemini自身の学習知識だけで回答する方式**に変更した。そのため、店舗数・競合の最新動向・住所・業界ニュース（常に空）・サイテーション/構造化データの実際の確認（常に"不明"）は仕様書ほどの精度は出ない。将来的に精度を上げたい場合は、Google Custom Search等の別の無料検索APIをWorker側から呼び出して結果をプロンプトに埋め込む方式が候補になる（本実装ではコスト・複雑さの都合で見送った）。
- 手動チェック項目（口コミ返信・写真オーナー提供・最新情報の有無）はセッション内のみ保持され、ページを再読み込みすると消える（仕様通り、永続化はしていない）。
