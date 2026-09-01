// Cloudflare Worker: 商談文字起こし → 各種AI補助（商談メモ抽出／フォローアップメール本文生成／
// 準備するものの分解）プロキシ。加えて /miitel-webhook で、Miitelの文字起こし完了Webhookを受けて
// 抽出→Slack投稿→タスクボード登録→メール文案生成までを完全自動で行う。
//
// GEMINI_API_KEYはCloudflareのシークレットとして保存し、ブラウザには一切渡さない。
// Google AI Studio (https://aistudio.google.com/apikey) はクレジットカード登録不要の無料枠があるため採用。

const ALLOWED_ORIGIN = 'https://yusuke-watabe-creator.github.io';
const MODEL = 'gemini-flash-latest';
const FALLBACK_MODEL = 'gemini-flash-lite-latest';

// tasks.html / firebase-tasks.js と同じ共有Firebase Realtime Database（既存の公開クライアント設定と同じもの）。
const FIREBASE_DB_URL = 'https://taiki-tasks-933cc-default-rtdb.asia-southeast1.firebasedatabase.app';

// Miitel Webhook経由の自動化では、担当ISが未確定なため一旦すべて渡部に集約する運用。
const AUTOMATION_ASSIGNEE_NAME = '渡部';
const AUTOMATION_ASSIGNEE_MENTION = '@渡部';

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

function stripCodeFence(text) {
  return String(text || '')
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/```$/, '')
    .trim();
}

// 混雑時(503/429)は一時的なことが多いため、間隔を空けながら複数回試す。
// 同じモデルで数回試してもダメなら、より軽量なモデル(flash-lite)にも切り替えてみる。
async function callGeminiWithRetry(env, prompt) {
  const callGemini = (model) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });

  const isCongested = (res) => res.status === 503 || res.status === 429;

  const attempts = [
    { model: MODEL, delayMs: 0 },
    { model: MODEL, delayMs: 1500 },
    { model: MODEL, delayMs: 3000 },
    { model: FALLBACK_MODEL, delayMs: 1000 },
    { model: FALLBACK_MODEL, delayMs: 3000 },
  ];

  let res;
  for (const attempt of attempts) {
    if (attempt.delayMs) await new Promise((r) => setTimeout(r, attempt.delayMs));
    res = await callGemini(attempt.model);
    if (!isCongested(res)) break;
  }
  return res;
}

function extractGeminiText(data) {
  return (
    (data.candidates &&
      data.candidates[0] &&
      data.candidates[0].content &&
      data.candidates[0].content.parts &&
      data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text) ||
    ''
  );
}

async function geminiErrorMessage(geminiRes) {
  const isCongested = geminiRes.status === 503 || geminiRes.status === 429;
  const hint = isCongested ? '（Geminiが混雑しています）' : '';
  const errText = await geminiRes.text().catch(() => '');
  return 'AI APIエラー(' + geminiRes.status + ')' + hint + ': ' + errText;
}

// ---- データ生成の中核ロジック（フロント向けAPIとMiitel自動化の両方から使う） ----

async function extractMemoData(env, transcript) {
  const prompt = `以下は営業商談の文字起こし、またはAI議事録です。この内容だけから、次の3項目を日本語・簡潔な箇条書きで抽出してください。
出力は必ず次のJSON形式のみとし、前後に説明文やコードブロック記号は付けないでください。
{"next_action": "次回アクション(具体的な行動・期限があれば含める)", "prep_items": "準備するもの(資料・見積り・社内確認事項など)", "deal_feedback": "案件フィードバック(相手の反応・温度感・懸念点・受注可能性)"}
内容から明確に読み取れない項目は "文字起こしからは判断できません" としてください。

文字起こし:
${transcript}`;

  const geminiRes = await callGeminiWithRetry(env, prompt);
  if (!geminiRes.ok) throw new Error(await geminiErrorMessage(geminiRes));

  const data = await geminiRes.json();
  const parsed = extractJson(extractGeminiText(data));
  if (!parsed) throw new Error('抽出結果の解析に失敗しました');

  return {
    next_action: parsed.next_action || '',
    prep_items: parsed.prep_items || '',
    deal_feedback: parsed.deal_feedback || '',
  };
}

async function generateMailBodyData(env, transcript, nextAction) {
  const prompt = `あなたは営業担当者のアシスタントです。以下の商談の文字起こしと、次回アクションのメモをもとに、先方（お客様）に送るフォローアップメールの本文を日本語のビジネスメール形式で作成してください。

このメールの目的:
- 受注につなげること。
- それ以上に重要なのは、先方が「今回の打ち合わせで何が話されたか」「次に何をすべきか」を正確に理解できることです。社内向けの議事録ではなく、先方が読んで迷わない・誤解しないメールを書いてください。

必ず次のフォーマット・構成に沿って書いてください（見出しや区切り線も含めて再現してください）。

------ フォーマット ------
（お礼の一文。例:「本日はお忙しいところお時間いただきありがとうございました。」）
（商談内容に触れる一文。例:「貴社の状況や展望をご共有いただき、重ねて御礼申し上げます。」）

本日の打ち合わせ内容を以下の通り整理いたしました。
----------------------------------------------
■会議のポイント
1. （論点の見出し）
・（具体的な内容の箇条書き。文字起こしから読み取れる範囲で）
・（具体的な内容の箇条書き）
2. （論点の見出し。論点が複数ある場合は同様に番号を振って続ける）
・（具体的な内容の箇条書き）

■決定事項とネクストアクション
・（決定事項や次回アクションの箇条書き。次回アクション「${nextAction || '未定'}」を必ず反映する）
・（「弊社が何をするか」「先方に何をお願いしたいか」が誰から見てもはっきり分かるように書く。期日や次回打ち合わせの目安が分かればそれも書く）
----------------------------------------------

（締めの一文。例:「貴社のスケジュールや優先順位に合わせて、いつでも柔軟にご提案・ご対応させていただきます。」）
（結びの一文。例:「今後とも何卒よろしくお願い申し上げます。」）
------ フォーマットここまで ------

条件:
- 宛名（「○○様」等）は書かないでください。上記フォーマットのお礼の一文から書き始めてください。
- 「■会議のポイント」の論点・箇条書きは、文字起こしの内容から実際に読み取れることだけを書いてください。読み取れない場合は無理に埋めず、論点を減らしてください。
- 本文の最後に署名・氏名・会社名は一切書かないでください（Gmail側の署名が自動で付くため）。
- 本文のみを出力してください。件名、説明文、前置き、コードブロック記号（\`\`\`）は一切出力しないでください。

文字起こし:
${transcript}`;

  const geminiRes = await callGeminiWithRetry(env, prompt);
  if (!geminiRes.ok) throw new Error(await geminiErrorMessage(geminiRes));

  const data = await geminiRes.json();
  const bodyText = stripCodeFence(extractGeminiText(data));
  if (!bodyText) throw new Error('メール本文の生成に失敗しました');
  return bodyText;
}

async function splitPrepItemsData(env, prepItems) {
  const prompt = `以下は営業商談の「準備するもの」のメモです。ここに書かれている内容を、独立して1人に依頼できる単位のタスクに分解してください。
出力は必ず次のJSON形式のみとし、前後に説明文やコードブロック記号は付けないでください。
{"items": ["タスク名1", "タスク名2", ...]}
条件:
- 各タスク名は10〜20文字程度の簡潔な体言止め、または依頼できる形の短い文で書いてください（例:「導入事例資料の作成」「見積書の提出」「SF申請」）。
- 元のメモに複数の作業が含まれている場合は、必ず分割してください。1つの作業しかない場合は1件のみでかまいません。
- 元のメモに書かれていないタスクを勝手に追加しないでください。

準備するもの:
${prepItems}`;

  const geminiRes = await callGeminiWithRetry(env, prompt);
  if (!geminiRes.ok) throw new Error(await geminiErrorMessage(geminiRes));

  const data = await geminiRes.json();
  const parsed = extractJson(extractGeminiText(data));
  const items = (parsed && Array.isArray(parsed.items) ? parsed.items : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (!items.length) throw new Error('タスクへの分解に失敗しました');
  return items;
}

// ---- フロントエンド(index.html)向けAPI（既存の契約を維持） ----

async function handleExtract(env, transcript) {
  try {
    return jsonResponse(await extractMemoData(env, transcript));
  } catch (e) {
    return jsonResponse({ error: e.message }, 502);
  }
}

async function handleMailBody(env, transcript, nextAction) {
  try {
    return jsonResponse({ body: await generateMailBodyData(env, transcript, nextAction) });
  } catch (e) {
    return jsonResponse({ error: e.message }, 502);
  }
}

async function handleSplitPrepItems(env, prepItems) {
  try {
    return jsonResponse({ items: await splitPrepItemsData(env, prepItems) });
  } catch (e) {
    return jsonResponse({ error: e.message }, 502);
  }
}

// ---- Miitel Outgoing Webhook（文字起こし完了時）: 完全自動化フロー ----

function buildAutomationSlackMessage({ dealName, dealDate, nextAction, prepItems, dealFeedback, mailBody }) {
  let header = '*📋 商談メモ（自動生成）*';
  const meta = [];
  if (dealName) meta.push(dealName);
  if (dealDate) meta.push(dealDate);
  if (meta.length) header += ' - ' + meta.join(' / ');

  const lines = [
    AUTOMATION_ASSIGNEE_MENTION,
    header, '',
    '*次回アクション*', nextAction || '特になし', '',
    '*準備するもの*', prepItems || '特になし', '',
    '*案件フィードバック*', dealFeedback || '特になし',
  ];
  if (mailBody) {
    lines.push('', '*📧 フォローアップメール文案（下書き作成は手動でお願いします）*', mailBody);
  }
  return lines.join('\n');
}

async function pushTaskBoardCardServer(env, { name, memo, assignee }) {
  const id = Date.now() + Math.floor(Math.random() * 1000);
  const task = {
    id,
    createdAt: id,
    name,
    memo: memo || '',
    cat: '',
    priority: '',
    due: '',
    dueTime: '',
    assignee,
  };
  const res = await fetch(`${FIREBASE_DB_URL}/team2/tasks/${id}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(task),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error('タスクボード書き込みエラー(' + res.status + '): ' + errText);
  }
  return task;
}

function todayJst() {
  // JSTで日付を出す（サーバーはUTC基準のため+9h補正）
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function handleMiitelWebhook(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!env.MIITEL_WEBHOOK_TOKEN || authHeader !== 'Bearer ' + env.MIITEL_WEBHOOK_TOKEN) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: '不正なリクエストです' }, 400);
  }

  const video = body && body.video;
  const transcript = ((video && video.speech_recognition && video.speech_recognition.raw) || '').trim();
  const dealName = (video && video.title) || '';

  if (!transcript) {
    return jsonResponse({ error: '文字起こし(video.speech_recognition.raw)が空です' }, 400);
  }
  if (transcript.length > 100000) {
    return jsonResponse({ error: '文字起こしが長すぎます' }, 400);
  }

  const result = { steps: {} };

  try {
    const memo = await extractMemoData(env, transcript);
    result.steps.extract = 'ok';

    const [splitResult, mailResult] = await Promise.allSettled([
      memo.prep_items && memo.prep_items !== '文字起こしからは判断できません'
        ? splitPrepItemsData(env, memo.prep_items)
        : Promise.resolve([]),
      generateMailBodyData(env, transcript, memo.next_action),
    ]);

    const items = splitResult.status === 'fulfilled' ? splitResult.value : [];
    result.steps.split_prep_items = splitResult.status === 'fulfilled' ? 'ok' : 'failed: ' + splitResult.reason.message;

    const mailBody = mailResult.status === 'fulfilled' ? mailResult.value : '';
    result.steps.mail_body = mailResult.status === 'fulfilled' ? 'ok' : 'failed: ' + mailResult.reason.message;

    // Slack投稿
    const dealDate = todayJst();
    const slackMessage = buildAutomationSlackMessage({
      dealName, dealDate,
      nextAction: memo.next_action, prepItems: memo.prep_items, dealFeedback: memo.deal_feedback,
      mailBody,
    });
    if (env.SLACK_WEBHOOK_URL) {
      const slackRes = await fetch(env.SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: slackMessage }),
      });
      result.steps.slack = slackRes.ok ? 'ok' : 'failed: status ' + slackRes.status;
    } else {
      result.steps.slack = 'skipped: SLACK_WEBHOOK_URL未設定';
    }

    // タスクボード登録（サマリー1件 + 準備するものの分解タスク）
    let taskCount = 0;
    try {
      await pushTaskBoardCardServer(env, {
        name: dealName || memo.next_action || '商談メモ',
        memo: dealName ? memo.next_action : '',
        assignee: AUTOMATION_ASSIGNEE_NAME,
      });
      taskCount++;
      for (const item of items) {
        await pushTaskBoardCardServer(env, {
          name: dealName ? dealName + ' ' + item : item,
          memo: '',
          assignee: AUTOMATION_ASSIGNEE_NAME,
        });
        taskCount++;
      }
      result.steps.task_board = 'ok (' + taskCount + '件)';
    } catch (e) {
      result.steps.task_board = 'failed: ' + e.message;
    }

    return jsonResponse({ ok: true, ...result });
  } catch (e) {
    return jsonResponse({ ok: false, error: e.message, ...result }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    if (url.pathname === '/miitel-webhook') {
      return handleMiitelWebhook(request, env);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: '不正なリクエストです' }, 400);
    }

    const type = body.type || 'extract';

    if (type === 'split_prep_items') {
      const prepItems = (body && body.prepItems || '').trim();
      if (!prepItems) return jsonResponse({ error: '準備するものが空です' }, 400);
      if (prepItems.length > 5000) return jsonResponse({ error: '準備するものが長すぎます' }, 400);
      return handleSplitPrepItems(env, prepItems);
    }

    const transcript = (body && body.transcript || '').trim();
    if (!transcript) {
      return jsonResponse({ error: '文字起こしが空です' }, 400);
    }
    if (transcript.length > 100000) {
      return jsonResponse({ error: '文字起こしが長すぎます（10万文字以内にしてください）' }, 400);
    }

    if (type === 'mail_body') {
      return handleMailBody(env, transcript, (body.nextAction || '').trim());
    }
    return handleExtract(env, transcript);
  },
};
