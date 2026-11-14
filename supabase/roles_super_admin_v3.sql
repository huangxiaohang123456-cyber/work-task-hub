-- ============================================================
-- 角色权限体系 · 步骤3（v3，补全身份关联）：重建超级管理员
-- 与 v2 区别：额外插入 auth.identities 身份行。
-- 手动 INSERT auth.users 登录报 "Database error querying schema" 时，
-- 多半就是缺这条身份关联记录，本脚本一次性补全。
-- 账号 02602069 / 初始密码 123456。在 Supabase SQL Editor 执行一次。
-- ============================================================

create extension if not exists pgcrypto;

do $$
declare
  new_id uuid;
  inst   uuid;
begin
  select id into inst from auth.instances limit 1;
  if inst is null then
    inst := '00000000-0000-0000-0000-000000000000';
  end if;

  -- 清掉旧账号（含 profile 与身份关联），避免重复邮箱冲突
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
    id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(), new_id,
    jsonb_build_object('sub', new_id::text, 'email', '02602069@wtb.local'),
    'email', now(), now(), now()
  );

  -- 写入 profiles 角色（幂等）
  insert into public.profiles (id, role, display_name, hr_code, created_at)
  values (new_id, 'super_admin', '超级管理员', '02602069', now())
  on conflict (id) do update set
    role = 'super_admin', display_name = '超级管理员', hr_code = '02602069';
end $$;
