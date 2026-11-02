-- ============================================================
-- 工作任务台 · Supabase 数据库结构
-- 执行方式：在 Supabase 控制台 → SQL Editor 中粘贴全部内容运行
-- ============================================================

-- 1) 用户资料表（登录后自动创建一行）
create table if not exists public.profiles (
  id               uuid        primary key references auth.users(id) on delete cascade,
  name             text,
  email            text,
  pushplus_token   text,                      -- 微信推送(PushPlus)令牌，可为空
  remind_lead_hours integer   not null default 24,  -- 提前多少小时提醒
  created_at       timestamptz not null default now()
);

-- 2) 任务表（团队共享：所有登录用户可见/可增/可改/可删）
create table if not exists public.tasks (
  id           uuid        primary key default gen_random_uuid(),
  title        text        not null,
  description  text        not null default '',
  priority     text        not null default 'medium' check (priority in ('high','medium','low')),
  tags         text[]      not null default '{}',
  due_date     timestamptz,                       -- 截止日期
  recurrence   text        not null default 'none' check (recurrence in ('none','daily','weekly','monthly')),
  status       text        not null default 'todo'  check (status in ('todo','doing','done')),
  sort_order   integer     not null default 0,     -- 拖拽排序用
  creator_id   uuid        references auth.users(id),
  creator_name text,                             -- 添加人的名字
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists tasks_sort_idx on public.tasks (sort_order);
create index if not exists tasks_due_idx  on public.tasks (due_date);

-- ============================================================
-- 行级安全策略（RLS）
-- 设计：团队共享工作区，任何已登录用户都能查看/新增/修改/删除任务。
-- 若以后要做“多团队隔离”，再在此处加 workspace_id 条件即可。
-- ============================================================
alter table public.profiles enable row level security;
alter table public.tasks    enable row level security;

-- profiles：登录用户可读取所有人资料（用于显示添加人名字）；只能改自己
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select using (auth.uid() is not null);

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update using (auth.uid() = id);

-- tasks：已登录用户拥有全部权限（团队共享）
drop policy if exists "tasks_all_authed" on public.tasks;
create policy "tasks_all_authed" on public.tasks
  for all using (auth.uid() is not null) with check (auth.uid() is not null);

-- ============================================================
-- 触发器
-- ============================================================
-- 新用户注册后自动建 profile
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 更新任务时自动刷新 updated_at
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
