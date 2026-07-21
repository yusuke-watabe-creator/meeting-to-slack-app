// 「渡部T タスク管理」ボード（tasks.html）と同じFirebase Realtime Databaseに
// タスクを1件追加するための連携。ボード側のteam2/tasksと同じデータ構造で書き込む。

const TASK_BOARD_CONFIG = {
  apiKey: "AIzaSyC6hDHQhmq7VKoUKaOnDlBQFcscv__HYig",
  authDomain: "taiki-tasks-933cc.firebaseapp.com",
  databaseURL: "https://taiki-tasks-933cc-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "taiki-tasks-933cc",
  storageBucket: "taiki-tasks-933cc.firebasestorage.app",
  messagingSenderId: "679381676234",
  appId: "1:679381676234:web:20b54086cd302494c0c433"
};

// SlackメンションのassigneeId → タスクボードの担当者名（渡部/横井/上浦/太田）
const TASK_BOARD_ASSIGNEE = {
  '': '渡部',
  'U07TZQ8718C': '横井',
  'U06BHSCK811': '太田',
  'U06C6P5EW3A': '上浦'
};

let _taskBoardDbPromise = null;

async function getTaskBoardDb() {
  if (!_taskBoardDbPromise) {
    _taskBoardDbPromise = (async () => {
      const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
      const { getDatabase, ref, set } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js');
      const app = initializeApp(TASK_BOARD_CONFIG, 'meeting-to-slack-app');
      const db = getDatabase(app);
      return { db, ref, set };
    })();
  }
  return _taskBoardDbPromise;
}

// dealName等をteam2/tasksと同じ形式で1件追加する。
async function addTaskBoardEntry({ assigneeId, dealName, nextAction }) {
  const { db, ref, set } = await getTaskBoardDb();
  const assignee = TASK_BOARD_ASSIGNEE[assigneeId] || '渡部';
  const id = Date.now();
  const task = {
    id,
    createdAt: id,
    name: dealName || nextAction,
    memo: dealName ? nextAction : '',
    cat: '',
    priority: '',
    due: '',
    dueTime: '',
    assignee
  };
  await set(ref(db, 'team2/tasks/' + id), task);
  return task;
}
