function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = 'status ' + (kind || 'pending');
}

function parseEmailList(str) {
  return (str || '')
    .split(/[,、\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (e) {
    // フォーカスが無い等でClipboard APIが使えない環境向けのフォールバック
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (!ok) throw e;
  }
}

function fmtDate(headerDate) {
  if (!headerDate) return '';
  const d = new Date(headerDate);
  if (isNaN(d)) return headerDate;
  return d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// selected thread state (Gmail再返信対象)
let selectedThread = null; // { threadId, subject, messageId, allMessageIds }

function populateAssigneeSelect() {
  const select = document.getElementById('assignee');
  window.APP_CONSTANTS.ASSIGNEES.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.label;
    select.appendChild(opt);
  });
}

function initDefaults() {
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('dealDate').value = today;
  document.getElementById('mailCc').value = window.APP_CONSTANTS.REQUIRED_CC;
}

// ---- 文字起こし → AI抽出（Cloudflare Worker経由） ----
function wireExtract() {
  const extractBtn = document.getElementById('extractBtn');
  const extractStatus = document.getElementById('extractStatus');

  extractBtn.addEventListener('click', async () => {
    const transcript = document.getElementById('transcript').value.trim();
    if (!transcript) {
      setStatus(extractStatus, '文字起こしを貼り付けてください', 'err');
      return;
    }
    const extractApiUrl = window.APP_CONFIG.EXTRACT_API_URL;
    if (!extractApiUrl || extractApiUrl.includes('REPLACE')) {
      setStatus(extractStatus, 'EXTRACT_API_URL が未設定です（config.js を確認してください）', 'err');
      return;
    }

    extractBtn.disabled = true;
    setStatus(extractStatus, '抽出中...', 'pending');
    try {
      const res = await fetch(extractApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript })
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || ('抽出エラー(' + res.status + ')'));
      }
      document.getElementById('nextAction').value = result.next_action || '';
      document.getElementById('prepItems').value = result.prep_items || '';
      document.getElementById('dealFeedback').value = result.deal_feedback || '';
      setStatus(extractStatus, '抽出しました。内容を確認してください', 'ok');
    } catch (e) {
      setStatus(extractStatus, 'エラー: ' + (e && e.message ? e.message : String(e)), 'err');
    } finally {
      extractBtn.disabled = false;
    }
  });
}

function readDealMemoFields() {
  return {
    dealDate: document.getElementById('dealDate').value,
    dealName: document.getElementById('dealName').value.trim(),
    assigneeId: document.getElementById('assignee').value,
    nextAction: document.getElementById('nextAction').value.trim(),
    prepItems: document.getElementById('prepItems').value.trim(),
    dealFeedback: document.getElementById('dealFeedback').value.trim()
  };
}

// ---- Slack送信 ----
function wireSlackSend() {
  const sendBtn = document.getElementById('sendBtn');
  const sendStatus = document.getElementById('sendStatus');

  sendBtn.addEventListener('click', async () => {
    const fields = readDealMemoFields();
    if (!fields.nextAction && !fields.prepItems && !fields.dealFeedback) {
      setStatus(sendStatus, '送信する内容がありません', 'err');
      return;
    }

    const message = buildSlackMessage(fields);

    sendBtn.disabled = true;
    setStatus(sendStatus, '送信中...', 'pending');
    try {
      await postToSlack(message);
      setStatus(sendStatus, '送信リクエストを送りました（Incoming Webhookの仕様上、到達確認はSlack側で行ってください）', 'ok');
    } catch (e) {
      setStatus(sendStatus, '送信エラー: ' + (e && e.message ? e.message : String(e)), 'err');
    } finally {
      sendBtn.disabled = false;
    }
  });
}

// ---- コピー（他のチャンネル・DMに手動で貼る用） ----
function wireCopyButton() {
  const copyBtn = document.getElementById('copyBtn');
  const sendStatus = document.getElementById('sendStatus');

  copyBtn.addEventListener('click', async () => {
    const fields = readDealMemoFields();
    if (!fields.nextAction && !fields.prepItems && !fields.dealFeedback) {
      setStatus(sendStatus, 'コピーする内容がありません', 'err');
      return;
    }

    const message = buildCopyMessage(fields);
    try {
      await copyToClipboard(message);
      setStatus(sendStatus, 'コピーしました。好きなチャンネル・DMに貼り付けてください', 'ok');
    } catch (e) {
      setStatus(sendStatus, 'コピーに失敗しました: ' + (e && e.message ? e.message : String(e)), 'err');
    }
  });
}

// ---- Gmailスレッド検索 ----
function wireMailSearch() {
  const searchBtn = document.getElementById('mailSearchBtn');
  const resultsEl = document.getElementById('mailSearchResults');
  const banner = document.getElementById('selectedBanner');

  searchBtn.addEventListener('click', async () => {
    const q = document.getElementById('mailSearchQuery').value.trim();
    if (!q) {
      resultsEl.innerHTML = '<div class="search-result-meta">検索キーワードを入力してください</div>';
      return;
    }
    resultsEl.innerHTML = '<div class="search-result-meta">検索中...</div>';
    searchBtn.disabled = true;
    try {
      const threads = await searchGmailThreads(q);
      if (threads.length === 0) {
        resultsEl.innerHTML = '<div class="search-result-meta">該当するメールが見つかりませんでした</div>';
        return;
      }
      resultsEl.innerHTML = '';
      threads.forEach(t => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        const counterparty = t.clientEmails.length ? t.clientEmails.join(', ') : '(社内のみ)';
        item.innerHTML = '<div class="search-result-subject">' + t.subject + '</div>' +
          '<div class="search-result-meta">' + fmtDate(t.date) + ' ・ ' + counterparty + '</div>' +
          '<div>' + t.snippet + '</div>';
        item.addEventListener('click', () => {
          document.querySelectorAll('.search-result-item').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');

          selectedThread = {
            threadId: t.threadId,
            subject: t.subject,
            messageId: t.messageId,
            allMessageIds: t.allMessageIds
          };

          document.getElementById('mailTo').value = t.clientEmails.join(', ');
          const ccField = document.getElementById('mailCc');
          const ccList = parseEmailList(ccField.value);
          if (!ccList.includes(window.APP_CONSTANTS.REQUIRED_CC)) ccList.push(window.APP_CONSTANTS.REQUIRED_CC);
          ccField.value = ccList.join(', ');

          const subj = t.subject.startsWith('Re:') ? t.subject : ('Re: ' + t.subject);
          document.getElementById('mailSubject').value = subj;

          banner.classList.remove('hidden');
          banner.textContent = 'このスレッドの本当の最新メッセージへの返信として下書きを作成します: ' + t.subject + '（' + fmtDate(t.date) + '）';
        });
        resultsEl.appendChild(item);
      });
    } catch (e) {
      resultsEl.innerHTML = '<div class="search-result-meta">エラー: ' + (e && e.message ? e.message : String(e)) + '</div>';
    } finally {
      searchBtn.disabled = false;
    }
  });
}

// ---- Gmail下書き作成 ----
function wireGmailDraft() {
  const createBtn = document.getElementById('createGmailBtn');
  const gmailStatus = document.getElementById('gmailStatus');

  createBtn.addEventListener('click', async () => {
    const contactName = document.getElementById('mailContactName').value.trim();
    const toList = parseEmailList(document.getElementById('mailTo').value);
    const ccList = parseEmailList(document.getElementById('mailCc').value);
    if (!ccList.includes(window.APP_CONSTANTS.REQUIRED_CC)) ccList.push(window.APP_CONSTANTS.REQUIRED_CC);
    let subject = document.getElementById('mailSubject').value.trim();
    const manualBody = document.getElementById('mailBody').value.trim();

    if (toList.length === 0) {
      setStatus(gmailStatus, '宛先メールアドレスを入力してください', 'err');
      return;
    }
    if (!manualBody) {
      setStatus(gmailStatus, '本文を入力してください', 'err');
      return;
    }
    if (selectedThread && subject && !subject.startsWith('Re:')) {
      subject = 'Re: ' + subject;
    }

    const body = contactName ? (contactName + '様\n\n' + manualBody) : manualBody;

    createBtn.disabled = true;
    setStatus(gmailStatus, 'Googleログイン・下書き作成中...', 'pending');
    try {
      const result = await createGmailDraft({
        to: toList,
        cc: ccList,
        subject,
        body,
        threadId: selectedThread ? selectedThread.threadId : undefined,
        inReplyToMessageId: selectedThread ? selectedThread.messageId : undefined,
        referencesMessageIds: selectedThread ? selectedThread.allMessageIds : undefined
      });
      setStatus(gmailStatus, 'Gmailに下書きを作成しました' + (result.id ? ' (ID: ' + result.id + ')' : ''), 'ok');
    } catch (e) {
      setStatus(gmailStatus, 'エラー: ' + (e && e.message ? e.message : String(e)), 'err');
    } finally {
      createBtn.disabled = false;
    }
  });
}

window.addEventListener('DOMContentLoaded', () => {
  populateAssigneeSelect();
  initDefaults();
  wireExtract();
  wireSlackSend();
  wireCopyButton();
  wireMailSearch();
  wireGmailDraft();
});
