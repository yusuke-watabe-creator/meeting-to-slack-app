// 環境設定値。前提条件が揃うまではダミー値のままでOK（仕様書 6章参照）。
window.APP_CONFIG = {
  // Slack Incoming Webhook URL（#渡部チーム--26年 宛に発行してもらう）
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/REPLACE/WITH/REAL_WEBHOOK',

  // Google Cloud Console で発行する OAuth 2.0 クライアントID（ウェブアプリケーション種別）
  GOOGLE_CLIENT_ID: '455454519979-5ujauv4rais7m2r3p22vr4bh4fmint1i.apps.googleusercontent.com',

  // 文字起こし抽出プロキシ（Cloudflare Worker）のURL。APIキーはWorker側のシークレットに保管し、ここには含めない。
  EXTRACT_API_URL: 'https://meeting-to-slack-extract.yusuke-watabe-gmotech.workers.dev'
};
