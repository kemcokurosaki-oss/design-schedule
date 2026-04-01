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

// 担当者の表示順（設計工程表のプルダウンと同じ順）
const OWNER_ORDER = ['藤山','田中','田中(善)','安岡','川邊','檀','堀井','宮﨑','津田','古村','柴田','橋本','松本(英)'];

async function sendEmail(toEmail, toName, tasksList) {
  await transporter.sendMail({
    from: `"設計工程通知" <${GMAIL_USER}>`,
    to: toEmail,
    subject: '【設計工程通知】完了予定日が近いタスクのお知らせ',
    text: `${toName} 様\n\n完了予定日が近いタスクをお知らせします。\n\n${tasksList}\n\n確認をお願いします。\n\n※このメールは自動送信です。`,
  });
  console.log(`送信完了: ${toEmail}`);
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

  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const in7Days = new Date(today);
  in7Days.setDate(today.getDate() + 7);
  const in7DaysStr = in7Days.toISOString().split('T')[0];

  const in8Days = new Date(today);
  in8Days.setDate(today.getDate() + 8);
  const in8DaysStr = in8Days.toISOString().split('T')[0];

  console.log(`チェック日: ${todayStr} / 7日後: ${in7DaysStr}`);

  // 図面：本日期限
  const drawingToday = await supabaseFetch(
    `tasks?select=*&task_type=eq.drawing&is_archived=neq.true&end_date=gte.${todayStr}&end_date=lt.${tomorrowStr}`
  );
  // 図面：1週間後
  const drawingWeek = await supabaseFetch(
    `tasks?select=*&task_type=eq.drawing&is_archived=neq.true&end_date=gte.${in7DaysStr}&end_date=lt.${in8DaysStr}`
  );
  // 図面：期限切れ
  const drawingOverdue = await supabaseFetch(
    `tasks?select=*&task_type=eq.drawing&is_archived=neq.true&end_date=not.is.null&end_date=lt.${todayStr}`
  );
  // 長納期品：本日
  const llToday = await supabaseFetch(
    `tasks?select=*&task_type=eq.long_lead_item&is_archived=neq.true&end_date=gte.${todayStr}&end_date=lt.${tomorrowStr}`
  );
  // 長納期品：1週間後
  const llWeek = await supabaseFetch(
    `tasks?select=*&task_type=eq.long_lead_item&is_archived=neq.true&end_date=gte.${in7DaysStr}&end_date=lt.${in8DaysStr}`
  );
  // 長納期品：期限切れ
  const llOverdue = await supabaseFetch(
    `tasks?select=*&task_type=eq.long_lead_item&is_archived=neq.true&end_date=not.is.null&end_date=lt.${todayStr}`
  );

  const isCompleted = t => {
    if (t.task_type === 'long_lead_item') return t.status === '完了';
    const total = Number(t.total_sheets) || 0;
    const done  = Number(t.completed_sheets) || 0;
    return total > 0 && done >= total;
  };

  const allTasks = [
    ...drawingOverdue.map(t => ({ ...t, label: '【期限切れ】', mode: '図面' })),
    ...drawingToday.map(t => ({ ...t, label: '【本日期限】', mode: '図面' })),
    ...drawingWeek.map(t => ({ ...t, label: '【1週間前】', mode: '図面' })),
    ...llOverdue.map(t => ({ ...t, label: '【期限切れ】', mode: '長納期品' })),
    ...llToday.map(t => ({ ...t, label: '【本日期限】', mode: '長納期品' })),
    ...llWeek.map(t => ({ ...t, label: '【1週間前】', mode: '長納期品' })),
  ].filter(t => !isCompleted(t));

  if (allTasks.length === 0) {
    console.log('通知対象タスクなし');
    return;
  }
  console.log(`対象タスク: ${allTasks.length}件`);

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

  // 受信者ごとに通知内容をまとめる
  const notifications = {};
  // isOwnTask=true: 担当者本人宛て / false: 上長・管理者宛て
  const addLine = (email, name, entry, isOwnTask) => {
    if (!email) return;
    if (!notifications[email]) notifications[email] = { name, lines: [] };
    notifications[email].lines.push({ ...entry, isOwnTask });
  };

  const testMode = process.env.TEST_MODE === 'true';
  if (testMode) console.log('テストモード: 工程管理者のみに送信');

  allTasks.forEach(task => {
    const endDate = task.end_date ? task.end_date.substring(0, 10) : '';
    const machine = [task.machine, task.unit].filter(Boolean).join(' ');
    const dateLabel = task.mode === '長納期品' ? '手配予定日' : '完了予定日';
    const text = `${task.label} [${task.project_number}] ${machine ? machine + ' / ' : ''}${task.owner} / ${task.text}（${dateLabel}：${endDate}）`;
    const entry = { text, mode: task.mode, label: task.label, owner: task.owner, project_number: task.project_number };
    const member = nameToMember[task.owner];

    if (!testMode) {
      if (member) {
        addLine(member.email, member.name, entry, true);  // 担当者本人
        if (member.supervisor_email_1) {
          addLine(member.supervisor_email_1, emailToName[member.supervisor_email_1] || member.supervisor_email_1, entry, false);
        }
        if (member.supervisor_email_2) {
          addLine(member.supervisor_email_2, emailToName[member.supervisor_email_2] || member.supervisor_email_2, entry, false);
        }
      } else {
        console.warn(`メンバー未登録: ${task.owner}`);
      }
    }

    const targets = testMode
      ? PROCESS_MANAGERS.filter(pm => pm.email === 'e-kurosaki@kusakabe.com')
      : PROCESS_MANAGERS;
    targets.forEach(pm => {
      addLine(pm.email, pm.name, entry, false);  // 工程管理者
    });
  });

  const sortByProject = arr => arr.slice().sort((a, b) => (a.project_number || '').localeCompare(b.project_number || ''));

  // 担当者本人向け：緊急度別セクション、工事番号順
  const buildPersonalSections = (lines, mode) => {
    const filtered = lines.filter(l => l.mode === mode);
    const overdue = sortByProject(filtered.filter(l => l.label === '【期限切れ】')).map(l => l.text);
    const todayL  = sortByProject(filtered.filter(l => l.label === '【本日期限】')).map(l => l.text);
    const weekL   = sortByProject(filtered.filter(l => l.label === '【1週間前】')).map(l => l.text);
    const s = [];
    if (overdue.length) s.push(`■ 期限切れ\n${overdue.join('\n')}`);
    if (todayL.length)  s.push(`■ 本日期限\n${todayL.join('\n')}`);
    if (weekL.length)   s.push(`■ 1週間前\n${weekL.join('\n')}`);
    return s;
  };

  // 上長・管理者向け：担当者別グループ、1担当者内は緊急度順→工事番号順
  const LABEL_ORDER = { '【期限切れ】': 0, '【本日期限】': 1, '【1週間前】': 2 };
  const buildManagerSections = (lines, mode) => {
    const filtered = lines.filter(l => l.mode === mode);
    if (filtered.length === 0) return [];
    const byOwner = {};
    filtered.forEach(l => {
      if (!byOwner[l.owner]) byOwner[l.owner] = [];
      byOwner[l.owner].push(l);
    });
    return Object.keys(byOwner)
      .sort((a, b) => {
        const ia = OWNER_ORDER.indexOf(a);
        const ib = OWNER_ORDER.indexOf(b);
        if (ia === -1 && ib === -1) return a.localeCompare(b);
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      })
      .map(owner => {
        const sorted = byOwner[owner].sort((a, b) => {
          const la = LABEL_ORDER[a.label] ?? 9;
          const lb = LABEL_ORDER[b.label] ?? 9;
          if (la !== lb) return la - lb;
          return (a.project_number || '').localeCompare(b.project_number || '');
        });
        // 緊急度が変わるところで1行空ける
        const lines = [];
        let prevLabel = null;
        sorted.forEach(l => {
          if (prevLabel !== null && prevLabel !== l.label) lines.push('');
          lines.push(l.text);
          prevLabel = l.label;
        });
        return `▼ ${owner}\n${lines.join('\n')}`;
      });
  };

  // メール送信
  for (const [email, info] of Object.entries(notifications)) {
    try {
      const isManager = info.lines.some(l => !l.isOwnTask);
      const build = isManager ? buildManagerSections : buildPersonalSections;
      const sections = [];
      const dSections = build(info.lines, '図面');
      const lSections = build(info.lines, '長納期品');
      if (dSections.length) sections.push(`== 図面 ==\n${dSections.join('\n\n')}`);
      if (lSections.length) sections.push(`== 長納期品 ==\n${lSections.join('\n\n')}`);
      await sendEmail(email, info.name, sections.join('\n\n'));
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
