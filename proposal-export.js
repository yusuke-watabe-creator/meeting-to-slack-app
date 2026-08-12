// proposal.html（資料作成ページ）専用。
// Claude Codeの sales-proposal スキル（~/.claude/skills/sales-proposal/knowledge/input-template.md）に
// 渡す入力を、このページのフォーム内容だけで完結して組み立て、クリップボードにコピーする。
// 提案書pptxの生成自体はここでは行わない（Claude Code側の役割）。
// index.html（商談メモ）とは独立したページなので、app.jsのヘルパーには依存しない。

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = 'status ' + (kind || 'pending');
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

const PROPOSAL_PRODUCT_LABELS = {
  'meo-dashboard': 'MEO Dashboard byGMO',
  'local-geo-dash': 'Local GEO Dash! byGMO（MEO Dashboardとセット）',
  'other': 'その他（未登録の商材）'
};

function getAssigneeLabel(assigneeId) {
  const found = (window.APP_CONSTANTS.ASSIGNEES || []).find(a => a.id === assigneeId);
  return found ? found.label : '（未指定）';
}

function populateAssigneeSelect() {
  const select = document.getElementById('assignee');
  window.APP_CONSTANTS.ASSIGNEES.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.label;
    select.appendChild(opt);
  });
}

function v(text) {
  const t = (text || '').trim();
  return t || '（未記入）';
}

function onOff(checked, note) {
  return checked ? 'ON（' + note + '）' : 'OFF（未提供、提案書側にプレースホルダーを作成）';
}

function readProposalFields() {
  return {
    dealDate: document.getElementById('dealDate').value,
    dealName: document.getElementById('dealName').value.trim(),
    assigneeId: document.getElementById('assignee').value,
    transcript: document.getElementById('transcript').value.trim(),
    product: document.getElementById('proposalProduct').value,
    phase: document.getElementById('proposalPhase').value,
    industryScale: document.getElementById('proposalIndustryScale').value.trim(),
    website: document.getElementById('proposalWebsite').value.trim(),
    decisionMaker: document.getElementById('proposalDecisionMaker').value.trim(),
    contactPerson: document.getElementById('proposalContactPerson').value.trim(),
    budget: document.getElementById('proposalBudget').value.trim(),
    timeline: document.getElementById('proposalTimeline').value.trim(),
    competitorStatus: document.getElementById('proposalCompetitorStatus').value.trim(),
    planPolicy: document.getElementById('proposalPlanPolicy').value.trim(),
    pastCases: document.getElementById('proposalPastCases').value.trim(),
    chkDiagnosis: document.getElementById('proposalChkDiagnosis').checked,
    chkCompetitor: document.getElementById('proposalChkCompetitor').checked,
    chkEffect: document.getElementById('proposalChkEffect').checked,
    chkQA: document.getElementById('proposalChkQA').checked
  };
}

function buildProposalExportText(f) {
  const productLabel = PROPOSAL_PRODUCT_LABELS[f.product] || f.product;
  const assigneeLabel = getAssigneeLabel(f.assigneeId);

  return [
    '【sales-proposalスキル用 入力データ】',
    '',
    '商材：' + productLabel,
    '',
    '■相手企業情報',
    '- 企業名・案件名：' + v(f.dealName),
    '- 業種・規模：' + v(f.industryScale),
    '- Webサイト：' + v(f.website),
    '',
    '■商談情報',
    '- 商談日：' + v(f.dealDate),
    '- フェーズ：' + v(f.phase),
    '- 出席者：決裁者 ' + v(f.decisionMaker) + ' ／ 担当者 ' + v(f.contactPerson) + ' ／ 弊社 ' + assigneeLabel,
    '- 文字起こし：',
    v(f.transcript),
    '',
    '■商談条件',
    '- 予算感：' + v(f.budget),
    '- 希望導入時期：' + v(f.timeline),
    '- 比較検討状況：' + v(f.competitorStatus),
    '- プラン方針：' + v(f.planPolicy),
    '',
    '■その他',
    '- 参考にしたい過去の類似支援実績：' + v(f.pastCases),
    '',
    '■チェックボックス（sales-proposalスキルのinput-template.md準拠）',
    '- 診断データ：' + onOff(f.chkDiagnosis, 'GBP診断結果・Ahrefs Brand Radar等のデータを別途渡します'),
    '- 競合比較：' + onOff(f.chkCompetitor, '比較検討中の他社情報を別途渡します'),
    '- 効果試算：' + onOff(f.chkEffect, '先方の実データを別途渡します'),
    '- Q&A：' + (f.chkQA ? 'ON（想定Q&Aを含めてください）' : 'OFF（Q&Aセクションは省略）'),
    '',
    '---',
    '上記の内容を使って、sales-proposalスキルで提案書を作成してください。'
  ].join('\n');
}

function wireProposalExport() {
  const btn = document.getElementById('copyProposalDataBtn');
  const status = document.getElementById('proposalExportStatus');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const fields = readProposalFields();
    if (!fields.dealName) {
      setStatus(status, '「1. 基本情報」の会社名・案件名を入力してください', 'err');
      return;
    }
    if (!fields.transcript) {
      setStatus(status, '「2. 文字起こし・議事録」を入力してください', 'err');
      return;
    }

    const text = buildProposalExportText(fields);
    try {
      await copyToClipboard(text);
      setStatus(status, 'コピーしました。Claude Codeのチャットに貼り付けて提案書作成を依頼してください', 'ok');
    } catch (e) {
      setStatus(status, 'コピーに失敗しました: ' + (e && e.message ? e.message : String(e)), 'err');
    }
  });
}

window.addEventListener('DOMContentLoaded', () => {
  populateAssigneeSelect();
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('dealDate').value = today;
  wireProposalExport();
});
