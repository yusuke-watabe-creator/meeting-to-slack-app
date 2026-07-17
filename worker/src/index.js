// Cloudflare Worker: 商談文字起こし → 次回アクション/準備するもの/案件フィードバック 抽出プロキシ
// ANTHROPIC_API_KEYはCloudflareのシークレットとして保存し、ブラウザには一切渡さない。

const ALLOWED_ORIGIN = 'https://yusuke-watabe-creator.github.io';
const MODEL = 'claude-haiku-4-5-20251001';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function extractJson(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  cleaned = cleaned.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: '不正なリクエストです' }, 400);
    }

    const transcript = (body && body.transcript || '').trim();
    if (!transcript) {
      return jsonResponse({ error: '文字起こしが空です' }, 400);
    }
    if (transcript.length > 20000) {
      return jsonResponse({ error: '文字起こしが長すぎます（2万文字以内にしてください）' }, 400);
    }

    const prompt = `以下は営業商談の文字起こし、またはAI議事録です。この内容だけから、次の3項目を日本語・簡潔な箇条書きで抽出してください。
出力は必ず次のJSON形式のみとし、前後に説明文やコードブロック記号は付けないでください。
{"next_action": "次回アクション(具体的な行動・期限があれば含める)", "prep_items": "準備するもの(資料・見積り・社内確認事項など)", "deal_feedback": "案件フィードバック(相手の反応・温度感・懸念点・受注可能性)"}
内容から明確に読み取れない項目は "文字起こしからは判断できません" としてください。

文字起こし:
${transcript}`;

    let anthropicRes;
    try {
      anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 600,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
    } catch (e) {
      return jsonResponse({ error: 'AI呼び出しに失敗しました: ' + e.message }, 502);
    }

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '');
      return jsonResponse({ error: 'AI APIエラー(' + anthropicRes.status + '): ' + errText }, 502);
    }

    const data = await anthropicRes.json();
    const rawText = (data.content && data.content[0] && data.content[0].text) || '';
    const parsed = extractJson(rawText);
    if (!parsed) {
      return jsonResponse({ error: '抽出結果の解析に失敗しました' }, 502);
    }

    return jsonResponse({
      next_action: parsed.next_action || '',
      prep_items: parsed.prep_items || '',
      deal_feedback: parsed.deal_feedback || '',
    });
  },
};
