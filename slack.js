// Slack Incoming Webhook への投稿処理。
// 注意: Incoming Webhook のレスポンスには CORS ヘッダーが付かないため、
// mode:'no-cors' で送信する（レスポンス本文は読めないopaque応答になる = 成否は確認できない）。
// Content-Type を 'text/plain' にして「シンプルリクエスト」扱いにすることで、
// Slack 側が応答しない preflight(OPTIONS) を回避している。
function buildSlackMessage({ assigneeId, dealName, dealDate, nextAction, prepItems, dealFeedback }) {
  const lines = [];
  if (assigneeId) lines.push('<@' + assigneeId + '>');

  let header = '*📋 商談メモ*';
  const meta = [];
  if (dealName) meta.push(dealName);
  if (dealDate) meta.push(dealDate);
  if (meta.length) header += ' - ' + meta.join(' / ');

  lines.push(
    header, '',
    '*次回アクション*', nextAction || '特になし', '',
    '*準備するもの*', prepItems || '特になし', '',
    '*案件フィードバック*', dealFeedback || '特になし'
  );
  return lines.join('\n');
}

async function postToSlack(message) {
  const webhookUrl = window.APP_CONFIG.SLACK_WEBHOOK_URL;
  if (!webhookUrl || webhookUrl.includes('REPLACE')) {
    throw new Error('SLACK_WEBHOOK_URL が未設定です（config.js を確認してください）');
  }
  await fetch(webhookUrl, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ text: message })
  });
  // no-cors のため成否は判定不可。ネットワークエラー（fetch自体の失敗）のみ検知できる。
}
