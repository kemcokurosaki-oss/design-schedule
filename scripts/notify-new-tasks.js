const nodemailer = require('nodemailer');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD;

const PROCESS_MANAGERS = [
  { email: 's-morimura@kusakabe.com', name: '森村' },
  { email: 'e-kurosaki@kusakabe.com', name: '黒崎' },
];

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

async function sendEmail(toEmail, toName, subject, body) {
  await transporter.sendMail({
    from: `"設計工程通知" <${GMAIL_USER}>`,
    to: toEmail,
    subject,
    text: `${toName} 様\n\n本日追加されたタスクをお知らせします。\n\n${body}\n\n※このメールは自動送信です。`,
  });
  console.log(`送信完了: ${toEmail}`);
}

function buildSection(tasks, mode) {
  if (tasks.length === 0) return null;
  const dateLabel = mode === '長納期品' ? '手配予定日' : '完了予定日';

  // 工事番号順にソート
  tasks.sort((a, b) => (a.project_number || '').localeCompare(b.project_number || ''));

  const lines = tasks.map(t => {
    const machine = [t.machine, t.unit].filter(Boolean).join(' ');
    const endDate = t.end_date ? t.end_date.substring(0, 10) : 'なし';
    return `[${t.project_number}] ${machine ? machine + ' / ' : ''}${t.owner} / ${t.text}（${dateLabel}：${endDate}）`;
  });

  return `== ${mode} ==\n${lines.join('\n')}`;
}

async function main() {
  const testMode = process.env.TEST_MODE === 'true';
  if (testMode) console.log('テストモード: e-kurosaki@kusakabe.comのみに送信');

  // 前日9時JST〜当日9時JSTに追加されたタスクを取得（UTC換算: 前日0:00〜当日0:00）
  const today = new Date();
  const todayUTC = today.toISOString().split('T')[0];

  // 土日チェック（UTC 0:00実行 = JST 9:00 なので曜日は一致）
  const dayOfWeek = today.getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    console.log('土日のため通知をスキップします');
    return;
  }

  // 休日チェック
  const holidays = await supabaseFetch(`holidays?select=date&date=eq.${todayUTC}`);
  if (holidays.length > 0) {
    console.log(`休日（${todayUTC}）のため通知をスキップします`);
    return;
  }
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const yesterdayUTC = yesterday.toISOString().split('T')[0];
  const rangeStart = `${yesterdayUTC}T00:00:00`;
  const rangeEnd   = `${todayUTC}T00:00:00`;

  console.log(`対象期間: ${rangeStart} 〜 ${rangeEnd}`);

  const drawingTasks = await supabaseFetch(
    `tasks?select=*&task_type=eq.drawing&is_archived=neq.true&created_at=gte.${rangeStart}&created_at=lt.${rangeEnd}&order=project_number.asc`
  );
  const llTasks = await supabaseFetch(
    `tasks?select=*&task_type=eq.long_lead_item&is_archived=neq.true&created_at=gte.${rangeStart}&created_at=lt.${rangeEnd}&order=project_number.asc`
  );

  console.log(`図面: ${drawingTasks.length}件 / 長納期品: ${llTasks.length}件`);

  if (drawingTasks.length === 0 && llTasks.length === 0) {
    console.log('本日追加されたタスクなし');
    return;
  }

  const sections = [];
  const dSection = buildSection(drawingTasks, '図面');
  const lSection = buildSection(llTasks, '長納期品');
  if (dSection) sections.push(dSection);
  if (lSection) sections.push(lSection);

  const body = sections.join('\n\n');
  const subject = '【設計工程通知】本日追加されたタスクのお知らせ';

  const targets = testMode
    ? PROCESS_MANAGERS.filter(pm => pm.email === 'e-kurosaki@kusakabe.com')
    : PROCESS_MANAGERS;

  for (const pm of targets) {
    try {
      await sendEmail(pm.email, pm.name, subject, body);
    } catch (e) {
      console.error(`送信失敗: ${pm.email} - ${e.message}`);
    }
  }

  console.log('完了');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
