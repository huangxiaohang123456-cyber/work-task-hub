-- ============================================================
-- 角色权限体系 · 步骤2：tasks 表新增审批字段 + 重写 RLS（共享清单 + 按角色控权）
-- 执行方式：Supabase 控制台 → SQL Editor → New query → 粘贴全部 → Run
-- 只需执行一次（幂等）。
-- 说明：本脚本会删除旧的「每用户隔离」策略 tasks_owner，改为新的共享 + 角色策略。
-- ============================================================

-- 新增审批相关字段（owner_name 之前已建，这里不重复）
alter table public.tasks
  add column if not exists approval_status text not null default 'approved'
    check (approval_status in ('pending','approved','rejected')),
  add column if not exists created_by uuid default auth.uid() references auth.users(id),
  add column if not exists approved_by uuid references auth.users(id),
  add column if not exists reject_reason text;

create index if not exists tasks_approval_idx on public.tasks (approval_status);
create index if not exists tasks_created_idx  on public.tasks (created_by);

-- 移除旧的「每用户隔离」策略（按 user_id 隔离，已不适用）
drop policy if exists "tasks_owner" on public.tasks;

-- 可见性（SELECT）：已通过 → 全员可见；创建者 → 看自己的；管理员/超管 → 全看
drop policy if exists "tasks_select" on public.tasks;
create policy "tasks_select" on public.tasks
  for select using (
    approval_status = 'approved'
    or created_by = auth.uid()
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('admin','super_admin'))
  );

-- 新增（INSERT）：只能建自己的任务（created_by 必须等于当前用户）
drop policy if exists "tasks_insert" on public.tasks;
create policy "tasks_insert" on public.tasks
  for insert with check (created_by = auth.uid());

-- 修改（UPDATE）：管理员/超管可改任何人；创建者仅能改自己的任务
drop policy if exists "tasks_update" on public.tasks;
create policy "tasks_update" on public.tasks
  for update using (
    exists (select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin','super_admin'))
    or created_by = auth.uid()
  );

-- 删除（DELETE）：管理员/超管可删任何人；创建者仅能删「未通过」的自己任务
drop policy if exists "tasks_delete" on public.tasks;
create policy "tasks_delete" on public.tasks
  for delete using (
    exists (select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin','super_admin'))
    or (created_by = auth.uid() and approval_status <> 'approved')
  );
