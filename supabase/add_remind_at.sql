-- ============================================================
-- 工作任务台 · 安全迁移：为 tasks 表新增「提醒时间」列
-- 执行方式：Supabase 控制台 → SQL Editor → 新建查询 → 粘贴下面内容 → Run
-- 重要：本文件只【加列】，绝不 drop 数据。请勿在此运行 schema.sql（那会清空任务）。
-- ============================================================

alter table public.tasks
  add column if not exists remind_at timestamptz;   -- 提醒时间（精确到分钟，到点发邮件提醒）

create index if not exists tasks_remind_idx
  on public.tasks (remind_at);
