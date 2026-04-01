const nodemailer = require('nodemailer');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const GMAIL_USER   = process.env.GMAIL_USER;
const GMAIL_PASS   = process.env.GMAIL_APP_PASSWORD;

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

async function sendEmail(toEmail, toName, body) {
  await transporter.sendMail({
    from: `"設計工程通知" <${GMAIL_USER}>`,
    to: toEmail,
    subject: '【設計工程通知】期日を過ぎたタスクのお知らせ',
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

  // end_date は YYYY-MM-DD 文字列で格納されている
  const endParts = String(task.end_date).split('T')[0].split('-');
  const endDay = new Date(+endParts[0], +endParts[1] - 1, +endParts[2]);
  if (isNaN(endDay.getTime())) return false;

  // DB の end_date はガントの排他的終了日（+1日分）なので -1日して実際の完了日に
  endDay.setDate(endDay.getDate() - 1);

  return endDay > wishDay;
}

// 工事番号で空行を挟みつつ行を結合
function buildSection(tasks, mode) {
  if (tasks.length === 0) return null;
  const dateLabel    = mode === '長納期品' ? '手配予定日' : '完了予定日';
  const wishLabel    = mode === '長納期品' ? '手配期日'   : '出図希望日';

  tasks.sort((a, b) => (a.project_number || '').localeCompare(b.project_number || ''));

  const lines = [];
  let prevProject = null;
  tasks.forEach(t => {
    const machine  = [t.machine, t.unit].filter(Boolean).join(' ');
    const endDate  = t.end_date  ? String(t.end_date).split('T')[0]  : 'なし';
    const wishDate = t.wish_date ? String(t.wish_date).split('T')[0] : 'なし';
    if (prevProject !== null && prevProject !== t.project_number) lines.push('');
    lines.push(`[${t.project_number}] ${machine ? machine + ' / ' : ''}${t.owner} / ${t.text}（${dateLabel}：${endDate} / ${wishLabel}：${wishDate}）`);
    prevProject = t.project_number;
  });

  return `== ${mode} ==\n${lines.join('\n')}`;
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

  const sections = [];
  const dSection = buildSection(overdueDrawing, '図面');
  const lSection = buildSection(overdueLl,      '長納期品');
  if (dSection) sections.push(dSection);
  if (lSection) sections.push(lSection);
  const body = sections.join('\n\n');

  const testMode = process.env.TEST_MODE === 'true';
  if (testMode) console.log('テストモード: e-kurosaki@kusakabe.comのみに送信');

  const targets = testMode
    ? PROCESS_MANAGERS.filter(pm => pm.email === 'e-kurosaki@kusakabe.com')
    : PROCESS_MANAGERS;

  for (const pm of targets) {
    try {
      await sendEmail(pm.email, pm.name, body);
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
