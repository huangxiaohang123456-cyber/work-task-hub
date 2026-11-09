-- 为 tasks 表新增「负责人」字段（任务负责人姓名，文本）
-- 用途：添加任务时记录负责人，必填。
-- 在 Supabase 后台 SQL Editor 执行一次即可（幂等，重复执行无副作用）。
alter table public.tasks add column if not exists owner_name text;
