// Google Calendar freebusy 連携。Google Identity Services のTokenClientでアクセストークンを取得し、
// バックエンドを介さず直接 www.googleapis.com/calendar/v3/freeBusy を叩く。
// 予定の件名・詳細は取得せず、「今この瞬間Busyかどうか」だけを見る(calendar.freebusyスコープ)。

let gisCalendarTokenClient = null;
let calendarAccessToken = null;

function getGisCalendarTokenClient() {
  if (!gisCalendarTokenClient) {
    gisCalendarTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: window.APP_CONFIG.GOOGLE_CLIENT_ID,
      scope: window.APP_CONSTANTS.CALENDAR_SCOPES,
      callback: () => {} // requestAccessTokenのたびに差し替える
    });
  }
  return gisCalendarTokenClient;
}

// ユーザー操作(クリック)起点のハンドラ内から呼ぶこと(GISの制約)。
function ensureCalendarToken() {
  return new Promise((resolve, reject) => {
    if (calendarAccessToken) {
      resolve(calendarAccessToken);
      return;
    }
    const client = getGisCalendarTokenClient();
    client.callback = (resp) => {
      if (resp.error) {
        reject(new Error('Google認証エラー: ' + resp.error));
        return;
      }
      calendarAccessToken = resp.access_token;
      resolve(calendarAccessToken);
    };
    client.requestAccessToken({ prompt: '' });
  });
}

async function calendarFetch(url, options) {
  const token = await ensureCalendarToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options && options.headers),
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json'
    }
  });
  if (res.status === 401) {
    // トークン失効 → 破棄して1回だけ再試行
    calendarAccessToken = null;
    const token2 = await ensureCalendarToken();
    return fetch(url, {
      ...options,
      headers: {
        ...(options && options.headers),
        Authorization: 'Bearer ' + token2,
        'Content-Type': 'application/json'
      }
    });
  }
  return res;
}

// 指定したメールアドレス群について、「今この瞬間」が既存の予定でBusyかどうかを取得する。
// 戻り値: { [email]: boolean }
async function fetchNowBusyMap(emails) {
  const now = Date.now();
  const timeMin = new Date(now - 5 * 60 * 1000).toISOString();
  const timeMax = new Date(now + 5 * 60 * 1000).toISOString();
  const res = await calendarFetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    body: JSON.stringify({ timeMin, timeMax, items: emails.map(id => ({ id })) })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('カレンダー取得エラー(' + res.status + '): ' + body);
  }
  const data = await res.json();
  const busyMap = {};
  emails.forEach(email => {
    const cal = data.calendars && data.calendars[email];
    const busy = (cal && cal.busy) || [];
    busyMap[email] = busy.some(b => {
      const s = new Date(b.start).getTime(), e = new Date(b.end).getTime();
      return now >= s && now < e;
    });
  });
  return busyMap;
}
