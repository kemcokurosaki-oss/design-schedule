const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

const PROCESS_MANAGERS = [
  { email: 's-morimura@kusakabe.com', name: '森村' },
  { email: 'e-kurosaki@kusakabe.com', name: '黒崎' },
];

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

async function sendEmail(toEmail, toName, tasksList) {
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: {
        to_email: toEmail,
        to_name: toName,
        tasks_list: tasksList,
      },
    }),
  });
  if (!res.ok) throw new Error(`EmailJS error: ${await res.text()}`);
  console.log(`送信完了: ${toEmail}`);
}

async function main() {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

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

  // 本日期限のタスクを取得
  const todayTasks = await supabaseFetch(
    `tasks?select=*&task_type=eq.drawing&is_archived=neq.true&end_date=gte.${todayStr}&end_date=lt.${tomorrowStr}`
  );
  // 1週間後が期限のタスクを取得
  const weekTasks = await supabaseFetch(
    `tasks?select=*&task_type=eq.drawing&is_archived=neq.true&end_date=gte.${in7DaysStr}&end_date=lt.${in8DaysStr}`
  );

  const allTasks = [
    ...todayTasks.map(t => ({ ...t, label: '【本日期限】' })),
    ...weekTasks.map(t => ({ ...t, label: '【1週間前】' })),
  ];

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
  const addLine = (email, name, line) => {
    if (!email) return;
    if (!notifications[email]) notifications[email] = { name, lines: [] };
    notifications[email].lines.push(line);
  };

  allTasks.forEach(task => {
    const endDate = task.end_date ? task.end_date.substring(0, 10) : '';
    const line = `${task.label} ${task.owner} / ${task.text}（完了予定日：${endDate}）`;
    const member = nameToMember[task.owner];

    if (member) {
      // 担当者本人
      addLine(member.email, member.name, line);
      // 上長1
      if (member.supervisor_email_1) {
        addLine(member.supervisor_email_1, emailToName[member.supervisor_email_1] || member.supervisor_email_1, line);
      }
      // 上長2
      if (member.supervisor_email_2) {
        addLine(member.supervisor_email_2, emailToName[member.supervisor_email_2] || member.supervisor_email_2, line);
      }
    } else {
      console.warn(`メンバー未登録: ${task.owner}`);
    }

    // 工程管理者（全タスク通知）
    PROCESS_MANAGERS.forEach(pm => {
      addLine(pm.email, pm.name, line);
    });
  });

  // メール送信
  for (const [email, info] of Object.entries(notifications)) {
    try {
      await sendEmail(email, info.name, info.lines.join('\n'));
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
