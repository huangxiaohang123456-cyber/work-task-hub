-- ============================================================
-- 角色权限体系 · 步骤3（稳健版）：重建超级管理员
-- 账号 02602069，初始密码 123456。先在 Supabase SQL Editor 执行一次。
-- 与旧版区别：补全 aud / instance_id / role 等登录必需字段，
-- 并先删除可能已存在的旧账号，避免重复。幂等、安全。
-- ============================================================

create extension if not exists pgcrypto;

do $$
declare
  new_id uuid;
  inst   uuid;
begin
  -- 取项目实例 id；取不到则用全零（单租户模式下 GoTrue 也能识别）
  select id into inst from auth.instances limit 1;
  if inst is null then
    inst := '00000000-0000-0000-0000-000000000000';
  end if;

  -- 删除可能已存在的旧账号（连 profile 一起清，避免重复邮箱冲突）
  delete from public.profiles where id in (
    select id from auth.users where email = '02602069@wtb.local'
  );
  delete from auth.users where email = '02602069@wtb.local';

  -- 重新创建：补全所有登录必需字段
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

  -- 写入 / 修正 profiles 角色（幂等）
  insert into public.profiles (id, role, display_name, hr_code, created_at)
  values (new_id, 'super_admin', '超级管理员', '02602069', now())
  on conflict (id) do update set
    role = 'super_admin', display_name = '超级管理员', hr_code = '02602069';
end $$;
