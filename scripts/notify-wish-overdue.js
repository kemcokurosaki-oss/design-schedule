const nodemailer = require('nodemailer');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const GMAIL_USER   = process.env.GMAIL_USER;
const GMAIL_PASS   = process.env.GMAIL_APP_PASSWORD;

const PROCESS_MANAGERS = [
  { email: 's-morimura@kusakabe.com', name: '森村' },
  { email: 'e-kurosaki@kusakabe.com', name: '黒崎' },
];

const OWNER_ORDER = ['藤山','田中','安岡','川邊','檀','堀井','宮﨑','津田','古村','柴田','橋本','松本(英)'];

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_PASS },
});

async function supabaseFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase error: ${await res.text()}`);
  return res.json();
}

async function sendEmail(toEmail, toName, body, testMode = false) {
  await transporter.sendMail({
    from: `"設計工程通知" <${GMAIL_USER}>`,
    to: toEmail,
    subject: (testMode ? '【テスト】' : '') + '【設計工程通知】期日を過ぎたタスクのお知らせ',
    text: `${toName} 様\n\n完了予定日（手配予定日）が出図希望日（手配期日）を過ぎているタスクをお知らせします。\n\n${body}\n\n確認をお願いします。\n\n※このメールは自動送信です。`,
  });
  console.log(`送信完了: ${toEmail}`);
}

// wish_dateを超過しているか判定（end_date は排他的終了日なので -1日して比較）
function isWishOverdue(task) {
  if (!task.wish_date || !task.end_date) return false;
  const parts = String(task.wish_date).split('-');
  if (parts.length !== 3) return false;
  const wishDay = new Date(+parts[0], +parts[1] - 1, +parts[2]);
  if (isNaN(wishDay.getTime())) return false;

  const endParts = String(task.end_date).split('T')[0].split('-');
  const endDay = new Date(+endParts[0], +endParts[1] - 1, +endParts[2]);
  if (isNaN(endDay.getTime())) return false;

  endDay.setDate(endDay.getDate() - 1);
  return endDay > wishDay;
}

function formatTaskLine(t) {
  const dateLabel = t.mode === '長納期品' ? '手配予定日' : '完了予定日';
  const wishLabel = t.mode === '長納期品' ? '手配期日'   : '出図希望日';
  const machine   = [t.machine, t.unit].filter(Boolean).join(' ');
  const endDate   = t.end_date  ? String(t.end_date).split('T')[0]  : 'なし';
  const wishDate  = t.wish_date ? String(t.wish_date).split('T')[0] : 'なし';
  return `[${t.project_number}] ${machine ? machine + ' / ' : ''}${t.owner} / ${t.text}（${dateLabel}：${endDate} / ${wishLabel}：${wishDate}）`;
}

// 上長・管理者向け: モード別、担当者別グループ（OWNER_ORDER順）、工事番号順
function buildManagerSections(tasks, mode) {
  const filtered = tasks.filter(t => t.mode === mode);
  if (filtered.length === 0) return [];
  const byOwner = {};
  filtered.forEach(t => {
    if (!byOwner[t.owner]) byOwner[t.owner] = [];
    byOwner[t.owner].push(t);
  });
  const ownerBlocks = Object.keys(byOwner)
    .sort((a, b) => {
      const ia = OWNER_ORDER.indexOf(a);
      const ib = OWNER_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    })
    .map(owner => {
      const sorted = byOwner[owner].sort((a, b) => (a.project_number || '').localeCompare(b.project_number || ''));
      const lines = [];
      let prevProject = null;
      sorted.forEach(t => {
        if (prevProject !== null && prevProject !== t.project_number) lines.push('');
        lines.push(formatTaskLine(t));
        prevProject = t.project_number;
      });
      return `▼ ${owner}\n${lines.join('\n')}`;
    });
  return [`== ${mode} ==\n${ownerBlocks.join('\n\n')}`];
}

async function main() {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // 土日チェック（UTC 0:00実行 = JST 9:00 なので曜日は一致）
  const dayOfWeek = today.getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log('土日のため通知をスキップします');
    return;
  }

  // 休日チェック
  const holidays = await supabaseFetch(`holidays?select=date&date=eq.${todayStr}`);
  if (holidays.length > 0) {
    console.log(`休日（${todayStr}）のため通知をスキップします`);
    return;
  }

  // 図面・長納期品のwish_dateありタスクを全取得（未アーカイブ）
  const drawingTasks = await supabaseFetch(
    `tasks?select=*&task_type=eq.drawing&is_archived=neq.true&wish_date=not.is.null`
  );
  const llTasks = await supabaseFetch(
    `tasks?select=*&task_type=eq.long_lead_item&is_archived=neq.true&wish_date=not.is.null`
  );

  // 完了済み除外 & wish_date超過フィルタ
  const isCompleted = t => {
    if (t.task_type === 'long_lead_item') return t.status === '完了';
    const total = Number(t.total_sheets) || 0;
    const done  = Number(t.completed_sheets) || 0;
    return total > 0 && done >= total;
  };

  const overdueDrawing = drawingTasks.filter(t => !isCompleted(t) && isWishOverdue(t));
  const overdueLl      = llTasks.filter(t => !isCompleted(t) && isWishOverdue(t));

  console.log(`図面: ${overdueDrawing.length}件 / 長納期品: ${overdueLl.length}件`);

  if (overdueDrawing.length === 0 && overdueLl.length === 0) {
    console.log('該当タスクなし');
    return;
  }

  const testMode = process.env.TEST_MODE === 'true';
  if (testMode) console.log('テストモード: e-kurosaki@kusakabe.comのみに送信');

  // メンバー情報を取得
  const members = await supabaseFetch('members?select=*');
  const nameToMember = {};
  const emailToName = {};
  members.forEach(m => {
    nameToMember[m.name] = m;
    emailToName[m.email] = m.name;
  });
  PROCESS_MANAGERS.forEach(pm => {
    emailToName[pm.email] = pm.name;
  });

  // 受信者ごとに通知内容をまとめる（上長・工程管理者のみ、担当者本人には送らない）
  const notifications = {};
  const addTask = (email, name, task) => {
    if (!email) return;
    if (!notifications[email]) notifications[email] = { name, tasks: [] };
    notifications[email].tasks.push(task);
  };

  const allOverdue = [
    ...overdueDrawing.map(t => ({ ...t, mode: '図面' })),
    ...overdueLl.map(t => ({ ...t, mode: '長納期品' })),
  ];

  allOverdue.forEach(task => {
    const member = nameToMember[task.owner];
    if (!testMode) {
      if (member) {
        if (member.supervisor_email1) {
          addTask(member.supervisor_email1, emailToName[member.supervisor_email1] || member.supervisor_email1, task);
        }
        if (member.supervisor_email_2) {
          addTask(member.supervisor_email_2, emailToName[member.supervisor_email_2] || member.supervisor_email_2, task);
        }
      } else {
        console.warn(`メンバー未登録: ${task.owner}`);
      }
    }

    const targets = testMode
      ? PROCESS_MANAGERS.filter(pm => pm.email === 'e-kurosaki@kusakabe.com')
      : PROCESS_MANAGERS;
    targets.forEach(pm => {
      addTask(pm.email, pm.name, task);  // 工程管理者
    });
  });

  // メール送信（全員に担当者別グループ表示）
  for (const [email, info] of Object.entries(notifications)) {
    try {
      const sections = [];
      const dSections = buildManagerSections(info.tasks, '図面');
      const lSections = buildManagerSections(info.tasks, '長納期品');
      if (dSections.length) sections.push(...dSections);
      if (lSections.length) sections.push(...lSections);
      await sendEmail(email, info.name, sections.join('\n\n'), testMode);
    } catch (e) {
      console.error(`送信失敗: ${email} - ${e.message}`);
    }
  }

  console.log('完了');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
