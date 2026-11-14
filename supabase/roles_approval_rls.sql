-- ============================================================
-- 角色权限体系 · 步骤3：审批流 RLS 增强（数据库层收口审批流转）
-- 目的：
--   1) 防止普通人员绕过审批，直接把任务改成「已通过」；
--   2) 防止任何人篡改任务创建人（created_by）；
--   3) 锁定审批中 / 已通过任务的内容（仅「已驳回」可改内容重新提交）。
-- 执行：Supabase 控制台 → SQL Editor → 粘贴全部 → Run。只需一次（幂等）。
-- 注意：本脚本不改动现有 SELECT / DELETE 规则（approved 全员可见、
--       未通过仅创建者+管理员可见；删除仅管理员或创建者删未通过）。
-- ============================================================

-- ---------- 触发器函数：UPDATE 时校验审批流转与内容锁定 ----------
create or replace function public.tasks_update_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  -- 当前操作者角色（没有 profiles 记录时按普通人员处理）
  select p.role into v_role from public.profiles p where p.id = auth.uid();
  v_role := coalesce(v_role, 'member');

  -- 1) 创建人永远不能改（归属锁定）
  if NEW.created_by is distinct from OLD.created_by then
    raise exception '不能修改任务的创建人';
  end if;

  -- 2) 非管理员/超管：限制审批状态流转
  if v_role not in ('admin', 'super_admin') then
    if NEW.approval_status is distinct from OLD.approval_status then
      -- 仅允许「已驳回 -> 待审批」的重新提交
      if not (OLD.approval_status = 'rejected' and NEW.approval_status = 'pending') then
        raise exception '只有管理员可以审批通过任务（被驳回后可重新提交）';
      end if;
    end if;

    -- 3) 内容锁定：待审批 / 已通过 阶段不能改内容字段
    if OLD.approval_status in ('pending', 'approved') then
      if NEW.title is distinct from OLD.title
         or NEW.description is distinct from OLD.description
         or NEW.priority is distinct from OLD.priority
         or NEW.due_date is distinct from OLD.due_date
         or NEW.owner_name is distinct from OLD.owner_name then
        raise exception '当前状态下不能修改任务内容';
      end if;
    end if;
  end if;

  return NEW;
end;
$$;

-- 绑定触发器（先删后建，幂等）
drop trigger if exists tasks_update_guard_trg on public.tasks;
create trigger tasks_update_guard_trg
  before update on public.tasks
  for each row execute function public.tasks_update_guard();

-- ---------- UPDATE 策略补 WITH CHECK（双保险：禁止把 created_by 改成他人） ----------
drop policy if exists "tasks_update" on public.tasks;
create policy "tasks_update" on public.tasks
  for update using (
    exists (select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin','super_admin'))
    or created_by = auth.uid()
  )
  with check (
    exists (select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin','super_admin'))
    or created_by = auth.uid()
  );
