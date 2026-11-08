// ============================================================
// 工作任务台 · 邮件提醒脚本
// 无构建依赖：仅用 Node 内置 fetch 访问 Supabase，用 nodemailer 发 SMTP 邮件。
//
// 工作原理（每 5 分钟被 GitHub Actions 调一次）：
//   1) 查出 remind_at <= 当前时间 且 reminded_at 为空 的任务（即"到点且该发"）
//   2) 查这些任务所属用户的邮箱（auth.users）
//   3) 计算"距离截止还有多少时间"，发送中文提醒邮件
//   4) 发送成功才把 reminded_at 写为当前时间（失败则下个周期重试，不重复发）
// ============================================================

import nodemailer from 'nodemailer';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 工作台地址（邮件里附带，国内访问 github.io 可能偏慢，仅作补充）
const PAGES_URL = process.env.PAGES_URL ||
  'https://huangxiaohang123456-cyber.github.io/work-task-hub/';

const SMTP = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: (process.env.SMTP_SECURE || 'true') === 'true',
  user: process.env.SMTP_USER,
  pass: process.env.SMTP_PASS,
};

// ---------- 日期 / 文案工具 ----------
function fmt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function remainingText(dueIso) {
  const diff0 = new Date(dueIso).getTime() - Date.now();
  const overdue = diff0 <= 0;
  const diff = Math.abs(diff0);
  const day = 86400000, hour = 3600000, min = 60000;
  const d = Math.floor(diff / day);
  const h = Math.floor((diff % day) / hour);
  const m = Math.floor((diff % hour) / min);
  const parts = [];
  if (d) parts.push(`${d} 天`);
  if (h) parts.push(`${h} 小时`);
  if (m || parts.length === 0) parts.push(`${m} 分钟`);
  const core = parts.join(' ');
  return overdue ? `已逾期 ${core}` : `还有 ${core}`;
}
const priText = (p) => ({ high: '高', medium: '中', low: '低' }[p] || p || '');
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Supabase 访问（service role 绕过 RLS） ----------
async function sbGet(path, params) {
  const url = new URL(SUPABASE_URL + path);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { 'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE, 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error('GET ' + path + ' -> ' + res.status + ' ' + (await res.text()));
  return res.json();
}
async function sbPatch(path, params, body) {
  const url = new URL(SUPABASE_URL + path);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'apikey': SERVICE_ROLE, 'Authorization': 'Bearer ' + SERVICE_ROLE,
      'Content-Type': 'application/json', 'Prefer': 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('PATCH -> ' + res.status + ' ' + (await res.text()));
}

async function listUserEmails() {
  const data = await sbGet('/auth/v1/admin/users', { per_page: 1000 });
  const map = {};
  for (const u of data.users || []) if (u.id && u.email) map[u.id] = u.email;
  return map;
}

// ---------- 组装中文邮件 ----------
function buildMail(task, email) {
  const title = task.title || '(无标题)';
  const dueBlock = task.due_date
    ? `距离截止：${remainingText(task.due_date)}\n截止时间：${fmt(task.due_date)}`
    : '该任务未设置截止时间，请尽快处理。';
  const linkLine = PAGES_URL ? `\n打开工作台：${PAGES_URL}` : '';
  const text =
    `你好，你设置了一个任务提醒：\n\n` +
    `📌 任务：${title}\n` +
    `优先级：${priText(task.priority)}\n` +
    `${dueBlock}` +
    `${linkLine}\n\n—— 工作任务台`;

  const html =
    `<div style="font-family:-apple-system,Segoe UI,PingFang SC,Microsoft YaHei,sans-serif;line-height:1.7;color:#1f2937">` +
    `<p>你好，你设置了一个任务提醒：</p>` +
    `<p>📌 <strong>任务：${escapeHtml(title)}</strong></p>` +
    `<p>优先级：${priText(task.priority)}</p>` +
    (task.due_date
      ? `<p>距离截止：<strong>${remainingText(task.due_date)}</strong><br>截止时间：${fmt(task.due_date)}</p>`
      : `<p>该任务未设置截止时间，请尽快处理。</p>`) +
    (PAGES_URL ? `<p><a href="${PAGES_URL}">打开工作台</a></p>` : '') +
    `<hr><p style="color:#888;font-size:12px">—— 工作任务台</p>` +
    `</div>`;

  return { from: SMTP.user, to: email, subject: `【任务提醒】${title}`, text, html };
}

// ---------- 主流程 ----------
async function main() {
  if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  if (!SMTP.host || !SMTP.user || !SMTP.pass) throw new Error('缺少 SMTP 配置（SMTP_HOST / SMTP_USER / SMTP_PASS）');

  const transporter = nodemailer.createTransport({
    host: SMTP.host, port: SMTP.port, secure: SMTP.secure,
    auth: { user: SMTP.user, pass: SMTP.pass },
  });
  await transporter.verify(); // 先验证 SMTP 连通，避免后面逐个失败
  console.log('SMTP 连接正常：', SMTP.host);

  const nowIso = new Date().toISOString();
  const tasks = await sbGet('/rest/v1/tasks', {
    select: '*',
    'remind_at': 'lte.' + nowIso,
    'reminded_at': 'is.null',
    'order': 'remind_at.asc',
  });

  if (!Array.isArray(tasks) || tasks.length === 0) {
    console.log('本次没有需要提醒的任务');
    return;
  }
  console.log(`查到 ${tasks.length} 个待提醒任务`);

  const emails = await listUserEmails();
  let sent = 0, skipped = 0;
  for (const t of tasks) {
    const email = emails[t.user_id];
    if (!email) { console.log('跳过（找不到用户邮箱）：', t.id); skipped++; continue; }
    try {
      await transporter.sendMail(buildMail(t, email));
      await sbPatch('/rest/v1/tasks', { 'id': 'eq.' + t.id }, { reminded_at: nowIso });
      console.log('✅ 已发送：', t.title, '->', email);
      sent++;
    } catch (e) {
      console.error('❌ 发送失败（下个周期自动重试）：', t.id, e.message);
    }
  }
  console.log(`完成：发送 ${sent} 封，跳过 ${skipped} 个`);
}

main().catch((e) => { console.error('脚本错误：', e.message); process.exit(1); });
