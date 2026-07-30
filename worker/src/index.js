// Cloudflare Worker: 商談文字起こし → 各種AI補助（商談メモ抽出／フォローアップメール本文生成）プロキシ
// GEMINI_API_KEYはCloudflareのシークレットとして保存し、ブラウザには一切渡さない。
// Google AI Studio (https://aistudio.google.com/apikey) はクレジットカード登録不要の無料枠があるため採用。

const ALLOWED_ORIGIN = 'https://yusuke-watabe-creator.github.io';
const MODEL = 'gemini-flash-latest';
const FALLBACK_MODEL = 'gemini-flash-lite-latest';

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

// テキスト全体を1回だけ走査し、各文字位置での「文字列リテラルの内側かどうか」と
// 「その時点で開いている{}/[]をどう閉じれば良いか」を前計算しておく。
// (truncateJsonRepair側で末尾から候補位置を探す際にO(1)で参照するため)
function analyzeJsonStructure(text) {
  const inStringBefore = new Array(text.length + 1);
  const stackBefore = new Array(text.length + 1);
  let inString = false;
  let escaped = false;
  let stack = [];
  for (let i = 0; i <= text.length; i++) {
    inStringBefore[i] = inString;
    stackBefore[i] = stack.slice();
    if (i === text.length) break;
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    else if (ch === '}' || ch === ']') { if (stack.length) stack.pop(); }
  }
  return { inStringBefore, stackBefore };
}

// max_tokens打ち切り等でJSONが途中で切れているケースの自己修復。
// 末尾から少しずつ削り、文字列リテラルの途中でないカット位置を見つけたら、
// 開いたままの{}/[]を正しい順序で閉じて再度JSON.parseを試す。
function repairTruncatedJson(cleaned) {
  const { inStringBefore, stackBefore } = analyzeJsonStructure(cleaned);
  const maxTrim = Math.min(cleaned.length, 600);
  for (let cut = cleaned.length; cut > 0 && cleaned.length - cut < maxTrim; cut--) {
    if (inStringBefore[cut]) continue;
    const candidate = cleaned.slice(0, cut).replace(/[\s,:]+$/, '');
    if (!candidate) continue;
    const stack = stackBefore[cut];
    if (!stack || !stack.length) continue;
    const closing = stack.slice().reverse().join('');
    try {
      return JSON.parse(candidate + closing);
    } catch (e) {
      continue;
    }
  }
  return null;
}

// extractJsonに加えて、途中で切れたJSONの自己修復も試みる版。
function extractJsonRobust(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  cleaned = cleaned.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  cleaned = cleaned.slice(start);

  const end = cleaned.lastIndexOf('}');
  if (end !== -1) {
    try {
      return JSON.parse(cleaned.slice(0, end + 1));
    } catch (e) {
      // fall through to repair
    }
  }
  return repairTruncatedJson(cleaned);
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
// options.useSearch=true にすると、Gemini組み込みのGoogle検索グラウンディングを有効にする
// (Anthropicのweb_searchツールに相当。追加のAPIキーや課金設定は不要、Gemini無料枠の範囲)。
async function callGeminiWithRetry(env, prompt, options) {
  const useSearch = !!(options && options.useSearch);
  const callGemini = (model) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        ...(useSearch ? { tools: [{ google_search: {} }] } : {}),
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

async function handleExtract(env, transcript) {
  const prompt = `以下は営業商談の文字起こし、またはAI議事録です。この内容だけから、次の3項目を日本語・簡潔な箇条書きで抽出してください。
出力は必ず次のJSON形式のみとし、前後に説明文やコードブロック記号は付けないでください。
{"next_action": "次回アクション(具体的な行動・期限があれば含める)", "prep_items": "準備するもの(資料・見積り・社内確認事項など)", "deal_feedback": "案件フィードバック(相手の反応・温度感・懸念点・受注可能性)"}
内容から明確に読み取れない項目は "文字起こしからは判断できません" としてください。

文字起こし:
${transcript}`;

  const geminiRes = await callGeminiWithRetry(env, prompt);
  if (!geminiRes.ok) return geminiErrorResponse(geminiRes);

  const data = await geminiRes.json();
  const parsed = extractJson(extractGeminiText(data));
  if (!parsed) return jsonResponse({ error: '抽出結果の解析に失敗しました' }, 502);

  return jsonResponse({
    next_action: parsed.next_action || '',
    prep_items: parsed.prep_items || '',
    deal_feedback: parsed.deal_feedback || '',
  });
}

async function handleMailBody(env, transcript, nextAction) {
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
  if (!geminiRes.ok) return geminiErrorResponse(geminiRes);

  const data = await geminiRes.json();
  const bodyText = stripCodeFence(extractGeminiText(data));
  if (!bodyText) return jsonResponse({ error: 'メール本文の生成に失敗しました' }, 502);

  return jsonResponse({ body: bodyText });
}

async function handleSplitPrepItems(env, prepItems) {
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
  if (!geminiRes.ok) return geminiErrorResponse(geminiRes);

  const data = await geminiRes.json();
  const parsed = extractJson(extractGeminiText(data));
  const items = (parsed && Array.isArray(parsed.items) ? parsed.items : [])
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (!items.length) return jsonResponse({ error: 'タスクへの分解に失敗しました' }, 502);

  return jsonResponse({ items });
}

function todayJa() {
  return new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
}

// 商談前企業分析: Web検索は使わず、Gemini自身の知識のみから構造化JSONで回答させる。
// (Gemini APIのGoogle検索グラウンディングは無料枠では利用できず429エラーになるため、
//  課金設定なしで動かせるこの方式に変更。最新情報の精度はWeb検索版より劣る点に注意。)
async function handleCompanyAnalysis(env, input) {
  const prompt = `あなたはBtoB営業(MEO対策サービス)のための企業リサーチアシスタントです。
Web検索は使えません。あなたが学習済みの知識の範囲だけで、与えられた企業(URLまたは社名)について分かることを、以下のJSON形式のみで出力してください。
説明文・前置き・Markdownのコードフェンスは一切不要です。JSONオブジェクトのみを、改行やインデントを入れず1行の圧縮形式で返してください。

制約(必ず守ってください。出力が長すぎると打ち切られるため厳守):
- Web検索ができないため、確信が持てない情報は無理に埋めず "不明" と記入すること。特に店舗数の正確な数字・直近の競合動向・住所の細部は、学習データが古い可能性が高いため、確信がなければ"不明"にする
- store_count.confidenceは、よほど有名で学習データにも繰り返し登場する企業でない限り"low"にする(最新の正確な数値は保証できないため)
- competitorsは最大3件まで
- storesは主要拠点を3件まで(例:都心の旗艦店・郊外店・地方主要都市店など、エリアが分散するように選ぶ)。学習データから店舗の詳細が分からない場合は、name/areaのみ埋めてaddressは"不明"にしてよい
- industry_newsは常に空配列[]を返すこと(Web検索なしでは「直近6ヶ月以内」を正確に判定できず、古い情報を最新ニュースとして誤って出す危険があるため)
- sourcesは常に空配列[]を返すこと(Web検索していないため参照元URLは存在しない)
- business, overall_assessment, opportunityはそれぞれ全角40文字以内
- citation_consistency, structured_data_signalは常に"不明"にする(Web上の実際の表示を確認できないため)
- reasonは全角25文字以内
- 店舗数・競合・店舗情報は日本国内を優先

出力JSONスキーマ(キー名はこの通りに):
{"company_name":"正式な会社名","overview":{"industry":"業種","founded":"設立年","hq":"本社所在地","business":"事業内容要約"},"store_count":{"estimate":"店舗数推定値","areas":"主な展開エリア","confidence":"high/medium/lowのいずれか"},"competitors":[{"name":"競合企業名","reason":"競合と判断した理由"}],"meo_status":{"overall_assessment":"総合評価","opportunity":"営業提案の切り口","stores":[{"name":"店舗名","area":"エリア","address":"住所(わかれば。不明なら不明)","citation_consistency":"不明","structured_data_signal":"不明"}]},"industry_news":[],"sources":[]}

対象企業: ${input}
本日の日付: ${todayJa()}
あなたの知識の範囲で、指定のJSON形式で出力してください。分からない項目は正直に"不明"としてください。`;

  const geminiRes = await callGeminiWithRetry(env, prompt);
  if (!geminiRes.ok) return geminiErrorResponse(geminiRes);

  const data = await geminiRes.json();
  const rawText = extractGeminiText(data);
  const parsed = extractJsonRobust(rawText);
  if (!parsed) {
    const truncated = data.candidates && data.candidates[0] && data.candidates[0].finishReason === 'MAX_TOKENS';
    return jsonResponse({
      error: truncated
        ? '出力が途中で切れており、自動修復もできませんでした。再試行または対象を絞って試してください'
        : '企業分析結果の解析に失敗しました。再試行してください'
    }, 502);
  }

  return jsonResponse({
    company_name: parsed.company_name || '不明',
    overview: parsed.overview || {},
    store_count: parsed.store_count || {},
    competitors: Array.isArray(parsed.competitors) ? parsed.competitors.slice(0, 3) : [],
    meo_status: parsed.meo_status || { stores: [] },
    industry_news: Array.isArray(parsed.industry_news) ? parsed.industry_news.slice(0, 3) : [],
    sources: Array.isArray(parsed.sources) ? parsed.sources.slice(0, 3) : [],
  });
}

// 商談トーク案生成: 企業分析結果+営業担当の手動チェック結果をもとに、Web検索なしでトーク文を生成。
async function handleSalesTalk(env, analysis, storeChecks) {
  const storeLines = (analysis.meo_status && Array.isArray(analysis.meo_status.stores) ? analysis.meo_status.stores : [])
    .map((store) => {
      const check = (storeChecks || []).find((c) => c.name === store.name) || {};
      const reply = check.review_reply ? 'あり' : 'なし';
      const photo = check.photo_owner ? 'あり' : 'なし';
      const posts = check.recent_posts
        ? 'あり' + (check.last_post_date ? `(最終投稿: ${check.last_post_date})` : '')
        : 'なし';
      return `・${store.name || '店舗'}(${store.area || '不明'})：サイテーション[${store.citation_consistency || '不明'}] / 構造化データ[${store.structured_data_signal || '不明'}] / 口コミ返信[${reply}] / 写真[${photo}] / 最新情報[${posts}]`;
    })
    .join('\n');

  const competitorNames = (Array.isArray(analysis.competitors) ? analysis.competitors : [])
    .map((c) => c.name).filter(Boolean).join('、');

  const prompt = `あなたはMEO対策サービスのトップ営業パーソンです。以下の企業・店舗データをもとに、初回商談の冒頭で使える「つかみトーク」を作成してください。

企業名: ${analysis.company_name || '不明'}
店舗数: ${(analysis.store_count && analysis.store_count.estimate) || '不明'}（${(analysis.store_count && analysis.store_count.areas) || '不明'}）
競合: ${competitorNames || '不明'}
店舗別チェック結果:
${storeLines || '(店舗情報なし)'}

条件:
- 日本語、丁寧だが売り込み臭くない自然な話し言葉
- 具体的な数字・事実(店舗名や最終投稿日など)を最低1つ盛り込み、説得力を持たせる
- 「詰める」トーンではなく、相手の課題への気づきを促す聞き方を1つ含める
- 250〜350文字程度
- 前置きや見出しは不要。トーク本文のみを出力`;

  const geminiRes = await callGeminiWithRetry(env, prompt);
  if (!geminiRes.ok) return geminiErrorResponse(geminiRes);

  const data = await geminiRes.json();
  const talk = stripCodeFence(extractGeminiText(data));
  if (!talk) return jsonResponse({ error: '商談トーク案の生成に失敗しました' }, 502);

  return jsonResponse({ talk });
}

function geminiErrorResponse(geminiRes) {
  const isCongested = geminiRes.status === 503 || geminiRes.status === 429;
  const hint = isCongested ? '（Geminiが混雑しています。少し時間をおいてもう一度お試しください）' : '';
  return geminiRes
    .text()
    .catch(() => '')
    .then((errText) =>
      jsonResponse({ error: 'AI APIエラー(' + geminiRes.status + ')' + hint + ': ' + errText }, 502)
    );
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

    const type = body.type || 'extract';

    try {
      if (type === 'split_prep_items') {
        const prepItems = (body && body.prepItems || '').trim();
        if (!prepItems) return jsonResponse({ error: '準備するものが空です' }, 400);
        if (prepItems.length > 5000) return jsonResponse({ error: '準備するものが長すぎます' }, 400);
        return await handleSplitPrepItems(env, prepItems);
      }

      if (type === 'company_analysis') {
        const input = (body && body.input || '').trim();
        if (!input) return jsonResponse({ error: '企業名またはURLが空です' }, 400);
        if (input.length > 300) return jsonResponse({ error: '入力が長すぎます' }, 400);
        return await handleCompanyAnalysis(env, input);
      }

      if (type === 'sales_talk') {
        const analysis = body && body.analysis;
        if (!analysis || typeof analysis !== 'object') return jsonResponse({ error: '企業分析結果が指定されていません' }, 400);
        return await handleSalesTalk(env, analysis, Array.isArray(body.storeChecks) ? body.storeChecks : []);
      }

      const transcript = (body && body.transcript || '').trim();
      if (!transcript) {
        return jsonResponse({ error: '文字起こしが空です' }, 400);
      }
      if (transcript.length > 100000) {
        return jsonResponse({ error: '文字起こしが長すぎます（10万文字以内にしてください）' }, 400);
      }

      if (type === 'mail_body') {
        return await handleMailBody(env, transcript, (body.nextAction || '').trim());
      }
      return await handleExtract(env, transcript);
    } catch (e) {
      return jsonResponse({ error: 'AI呼び出しに失敗しました: ' + e.message }, 502);
    }
  },
};
