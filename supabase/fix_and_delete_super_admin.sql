-- ============================================================
-- 修复外键 + 彻底删除旧的超管账号（单独执行一次，自身可独立成功）
-- 重要：本脚本不含"建新账号"，所以不会因为后面步骤报错而整体回滚。
-- 执行后：旧账号 02602069@wtb.local 被删除，tasks 外键改为 SET NULL（以后删用户不再被绊）。
-- 之后请改用后台 Authentication → Users → Add user 建号（官方接口，不会缺字段）。
-- ============================================================

create extension if not exists pgcrypto;

-- 1) 把 tasks 两个外键改为「删除时置空」，这样删任何用户都不会被任务引用绊住
alter table public.tasks drop constraint if exists tasks_created_by_fkey;
alter table public.tasks drop constraint if exists tasks_approved_by_fkey;
alter table public.tasks
  add constraint tasks_created_by_fkey
    foreign key (created_by) references auth.users(id) on delete set null,
  add constraint tasks_approved_by_fkey
    foreign key (approved_by) references auth.users(id) on delete set null;

-- 2) 双保险：显式把引用该用户的任务字段置空，再删账号（profiles/identities 随级联删除）
do $$
declare
  uid uuid;
begin
  select id into uid from auth.users where email = '02602069@wtb.local';
  if uid is not null then
    update public.tasks set created_by = null where created_by = uid;
    update public.tasks set approved_by = null where approved_by = uid;
    delete from auth.identities where user_id = uid;
    delete from public.profiles where id = uid;
    delete from auth.users where id = uid;
  end if;
end $$;
