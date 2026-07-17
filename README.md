# 商談メモ → Slack / Gmail 連携ツール（ブラウザ単体版）

Cowork非依存。静的ファイル一式をhttp(s)で配信するだけで動く。文字起こしのAI抽出だけ、APIキーを安全に保つための小さな中継サーバー（Cloudflare Worker）を使う。

## ファイル構成
- `index.html` — UI本体
- `config.js` — 環境設定値（Slack Webhook URL / Google OAuth クライアントID / 抽出Worker URL）※要編集
- `constants.js` — 固定値（社内ドメイン、CCアドレス、担当者メンション一覧）
- `slack.js` — Slack Incoming Webhookへの投稿処理
- `gmail.js` — Google Identity Services認証、Gmail検索・スレッド取得・下書き作成（Gmail REST API直接呼び出し）
- `app.js` — UIイベントのワイヤリング
- `worker/` — 文字起こし→AI抽出プロキシ（Cloudflare Worker）。ANTHROPIC_API_KEYはここにだけ保管し、ブラウザには渡さない。

## セットアップ手順

### 1. Slack Incoming Webhookの発行
Slack管理画面で `#渡部チーム--26年` チャンネル宛のIncoming Webhookを発行し、URLを `config.js` の `SLACK_WEBHOOK_URL` に設定する。

> 注意: Incoming Webhook経由の投稿は「Incoming Webhook」というアプリ名で投稿され、投稿者本人のアカウント名にはならない。事前にチームへ共有しておくこと。
> また、ブラウザからのfetchはCORSの都合上レスポンスを読み取れない（`mode:'no-cors'`で送信）ため、アプリ上では送信成否を確認できない。到達確認はSlack側で行うこと。

### 2. Google Cloud OAuth設定（Gmail連携用）
1. Google Cloud Consoleでプロジェクトを作成
2. OAuth同意画面: **User Type: Internal**（`gmotech.jp`組織限定）に設定 → Google審査不要
3. OAuth 2.0 クライアントID（種類: **ウェブアプリケーション**）を作成
   - 「承認済みのJavaScript生成元」に、実際にホスティングするURL（例: `https://xxx.example.com`）を登録
4. 発行されたクライアントIDを `config.js` の `GOOGLE_CLIENT_ID` に設定
5. 必要スコープ（コード側で要求済み、Console側の追加設定は不要）:
   - `gmail.readonly`（スレッド検索・ヘッダー取得）
   - `gmail.compose`（下書き作成）

### 3. 文字起こしAI抽出用Workerのデプロイ（Cloudflare）
1. [Anthropic Console](https://console.anthropic.com/)でAPIキーを発行する（未取得の場合はアカウント登録が必要）
2. [Cloudflareアカウント](https://dash.cloudflare.com/sign-up)を用意する（無料プランでOK）
3. ローカルに `wrangler` CLIを用意し、`worker/` フォルダで認証する
   ```
   npm install -g wrangler
   cd worker
   wrangler login
   ```
   （ブラウザが開くのでCloudflareアカウントで承認する）
4. APIキーをシークレットとして登録する（このコマンドは自分の端末で実行し、キー自体はプロンプトに直接貼り付ける。ファイルやコードには一切書かない）
   ```
   wrangler secret put ANTHROPIC_API_KEY
   ```
5. デプロイする
   ```
   wrangler deploy
   ```
   完了すると `https://meeting-to-slack-extract.<あなたのアカウント>.workers.dev` のようなURLが発行される。
6. そのURLを `config.js` の `EXTRACT_API_URL` に設定する
7. `worker/src/index.js` 内の `ALLOWED_ORIGIN` が実際のホスティング先URLと一致しているか確認する（異なる場合はCORSエラーになる）

### 4. ホスティング
社内向けの静的ホスティング環境（GitHub Pages等）にファイル一式をアップロードする。

> **重要:** `file://` で開くとGoogle OAuthのオリジン制約に引っかかるため使用不可。必ずhttp(s)で配信されるURLでアクセスすること。

## 動作確認
- ローカルで確認する場合は `npx serve .` などの簡易静的サーバー経由で開く（`file://`不可）。
- Slack送信・Gmail連携・AI抽出は、それぞれ実際の `SLACK_WEBHOOK_URL` / `GOOGLE_CLIENT_ID` / `EXTRACT_API_URL` を設定するまでダミー値のままでOK（未設定時は明示的なエラーメッセージが表示される）。

## 既知の制約
- Slack投稿の成否はアプリ上では確認できない（Incoming WebhookのCORS仕様のため）。
- Gmail下書き作成はブラウザ発行のアクセストークン（Google Identity Services Token Client）に依存するため、トークンの有効期限が切れた場合は初回操作時と同様に再度Googleログインが求められる。
- AI抽出（Worker経由）は、Anthropic APIの利用量に応じて（わずかだが）課金が発生する。Cloudflare Worker自体は無料枠内で運用可能。
