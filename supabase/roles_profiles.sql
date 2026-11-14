-- ============================================================
-- 角色权限体系 · 步骤1：profiles 表（角色 / 姓名 / 人事编码）
-- 执行方式：Supabase 控制台 → SQL Editor → New query → 粘贴全部 → Run
-- 只需执行一次（幂等，重复执行无副作用）。
-- ============================================================

create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  role          text not null default 'member'
                check (role in ('super_admin','admin','member')),
  display_name  text,
  hr_code       text,                 -- 人事编码（即登录用的数字账号）
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- 登录用户均可读取 profiles（团队内展示姓名/角色、后台列账号用）
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select using (auth.role() = 'authenticated');

-- 仅超级管理员可改 / 删 profiles（提拔管理员、撤销等）。
-- 账号创建由 Edge Function（service_role）完成，不经客户端 RLS。
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles
  for update using (
    exists (select 1 from public.profiles p
            where p.id = auth.uid() and p.role = 'super_admin')
  );

drop policy if exists "profiles_delete" on public.profiles;
create policy "profiles_delete" on public.profiles
  for delete using (
    exists (select 1 from public.profiles p
            where p.id = auth.uid() and p.role = 'super_admin')
  );
