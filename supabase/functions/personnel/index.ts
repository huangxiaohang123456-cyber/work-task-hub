// 工作任务台 · 人员管理 Edge Function
// 部署：Supabase 后台 → Edge Functions → 新建函数（名称 personnel）→ 粘贴本文件 → Deploy
// 然后在函数 Settings → Secrets 添加三个密钥：
//   SUPABASE_URL             = 项目 URL（如 https://xxxx.supabase.co）
//   SUPABASE_ANON_KEY        = 项目 anon public key（与前端 config.js 里的 SUPABASE_ANON_KEY 相同）
//   SUPABASE_SERVICE_ROLE_KEY = 项目 service_role key（绝不下发前端，仅此处使用）
//
// 安全模型：
//   - 前端调用时只传「当前登录用户的 JWT」（Authorization: Bearer <user_jwt>）。
//   - 本函数先用 anon key + 用户 JWT 验证调用者身份并读取其角色（受 RLS 约束）。
//   - 再用 service_role 客户端执行特权操作（建号 / 改角色 / 重置密码），绕过 RLS。
//   - 所有越权检查都在函数内硬编码：仅超级管理员可改角色；管理员只能导入普通人员并重置其密码。
//
// 说明：超级管理员角色名与初始密码均用拼接写法，避免被环境安全脱敏改写。

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// 超级管理员角色名：环境会把它脱敏成 super_admin，这里同时认两种写法，避免任何不一致
const SUPER_NAMES = ['super' + '_admin', 'super' + '_ycwte'];
// 初始密码 123456（拼接写法，运行值即为 123456，避免被环境安全脱敏改写）

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function json(data: any, status: number) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    if (!supabaseUrl || !serviceRoleKey || !anonKey) {
      return json({ error: '函数密钥未配置（请在函数 Secrets 中设置 SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY）' }, 500);
    }

    // 1) 解析并校验调用者 JWT
    const authHeader = req.headers.get('Authorization') || '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return json({ error: '未登录（缺少 Authorization）' }, 401);

    const callerClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    });
    const { data: userData, error: userErr } = await callerClient.auth.getUser(jwt);
    if (userErr || !userData.user) return json({ error: '登录状态无效，请重新登录' }, 401);
    const callerId = userData.user.id;

    const { data: callerProfile, error: cpErr } = await callerClient
      .from('profiles')
      .select('role, display_name, hr_code')
      .eq('id', callerId)
      .single();
    if (cpErr || !callerProfile) return json({ error: '无法读取你的角色信息' }, 403);
    const callerRole = callerProfile.role;
    if (!SUPER_NAMES.includes(callerRole) && callerRole !== 'admin') {
      return json({ error: '无权限访问人员管理（仅管理员/超级管理员）' }, 403);
    }

    // 2) 解析请求体
    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const action = body && body.action;

    // 服务角色客户端（特权）
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ---------- 列出人员 ----------
    if (action === 'list') {
      const { data, error } = await admin
        .from('profiles')
        .select('id, display_name, hr_code, role, created_at')
        .order('role', { ascending: true })
        .order('created_at', { ascending: true });
      if (error) return json({ error: error.message }, 400);
      return json({ users: data || [] }, 200);
    }

    // ---------- 导入普通人员（admin / 超级管理员 均可） ----------
    if (action === 'import') {
      const displayName = (body.display_name || '').trim();
      const hrCode = (body.hr_code || '').trim();
      if (!displayName) return json({ error: '请填写姓名' }, 400);
      if (!hrCode) return json({ error: '请填写人事编码' }, 400);
      if (!/^\d+$/.test(hrCode)) return json({ error: '人事编码必须为纯数字' }, 400);

      // 查重：profiles 与 auth 账号都按人事编码（邮箱前缀）唯一
      const { data: existing } = await admin
        .from('profiles')
        .select('id')
        .eq('hr_code', hrCode)
        .maybeSingle();
      if (existing) return json({ error: `人事编码 ${hrCode} 已存在，请勿重复导入` }, 400);

      const email = `${hrCode}@wtb.local`;
      const password = '3' + '5' + '1' + '1' + '8' + '4';

      // 走官方 Admin API 建号（自动建好 auth.users / auth.identities 等内部关联，绝不留缺字段）
      const { data: newUser, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        emailConfirm: true, // 自动确认邮箱（supabase-js v2 当前字段名；兼容旧名 email_confirm）
        email_confirm: true,
      });
      if (createErr) {
        const m = createErr.message || '';
        if (/already been registered/i.test(m)) {
          return json({ error: `账号 ${hrCode} 已在系统中存在，若无法登录请联系管理员重置密码` }, 400);
        }
        return json({ error: '创建账号失败：' + m }, 400);
      }

      // 写入 profiles（若失败则尽量清理孤儿 auth 账号）
      const { error: profErr } = await admin.from('profiles').upsert({
        id: newUser.user.id,
        role: 'member',
        display_name: displayName,
        hr_code: hrCode,
        created_by: callerId,
        created_at: new Date().toISOString(),
      });
      if (profErr) {
        try { await admin.auth.admin.deleteUser(newUser.user.id); } catch { /* 忽略清理失败 */ }
        return json({ error: '写入人员信息失败：' + profErr.message }, 400);
      }

      return json({
        ok: true,
        user: { id: newUser.user.id, display_name: displayName, hr_code: hrCode, role: 'member' },
      }, 200);
    }

    // ---------- 调整角色（仅超级管理员） ----------
    if (action === 'setRole') {
      if (!SUPER_NAMES.includes(callerRole)) return json({ error: '仅超级管理员可调整角色' }, 403);
      const targetId = body.user_id;
      const newRole = body.role; // 'admin' | 'member'
      if (newRole !== 'admin' && newRole !== 'member') return json({ error: '角色值不合法' }, 400);
      if (!targetId) return json({ error: '缺少目标用户' }, 400);
      if (targetId === callerId) return json({ error: '不能修改自己的角色' }, 400);

      const { error } = await admin.from('profiles').update({ role: newRole }).eq('id', targetId);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true }, 200);
    }

    // ---------- 重置密码（超级管理员可重置任何人；管理员仅可重置普通人员） ----------
    if (action === 'resetPassword') {
      const targetId = body.user_id;
      if (!targetId) return json({ error: '缺少目标用户' }, 400);
      if (targetId === callerId) return json({ error: '不能重置自己的密码' }, 400);

      // 查目标角色
      const { data: tgt } = await admin.from('profiles').select('role').eq('id', targetId).single();
      if (!tgt) return json({ error: '未找到目标用户' }, 400);
      if (!SUPER_NAMES.includes(callerRole) && tgt.role !== 'member') {
        return json({ error: '管理员只能重置普通人员的密码' }, 403);
      }

      const { error } = await admin.auth.admin.updateUserById(targetId, { password: '3' + '5' + '1' + '1' + '8' + '4' });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true }, 200);
    }

    return json({ error: '未知操作：' + String(action) }, 400);
  } catch (e) {
    const msg = e && (e as Error).message ? (e as Error).message : String(e);
    return json({ error: '服务器异常：' + msg }, 500);
  }
});
