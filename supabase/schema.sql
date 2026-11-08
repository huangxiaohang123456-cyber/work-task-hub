-- ============================================================
-- 工作任务台 · 数据库结构 v5（登录隔离版 · 邮箱注册登录 · 每用户数据隔离）
-- 执行方式：Supabase 控制台 → SQL Editor → 新建查询 → 粘贴全部 → Run
-- 说明：
--   1) 登录用 Supabase 自带的 Auth（邮箱 + 密码），用户在 App 内注册/登录，无需自建后端。
--   2) 每个任务归属一个用户（user_id = auth.users.id），通过 RLS 强制隔离：
--      用户只能看 / 改 / 删自己的任务，看不到别人的。
--   3) anon 角色对 tasks 没有任何权限，必须由已登录用户的 JWT 才能读写。
--   4) 邮箱确认请关闭（否则注册后要点邮件链接才能登录）：
--      Supabase 后台 → Authentication → Providers → Email → 取消勾选 "Confirm email"。
--      关闭后注册即用，最省事；后续"截止前发邮件提醒"由我们自己的定时任务实现。
-- ============================================================

-- 删除旧结构（首次运行自动跳过）
drop table if exists public.tasks cascade;
drop table if exists public.members cascade;
drop table if exists public.profiles cascade;

-- 任务表（每用户隔离：user_id 绑定登录账号）
create table if not exists public.tasks (
  id            uuid         primary key default gen_random_uuid(),
  user_id       uuid         not null default auth.uid() references auth.users(id) on delete cascade,
  title         text         not null,                                  -- 标题
  description   text         not null default '',                       -- 描述
  priority      text         not null default 'medium'
                  check (priority in ('high','medium','low')),           -- 优先级
  tags          text[]       not null default '{}',                     -- 标签（数组）
  recurrence    text         not null default 'none'
                  check (recurrence in ('none','daily','weekly','monthly')), -- 周期
  status        text         not null default 'todo'
                  check (status in ('todo','doing','done')),            -- 状态
  due_date      timestamptz,                                           -- 截止日期
  remind_at     timestamptz,                                           -- 提醒时间（精确到分钟，到点发邮件提醒）
  reminded_at   timestamptz,                                           -- 提醒邮件已发送时间（去重，避免重复发）
  creator_name  text         not null default '',                       -- 添加人（本地设置填写）
  created_at    timestamptz  not null default now(),
  completed_at  timestamptz,                                           -- 完成时间（用于趋势统计）
  updated_at    timestamptz  not null default now()
);

create index if not exists tasks_user_idx    on public.tasks (user_id);
create index if not exists tasks_due_idx     on public.tasks (due_date);
create index if not exists tasks_remind_idx  on public.tasks (remind_at);
create index if not exists tasks_reminded_idx on public.tasks (reminded_at);
create index if not exists tasks_status_idx  on public.tasks (status);

-- ============================================================
-- 行级安全策略（RLS）：仅本人可读写自己的数据
-- ============================================================
alter table public.tasks enable row level security;

drop policy if exists "tasks_owner" on public.tasks;
create policy "tasks_owner" on public.tasks
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ============================================================
-- 触发器：更新任务时自动刷新 updated_at
-- ============================================================
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tasks_updated_at on public.tasks;
create trigger tasks_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();
