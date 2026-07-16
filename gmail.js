// Gmail API (REST) 連携。Google Identity Services のTokenClientでアクセストークンを取得し、
// バックエンドを介さず直接 gmail.googleapis.com を叩く。

let gisTokenClient = null;
let gmailAccessToken = null;

function initGmailAuth() {
  gisTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: window.APP_CONFIG.GOOGLE_CLIENT_ID,
    scope: window.APP_CONSTANTS.GMAIL_SCOPES,
    callback: () => {} // requestAccessTokenのたびに差し替える
  });
}

// ユーザー操作(クリック)起点のハンドラ内から呼ぶこと(GISの制約)。
function ensureGmailToken() {
  return new Promise((resolve, reject) => {
    if (gmailAccessToken) {
      resolve(gmailAccessToken);
      return;
    }
    gisTokenClient.callback = (resp) => {
      if (resp.error) {
        reject(new Error('Google認証エラー: ' + resp.error));
        return;
      }
      gmailAccessToken = resp.access_token;
      resolve(gmailAccessToken);
    };
    gisTokenClient.requestAccessToken({ prompt: '' });
  });
}

async function gmailFetch(url, options) {
  const token = await ensureGmailToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options && options.headers),
      Authorization: 'Bearer ' + token
    }
  });
  if (res.status === 401) {
    // トークン失効 → 破棄して1回だけ再試行
    gmailAccessToken = null;
    const token2 = await ensureGmailToken();
    return fetch(url, {
      ...options,
      headers: {
        ...(options && options.headers),
        Authorization: 'Bearer ' + token2
      }
    });
  }
  return res;
}

function getHeader(headers, name) {
  const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

function isInternalEmail(email) {
  return (email || '').toLowerCase().trim().endsWith('@' + window.APP_CONSTANTS.INTERNAL_DOMAIN);
}

function extractEmails(headerValue) {
  if (!headerValue) return [];
  // "Name <addr@example.com>, addr2@example.com" 形式からアドレスのみ抽出
  const matches = headerValue.match(/[^\s<>",]+@[^\s<>",]+/g);
  return matches ? matches.map(s => s.toLowerCase()) : [];
}

function getClientEmails(headers) {
  const from = extractEmails(getHeader(headers, 'From'));
  const to = extractEmails(getHeader(headers, 'To'));
  const cc = extractEmails(getHeader(headers, 'Cc'));
  const all = [...from, ...to, ...cc];
  const external = all.filter(e => e && !isInternalEmail(e));
  return Array.from(new Set(external));
}

const METADATA_HEADERS_QS = ['Subject', 'From', 'To', 'Cc', 'Date', 'Message-ID']
  .map(h => 'metadataHeaders=' + encodeURIComponent(h)).join('&');

// スレッド全体を取得し、内部日付でソートした「本当の最新メッセージ」を返す。
// 検索結果(snippet)だけを見て返信対象を決めない(過去バグの再発防止 / 仕様書4.3参照)。
async function fetchThreadWithTrueLatest(threadId) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=metadata&${METADATA_HEADERS_QS}`;
  const res = await gmailFetch(url, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('スレッド取得エラー(' + res.status + '): ' + body);
  }
  const thread = await res.json();
  const messages = (thread.messages || []).slice().sort(
    (a, b) => Number(a.internalDate) - Number(b.internalDate)
  );
  const latest = messages[messages.length - 1];
  const allMessageIds = messages
    .map(m => getHeader(m.payload.headers, 'Message-ID'))
    .filter(Boolean);
  return { thread, messages, latest, allMessageIds };
}

async function searchGmailThreads(query, maxResults = 8) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads?q=${encodeURIComponent(query)}&maxResults=${maxResults}`;
  const res = await gmailFetch(url, { method: 'GET' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('検索エラー(' + res.status + '): ' + body);
  }
  const data = await res.json();
  const threadStubs = data.threads || [];

  // 一覧表示用に、各スレッドの本当の最新メッセージを取得する。
  const results = [];
  for (const stub of threadStubs) {
    try {
      const { thread, latest, allMessageIds } = await fetchThreadWithTrueLatest(stub.id);
      if (!latest) continue;
      const headers = latest.payload.headers;
      results.push({
        threadId: thread.id,
        subject: getHeader(headers, 'Subject') || '(件名なし)',
        date: getHeader(headers, 'Date'),
        clientEmails: getClientEmails(headers),
        snippet: latest.snippet || '',
        messageId: getHeader(headers, 'Message-ID'),
        allMessageIds
      });
    } catch (e) {
      // 1スレッドの取得失敗で全体を止めない
      console.error('thread fetch failed', stub.id, e);
    }
  }
  return results;
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function toBase64Url(base64) {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeMimeHeaderWord(str) {
  // Subjectなど非ASCIIを含みうるヘッダー値をRFC2047(Base64)でエンコード
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  return '=?UTF-8?B?' + utf8ToBase64(str) + '?=';
}

function wrapBase64(base64) {
  return base64.replace(/(.{76})/g, '$1\r\n');
}

// In-Reply-To/References を含むRFC2822メッセージを組み立て、Gmail drafts.create向けのraw(base64url)を返す。
function buildDraftRaw({ to, cc, subject, body, inReplyToMessageId, referencesMessageIds }) {
  const headerLines = [];
  headerLines.push('To: ' + to.join(', '));
  if (cc && cc.length) headerLines.push('Cc: ' + cc.join(', '));
  headerLines.push('Subject: ' + encodeMimeHeaderWord(subject));
  if (inReplyToMessageId) headerLines.push('In-Reply-To: ' + inReplyToMessageId);
  if (referencesMessageIds && referencesMessageIds.length) {
    headerLines.push('References: ' + referencesMessageIds.join(' '));
  }
  headerLines.push('MIME-Version: 1.0');
  headerLines.push('Content-Type: text/plain; charset="UTF-8"');
  headerLines.push('Content-Transfer-Encoding: base64');

  const bodyBase64 = wrapBase64(utf8ToBase64(body));
  const mime = headerLines.join('\r\n') + '\r\n\r\n' + bodyBase64 + '\r\n';
  return toBase64Url(utf8ToBase64(mime));
}

async function createGmailDraft({ to, cc, subject, body, threadId, inReplyToMessageId, referencesMessageIds }) {
  const raw = buildDraftRaw({ to, cc, subject, body, inReplyToMessageId, referencesMessageIds });
  const payload = { message: { raw } };
  if (threadId) payload.message.threadId = threadId;

  const res = await gmailFetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error('下書き作成エラー(' + res.status + '): ' + errBody);
  }
  return res.json();
}
