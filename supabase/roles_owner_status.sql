-- ============================================================
-- 负责人可改任务执行状态（待办/进行中/已完成）
-- 作用：
--   1) tasks 新增负责人 uid 字段 owner_id（无外键，避免删除账号时被外键卡住）
--   2) UPDATE 策略放行「负责人本人」，让普通人员作为负责人也能改状态
-- 执行：Supabase 控制台 → SQL Editor → New query → 粘贴全部 → Run（幂等，可重复跑）
-- 说明：不碰 SELECT / DELETE 策略；审批流与内容锁定触发器保持不变。
-- ============================================================

-- 1) 新增负责人 uid（仅存用户 id 做精确判定，故意不加外键约束）
alter table public.tasks
  add column if not exists owner_id uuid;

create index if not exists tasks_owner_id_idx on public.tasks (owner_id);

-- 2) 重写 UPDATE 策略：管理员/超管 或 创建人 或 负责人本人 可改
--    - owner_id = auth.uid()：负责人精确匹配（新任务由下拉写入）
--    - owner_name 兜底：兼容历史任务没有 owner_id 的情况（按本人姓名匹配）
--    负责人即使能 UPDATE，内容锁定触发器仍禁止其改标题/截止日期等，只能改执行状态，安全。
drop policy if exists "tasks_update" on public.tasks;
create policy "tasks_update" on public.tasks
  for update using (
    exists (select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin','super_admin'))
    or created_by = auth.uid()
    or owner_id = auth.uid()
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.display_name = tasks.owner_name)
  )
  with check (
    exists (select 1 from public.profiles p
            where p.id = auth.uid() and p.role in ('admin','super_admin'))
    or created_by = auth.uid()
    or owner_id = auth.uid()
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.display_name = tasks.owner_name)
  );
