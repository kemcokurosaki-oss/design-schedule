// 通知メールの送信を一か所にまとめたモジュール。
// Microsoft 365 の共有メールボックス（koutei-notify@kusakabe.com）から Graph API で送る。
// （2026-10-15 に Gmail から切り替え、Gmail での送信は撤去した）
//
// メール本体は nodemailer で MIME 形式に組み立ててから Graph に渡すため、
// .ics 添付・HTML本文・宛先表記などはそのまま送れる。
//
// 環境変数: M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET, M365_SENDER（共有メールボックスのアドレス）
const nodemailer = require('nodemailer');

// 呼び出し側（予定表方式の判定など）との互換のために残している。送信は常に Graph
const MAIL_PROVIDER  = 'graph';
const IS_GRAPH       = true;
const SENDER_ADDRESS = process.env.M365_SENDER;

const REQUIRED_ENV = ['M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_CLIENT_SECRET', 'M365_SENDER'];

function requireMailEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`メール送信用の環境変数が未設定です: ${missing.join(', ')}`);
  }
}

// "表示名" <送信元アドレス>
function formatFrom(displayName, address = SENDER_ADDRESS) {
  return `"${displayName}" <${address}>`;
}

let mimeBuilder = null;
let tokenCache  = null; // { token, expiresAt }

async function getGraphToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const res = await fetch(`https://login.microsoftonline.com/${process.env.M365_TENANT_ID}/oauth2/v2.0/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     process.env.M365_CLIENT_ID,
      client_secret: process.env.M365_CLIENT_SECRET,
      scope:         'https://graph.microsoft.com/.default',
      grant_type:    'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Graph トークン取得エラー [${res.status}]: ${await res.text()}`);
  const json = await res.json();
  // 期限ぎりぎりで失効しないよう、5分早めに取り直す
  tokenCache = { token: json.access_token, expiresAt: Date.now() + (json.expires_in - 300) * 1000 };
  return tokenCache.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 共有メールボックス（/users/{M365_SENDER}）配下の Graph API を呼ぶ。
// body が文字列ならそのまま、オブジェクトなら JSON にして送る。応答が JSON なら解析して返す
async function graphRequest(method, path, body = null, contentType = 'application/json') {
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SENDER_ADDRESS)}${path}`;
  const payload = body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));

  for (let attempt = 1; ; attempt++) {
    const headers = { 'Authorization': `Bearer ${await getGraphToken()}` };
    if (payload !== undefined) headers['Content-Type'] = contentType;
    const res = await fetch(url, { method, headers, body: payload });
    if (res.ok) {
      const text = await res.text();
      if (!text) return null;
      // メールの原文（/$value）など JSON 以外の応答は文字列のまま返す
      return (res.headers.get('content-type') || '').includes('json') ? JSON.parse(text) : text;
    }
    // 送信数の制限(429)や一時的な障害(5xx)は、少し待って2回まで再試行する
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers.get('retry-after')) || 5 * attempt;
      await sleep(retryAfter * 1000);
      continue;
    }
    throw new Error(`Graph エラー [${res.status}] ${method} ${path}: ${await res.text()}`);
  }
}

// nodemailer の sendMail と同じ引数（from / to / cc / subject / text / html / attachments）を受け取る
async function sendMail(mailOptions) {
  if (!mimeBuilder) {
    mimeBuilder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  }
  const { message } = await mimeBuilder.sendMail(mailOptions);
  await graphRequest('POST', '/sendMail', message.toString('base64'), 'text/plain');
}

module.exports = { MAIL_PROVIDER, IS_GRAPH, SENDER_ADDRESS, requireMailEnv, formatFrom, sendMail, graphRequest };
