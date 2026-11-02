-- ============================================================
-- 工作任务台 · 数据库结构 v2（自定义账号：人事编码登录）
-- 执行方式：Supabase 控制台 → SQL Editor → 新建查询 → 粘贴全部内容 → Run
-- 注意：本脚本会 DROP 并重建 tasks / profiles 旧表，首次运行无影响；
--       若之前已有任务数据，请先自行备份再执行（目前项目尚未正式使用，可直接执行）。
-- ============================================================

-- 删除旧结构（首次运行自动跳过）
drop table if exists public.tasks cascade;
drop table if exists public.profiles cascade;

-- 1) 成员（账号）表：管理员导入人事编码 + 姓名，初始密码 123456
create table if not exists public.members (
  code              text        primary key,                 -- 人事编码（登录账号）
  name              text        not null,                   -- 姓名
  password_hash     text        not null,                   -- SHA-256(密码) 十六进制
  must_change_pwd   boolean     not null default true,       -- 首次登录是否必须改密码
  is_admin          boolean     not null default false,      -- 是否为管理员（可见“成员管理”）
  pushplus_token    text,                                  -- 微信推送(PushPlus)令牌，可为空
  remind_lead_hours integer     not null default 24,         -- 提前多少小时提醒
  created_at        timestamptz not null default now(),
  created_by        text                                        -- 导入者的人事编码
);

create index if not exists members_name_idx on public.members (name);

-- 2) 任务表（团队共享：所有成员可见/可增/可改/可删）
create table if not exists public.tasks (
  id            uuid        primary key default gen_random_uuid(),
  title         text        not null,
  description   text        not null default '',
  priority      text        not null default 'medium' check (priority in ('high','medium','low')),
  tags          text[]      not null default '{}',
  due_date      timestamptz,                              -- 截止日期
  recurrence    text        not null default 'none'  check (recurrence in ('none','daily','weekly','monthly')),
  status        text        not null default 'todo'   check (status in ('todo','doing','done')),
  sort_order    integer     not null default 0,          -- 拖拽排序用
  creator_code  text,                                     -- 添加人的人事编码
  creator_name  text,                                     -- 添加人的姓名
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists tasks_sort_idx on public.tasks (sort_order);
create index if not exists tasks_due_idx  on public.tasks (due_date);

-- ============================================================
-- 行级安全策略（RLS）
-- 说明：本应用无独立后端，前端用 anon key 直连 Supabase，因此 anon 对
--       members / tasks 拥有全部权限。这适合内部小团队使用；
--       今后若需更强安全（避免密码哈希被读取/被任意改），可加一个
--       Edge Function 用 service_role 代理写操作，再把 anon 改为只读。
-- ============================================================
alter table public.members enable row level security;
alter table public.tasks    enable row level security;

drop policy if exists "members_all" on public.members;
create policy "members_all" on public.members
  for all using (true) with check (true);

drop policy if exists "tasks_all" on public.tasks;
create policy "tasks_all" on public.tasks
  for all using (true) with check (true);

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
