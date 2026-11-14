-- ============================================================
-- 角色权限体系 · 诊断：检查超管账号状态（只读，不会改任何数据）
-- 在 Supabase SQL Editor 执行，把结果截图发我，我据此判断。
-- ============================================================
select
  email,
  case when email_confirmed_at is not null then '已确认' else '未确认' end as 邮箱状态,
  case when encrypted_password is not null then '有密码' else '无密码' end as 密码状态,
  coalesce(aud, 'NULL') as aud,
  coalesce(instance_id::text, 'NULL') as instance_id,
  (select role from public.profiles where id = auth.users.id) as 角色
from auth.users
where email = '02602069@wtb.local';
