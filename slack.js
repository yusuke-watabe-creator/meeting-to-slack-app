// Slack Incoming Webhook への投稿処理。
// 注意: Incoming Webhook のレスポンスには CORS ヘッダーが付かないため、
// mode:'no-cors' で送信する（レスポンス本文は読めないopaque応答になる = 成否は確認できない）。
// Content-Type を 'text/plain' にして「シンプルリクエスト」扱いにすることで、
// Slack 側が応答しない preflight(OPTIONS) を回避している。
function buildDealMemoBody({ dealName, dealDate, nextAction, prepItems, dealFeedback }) {
  let header = '*📋 商談メモ*';
  const meta = [];
  if (dealName) meta.push(dealName);
  if (dealDate) meta.push(dealDate);
  if (meta.length) header += ' - ' + meta.join(' / ');

  return [
    header, '',
    '*次回アクション*', nextAction || '特になし', '',
    '*準備するもの*', prepItems || '特になし', '',
    '*案件フィードバック*', dealFeedback || '特になし'
  ].join('\n');
}

// Slack Incoming Webhook投稿用。<@USERID>形式はSlack側で実際のメンションに展開される。
function buildSlackMessage(fields) {
  const lines = [];
  if (fields.assigneeId) lines.push('<@' + fields.assigneeId + '>');
  lines.push(buildDealMemoBody(fields));
  return lines.join('\n');
}

// クリップボードコピー用。手動貼り付けでは<@USERID>形式が実際のメンションに変換されないため、
// 「@名前」という読める形式のテキストにする。
function buildCopyMessage(fields) {
  const lines = [];
  if (fields.assigneeId) {
    const assignee = window.APP_CONSTANTS.ASSIGNEES.find(a => a.id === fields.assigneeId);
    if (assignee && assignee.mention) lines.push(assignee.mention);
  }
  lines.push(buildDealMemoBody(fields));
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
