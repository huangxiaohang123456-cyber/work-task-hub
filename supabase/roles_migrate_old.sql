-- ============================================================
-- 角色权限体系 · 步骤4：老任务迁移
-- 作用：把已有的 tasks 标记为「已通过」并进共享清单；回填 created_by（原创建者）。
-- 执行方式：Supabase 控制台 → SQL Editor → New query → 粘贴 → Run
-- 只需执行一次（幂等）。
-- 注意：老任务的「负责人(owner_name)」此前多为空，会显示为空白，不影响功能；
--      如需补名字可后续手动在应用内编辑。
-- ============================================================

update public.tasks
set approval_status = 'approved',
    created_by = coalesce(created_by, user_id)
where created_by is null or approval_status is distinct from 'approved';
