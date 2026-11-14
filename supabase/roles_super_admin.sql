-- ============================================================
-- 角色权限体系 · 步骤3：一键创建超级管理员
-- 账号 02602069，初始密码 123456。仅在 Supabase SQL Editor 执行【一次】。
-- 执行后，用「账号 02602069 / 密码 123456」登录即可；
-- 登录后可在「我的 → 修改密码」里改成你自己的密码。
-- 幂等：重复执行不会创建重复账号，也不会改掉你已修改过的密码。
-- ============================================================

-- 确保密码加密函数可用（大多数 Supabase 项目已默认启用，这里幂等兜底）
create extension if not exists pgcrypto;

do $$
declare new_id uuid;
begin
  -- 已存在则取现成 id，不存在则新建
  select id into new_id from auth.users where email = '02602069@wtb.local';
  if new_id is null then
    insert into auth.users (
      id, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, created_at, updated_at
    )
    values (
      gen_random_uuid(), '02602069@wtb.local',
      crypt('123456', gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', now(), now()
    )
    returning id into new_id;
  end if;

  -- 写入 / 修正 profiles 角色（幂等）
  insert into public.profiles (id, role, display_name, hr_code, created_at)
  values (new_id, 'super_admin', '超级管理员', '02602069', now())
  on conflict (id) do update set role = 'super_admin', display_name = '超级管理员', hr_code = '02602069';
end $$;
