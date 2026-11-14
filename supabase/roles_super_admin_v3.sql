-- ============================================================
-- 角色权限体系 · 步骤3（v3 完整版）：修复外键 + 重建超级管理员
-- 一次性解决两件事：
--   1) tasks.created_by / approved_by 原本引用 auth.users 但没设级联，
--      导致删除任何用户（含超管）都被外键绊住，后台报
--      "Failed to delete selected users: Database error loading user"。
--      这里改为 ON DELETE SET NULL（删用户时这些字段置空，不再挡删除）。
--   2) 重建超管 02602069 / 初始密码 123456，并补上 auth.identities 身份行
--      （手动插 auth.users 漏它就会登录报 500）。
-- 在 Supabase SQL Editor 执行一次即可。
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- 第1步：修复 tasks 外键（幂等，动态找约束名再改） ----------
do $$
declare
  r record;
begin
  for r in
    select conname
    from pg_constraint c
    join pg_attribute a on a.attnum = any(c.conkey) and a.attrelid = c.conrelid
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'tasks'
      and a.attname in ('created_by','approved_by')
      and c.contype = 'f'
  loop
    execute format('alter table public.tasks drop constraint if exists %I', r.conname);
  end loop;
end $$;

alter table public.tasks
  add constraint tasks_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete set null,
  add constraint tasks_approved_by_fkey
    foreign key (approved_by) references auth.users(id) on delete set null;

-- ---------- 第2步：重建超管（删旧 + 补身份行 + 写角色） ----------
do $$
declare
  new_id uuid;
  inst   uuid;
begin
  select id into inst from auth.instances limit 1;
  if inst is null then
    inst := '00000000-0000-0000-0000-000000000000';
  end if;

  -- 清掉旧账号（含 profile 与身份关联；tasks 的引用字段已改为 SET NULL，不会挡删除）
  delete from public.profiles where id in (
    select id from auth.users where email = '02602069@wtb.local'
  );
  delete from auth.identities where identity_data->>'email' = '02602069@wtb.local';
  delete from auth.users where email = '02602069@wtb.local';

  -- 创建用户主记录（补全 aud / instance_id / role）
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    inst, gen_random_uuid(), 'authenticated', 'authenticated',
    '02602069@wtb.local', crypt('123456', gen_salt('bf')),
    now(), '{"provider":"email","providers":["email"]}', '{}',
    now(), now()
  ) returning id into new_id;

  -- 关键：补身份关联记录，否则 GoTrue 登录查 schema 会 500
  insert into auth.identities (
    id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), new_id,
    jsonb_build_object('sub', new_id::text, 'email', '02602069@wtb.local'),
    'email', '02602069@wtb.local', now(), now(), now()
  );

  -- 写入 profiles 角色（幂等）
  insert into public.profiles (id, role, display_name, hr_code, created_at)
  values (new_id, 'super_admin', '超级管理员', '02602069', now())
  on conflict (id) do update set
    role = 'super_admin', display_name = '超级管理员', hr_code = '02602069';
end $$;
