-- ============================================================
-- 工作任务台 · 安全迁移：为 tasks 表新增「提醒已发送」标记列
-- 用途：记录提醒邮件的已发送时间，避免每个周期重复发送同一封。
-- 执行方式：Supabase 控制台 → SQL Editor → 新建查询 → 粘贴下面内容 → Run
-- 重要：本文件只【加列】，绝不 drop 数据。可重复跑（用了 if not exists）。
-- ============================================================

alter table public.tasks
  add column if not exists reminded_at timestamptz;   -- 提醒邮件已发送时间（去重用）

create index if not exists tasks_reminded_idx
  on public.tasks (reminded_at);
