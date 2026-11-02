/* ============================================================
 * 工作任务台 · 前端逻辑（原生 JS + Supabase 免费版）
 * 依赖（已在 index.html 以 UMD 引入）：supabase-js、dayjs、Sortable、XLSX、Chart
 * 数据全部存于 Supabase（免费、无需付费）；团队共享、邮箱登录、拖拽/筛选/统计/导出/微信推送逻辑不变。
 * 免费版会在约 7 天无数据库访问后暂停，已通过 .github/workflows/keepalive.yml 每天自动 ping 一次来兜底。
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 初始化 Supabase ----------
  const cfg = window.APP_CONFIG || {};
  const URL = cfg.SUPABASE_URL;
  const KEY = cfg.SUPABASE_ANON_KEY;
  const LS_USER = 'wtb_local_user';

  let supabase = null, ready = false;
  if (URL && KEY && URL.indexOf('YOUR_') !== 0 && window.supabase) {
    supabase = window.supabase.createClient(URL, KEY);
    ready = true;
  }

  // ---------- 全局状态 ----------
  const state = {
    user: null,   // { uid, email, name }
    profile: null, // { name, pushplus_token, remind_lead_hours }
    tasks: [],
    filters: { status: '', priority: '', recurrence: '', search: '' },
    chart: null
  };

  // ---------- DOM 引用 ----------
  const $ = (s) => document.querySelector(s);
  const authView = $('#auth-view');
  const mainView = $('#main-view');
  const authForm = $('#auth-form');
  const authMsg = $('#auth-msg');
  const authSubmit = $('#auth-submit');
  const taskList = $('#task-list');
  const emptyHint = $('#empty-hint');
  const reminderBanner = $('#reminder-banner');

  // ============================================================
  // 启动
  // ============================================================
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    if (!ready) {
      authMsg.textContent = '⚠️ 尚未配置 Supabase。请让管理员在 assets/config.js 填入 SUPABASE_URL 与 SUPABASE_ANON_KEY。';
      authSubmit.disabled = true;
      return;
    }
    bindAuth();
    bindToolbar();
    bindModals();
    bindTaskForm();
    bindSettingsForm();
    registerSW();

    // 尝试恢复登录态
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (session && session.user) {
        state.user = { uid: session.user.id, email: session.user.email, name: (session.user.email || '').split('@')[0] };
        localStorage.setItem(LS_USER, JSON.stringify(state.user));
        await afterLogin();
        return;
      }
    } catch (e) { /* 忽略，走登录页 */ }
    showAuth();
  }

  // ============================================================
  // 认证（邮箱 + 密码）
  // ============================================================
  function bindAuth() {
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        authSubmit.textContent = t.dataset.tab === 'login' ? '登录' : '注册';
        authMsg.textContent = '';
      });
    });

    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const isLogin = authSubmit.textContent.trim() === '登录';
      const email = $('#auth-email').value.trim();
      const password = $('#auth-password').value;
      if (!email || !password) { authMsg.textContent = '请填写邮箱和密码'; return; }
      authSubmit.disabled = true;
      authMsg.textContent = '处理中…';
      try {
        if (isLogin) {
          const { error } = await supabase.auth.signInWithPassword({ email, password });
          if (error) throw error;
        } else {
          // 注册：先建账号，再尝试自动登录
          const { error: suErr } = await supabase.auth.signUp({ email, password });
          if (suErr) throw suErr;
          const { error: siErr } = await supabase.auth.signInWithPassword({ email, password });
          if (siErr) {
            authMsg.textContent = '✅ 账号已创建，但自动登录失败：' + siErr.message +
              '。请先到邮箱完成验证；或让管理员在 Supabase 后台 Authentication → Providers → Email 关闭“Confirm email”后重新登录。';
            return;
          }
        }
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('登录状态获取失败');
        const localUser = { uid: user.id, email: user.email, name: (user.email || '').split('@')[0] };
        localStorage.setItem(LS_USER, JSON.stringify(localUser));
        state.user = localUser;
        await afterLogin();
      } catch (err) {
        authMsg.textContent = '❌ ' + (err.message || err);
      } finally {
        authSubmit.disabled = false;
      }
    });
  }

  async function afterLogin() {
    showMain();
    await loadProfile();
    await loadTasks();
    checkReminders();
  }

  function showAuth() {
    mainView.classList.add('hidden');
    authView.classList.remove('hidden');
  }
  function showMain() {
    authView.classList.add('hidden');
    mainView.classList.remove('hidden');
    $('#user-name').textContent = (state.profile && state.profile.name) || (state.user && state.user.name) || '';
  }

  async function logout() {
    try { await supabase.auth.signOut(); } catch (e) { /* 忽略 */ }
    localStorage.removeItem(LS_USER);
    state.user = null; state.profile = null; state.tasks = [];
    showAuth();
  }

  // ============================================================
  // 资料（显示名 / 微信令牌 / 提前量）—— 存 profiles 表
  // ============================================================
  async function loadProfile() {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('name, pushplus_token, remind_lead_hours')
        .eq('id', state.user.uid)
        .single();
      if (data) {
        state.profile = {
          name: data.name || (state.user && state.user.name) || '',
          pushplus_token: data.pushplus_token || '',
          remind_lead_hours: data.remind_lead_hours || 24
        };
        return;
      }
      if (error) console.warn('读 profile 失败（将用默认值）：', error.message);
    } catch (e) { /* 用默认 */ }
    state.profile = {
      name: (state.user && state.user.name) || '',
      pushplus_token: '',
      remind_lead_hours: 24
    };
  }

  async function saveProfile(patch) {
    const { error } = await supabase.from('profiles').upsert({
      id: state.user.uid,
      name: patch.name,
      pushplus_token: patch.pushplusToken,
      remind_lead_hours: patch.remindLeadHours
    });
    if (error) throw error;
  }

  // ============================================================
  // 任务：加载 / 渲染 / 筛选
  // ============================================================
  async function loadTasks() {
    let data, error;
    try {
      const res = await supabase.from('tasks').select('*').order('sort_order', { ascending: true });
      data = res.data; error = res.error;
    } catch (err) { error = err; }
    if (error) { alert('加载任务失败：' + (error.message || error)); return; }
    state.tasks = (data || []).map(dbToTask);
    renderTasks();
  }

  function dbToTask(d) {
    return {
      id: d.id,
      title: d.title || '',
      description: d.description || '',
      priority: d.priority || 'medium',
      tags: d.tags || [],
      due_date: d.due_date || null,
      recurrence: d.recurrence || 'none',
      status: d.status || 'todo',
      sort_order: d.sort_order || 0,
      creator_id: d.creator_id || '',
      creator_name: d.creator_name || '',
      created_at: d.created_at || new Date().toISOString()
    };
  }

  function applyFilters() {
    const f = state.filters;
    return state.tasks.filter((t) => {
      if (f.status && t.status !== f.status) return false;
      if (f.priority && t.priority !== f.priority) return false;
      if (f.recurrence && t.recurrence !== f.recurrence) return false;
      if (f.search) {
        const q = f.search.toLowerCase();
        const hay = (t.title + ' ' + (t.tags || []).join(' ')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderTasks() {
    const list = applyFilters();
    taskList.innerHTML = '';
    emptyHint.classList.toggle('hidden', list.length > 0);

    list.forEach((t) => {
      const li = document.createElement('li');
      li.className = 'task-card';
      li.dataset.id = t.id;

      const dueInfo = renderDue(t.due_date, t.status);
      const tags = (t.tags || []).map((x) => `<span class="tag">${esc(x)}</span>`).join('');
      const recLabel = { none: '', daily: '🔁 每天', weekly: '🔁 每周', monthly: '🔁 每月' }[t.recurrence] || '';

      li.innerHTML = `
        <div class="task-drag" title="拖拽排序">⠿</div>
        <div class="task-main">
          <div class="task-title">
            <span class="badge ${t.priority}">${priText(t.priority)}</span>
            <span>${esc(t.title)}</span>
          </div>
          <div class="task-meta">
            ${t.due_date ? `<span class="due ${dueInfo.cls}">⏰ ${dueInfo.text}</span>` : ''}
            ${recLabel ? `<span class="rec">${recLabel}</span>` : ''}
            ${tags}
            <span>👤 ${esc(t.creator_name || '—')}</span>
          </div>
        </div>
        <div class="task-actions">
          <select class="status-select" data-id="${t.id}">
            <option value="todo" ${t.status === 'todo' ? 'selected' : ''}>待办</option>
            <option value="doing" ${t.status === 'doing' ? 'selected' : ''}>进行中</option>
            <option value="done" ${t.status === 'done' ? 'selected' : ''}>已完成</option>
          </select>
          <div>
            <button class="icon-btn" data-edit="${t.id}" title="编辑">✏️</button>
            <button class="icon-btn" data-del="${t.id}" title="删除">🗑️</button>
          </div>
        </div>`;
      taskList.appendChild(li);
    });

    bindTaskItemEvents();
    enableDrag();
  }

  function renderDue(due, status) {
    if (!due) return { text: '', cls: '' };
    const d = dayjs(due);
    const now = dayjs();
    const diffH = d.diff(now, 'hour', true);
    let cls = '';
    if (status !== 'done' && d.isBefore(now)) cls = 'over';
    else if (status !== 'done' && diffH <= 24) cls = 'soon';
    return { text: d.format('MM-DD HH:mm'), cls };
  }

  function priText(p) { return { high: '高', medium: '中', low: '低' }[p] || p; }

  // ---------- 任务项事件 ----------
  function bindTaskItemEvents() {
    taskList.querySelectorAll('.status-select').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const id = sel.dataset.id;
        try {
          const { error } = await supabase.from('tasks').update({ status: sel.value }).eq('id', id);
          if (error) throw error;
        } catch (e) { alert('更新失败：' + (e.message || e)); }
        await loadTasks(); checkReminders();
      });
    });
    taskList.querySelectorAll('[data-edit]').forEach((b) => {
      b.addEventListener('click', () => openTaskModal(b.dataset.edit));
    });
    taskList.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('确定删除该任务？')) return;
        const id = b.dataset.del;
        try {
          const { error } = await supabase.from('tasks').delete().eq('id', id);
          if (error) throw error;
        } catch (e) { return alert('删除失败：' + (e.message || e)); }
        await loadTasks(); checkReminders();
      });
    });
  }

  // ---------- 拖拽排序 ----------
  let sortable = null;
  function enableDrag() {
    if (sortable) sortable.destroy();
    sortable = Sortable.create(taskList, {
      handle: '.task-drag',
      animation: 150,
      onEnd: async () => {
        const ids = [...taskList.querySelectorAll('.task-card')].map((li) => li.dataset.id);
        let i = 0;
        for (const id of ids) {
          try { await supabase.from('tasks').update({ sort_order: i }).eq('id', id); }
          catch (e) { /* 忽略单条失败 */ }
          i++;
        }
        await loadTasks();
      }
    });
  }

  // ============================================================
  // 添加 / 编辑 任务
  // ============================================================
  function bindTaskForm() {
    $('#task-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = $('#task-id').value;
      const dueVal = $('#f-due').value;
      const dueIso = dueVal ? new Date(dueVal).toISOString() : null;
      const tags = $('#f-tags').value.split(',').map((s) => s.trim()).filter(Boolean);

      const data = {
        title: $('#f-title').value.trim(),
        description: $('#f-desc').value.trim(),
        priority: $('#f-priority').value,
        status: $('#f-status').value,
        due_date: dueIso,
        recurrence: $('#f-recurrence').value,
        tags
      };
      const msg = $('#task-form-msg');
      if (!data.title) { msg.textContent = '请填写标题'; return; }

      try {
        if (id) {
          const { error } = await supabase.from('tasks').update(data).eq('id', id);
          if (error) throw error;
        } else {
          data.creator_id = state.user.uid;
          data.creator_name = (state.profile && state.profile.name) || (state.user && state.user.name) || '';
          data.sort_order = state.tasks.length;
          const { error } = await supabase.from('tasks').insert(data);
          if (error) throw error;
        }
      } catch (err) {
        msg.textContent = '❌ ' + (err.message || err);
        return;
      }
      closeModal('#task-modal');
      await loadTasks(); checkReminders();
    });
  }

  function openTaskModal(id) {
    const msg = $('#task-form-msg'); msg.textContent = '';
    if (id) {
      const t = state.tasks.find((x) => x.id === id);
      if (!t) return;
      $('#task-modal-title').textContent = '编辑任务';
      $('#task-id').value = t.id;
      $('#f-title').value = t.title;
      $('#f-desc').value = t.description || '';
      $('#f-priority').value = t.priority;
      $('#f-status').value = t.status;
      $('#f-due').value = t.due_date ? toLocalInput(t.due_date) : '';
      $('#f-recurrence').value = t.recurrence;
      $('#f-tags').value = (t.tags || []).join(', ');
    } else {
      $('#task-modal-title').textContent = '添加任务';
      $('#task-form').reset();
      $('#task-id').value = '';
      $('#f-priority').value = 'medium';
      $('#f-status').value = 'todo';
      $('#f-recurrence').value = 'none';
    }
    openModal('#task-modal');
  }

  function toLocalInput(iso) {
    const d = new Date(iso);
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 16);
  }

  // ============================================================
  // 工具栏 / 筛选 / 统计 / 导出 / 推送
  // ============================================================
  function bindToolbar() {
    $('#btn-logout').addEventListener('click', logout);
    $('#btn-add').addEventListener('click', () => openTaskModal(null));
    $('#btn-stats').addEventListener('click', openStats);
    $('#btn-export').addEventListener('click', exportExcel);
    $('#btn-push').addEventListener('click', pushWeChat);
    $('#btn-settings').addEventListener('click', openSettings);

    $('#filter-status').addEventListener('change', (e) => { state.filters.status = e.target.value; renderTasks(); });
    $('#filter-priority').addEventListener('change', (e) => { state.filters.priority = e.target.value; renderTasks(); });
    $('#filter-recurrence').addEventListener('change', (e) => { state.filters.recurrence = e.target.value; renderTasks(); });
    $('#filter-search').addEventListener('input', (e) => { state.filters.search = e.target.value.trim(); renderTasks(); });
  }

  function openStats() {
    const tasks = state.tasks;
    const total = tasks.length;
    const done = tasks.filter((t) => t.status === 'done').length;
    const doing = tasks.filter((t) => t.status === 'doing').length;
    const todo = tasks.filter((t) => t.status === 'todo').length;
    const overdue = tasks.filter((t) => t.due_date && t.status !== 'done' && dayjs(t.due_date).isBefore(dayjs())).length;
    const rate = total ? Math.round((done / total) * 100) : 0;
    const byPri = { high: 0, medium: 0, low: 0 };
    tasks.forEach((t) => byPri[t.priority] = (byPri[t.priority] || 0) + 1);

    $('#stats-summary').innerHTML = `
      <div class="stat-box"><div class="num">${total}</div><div class="lbl">任务总数</div></div>
      <div class="stat-box"><div class="num" style="color:var(--green)">${done}</div><div class="lbl">已完成</div></div>
      <div class="stat-box"><div class="num">${rate}%</div><div class="lbl">完成率</div></div>
      <div class="stat-box"><div class="num" style="color:var(--red)">${overdue}</div><div class="lbl">已逾期</div></div>`;

    const ctx = $('#stats-chart');
    if (state.chart) state.chart.destroy();
    state.chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ['高', '中', '低', '待办', '进行中', '已完成'],
        datasets: [{
          label: '任务数',
          data: [byPri.high, byPri.medium, byPri.low, todo, doing, done],
          backgroundColor: ['#dc2626', '#d97706', '#16a34a', '#94a3b8', '#2563eb', '#16a34a']
        }]
      },
      options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
    });
    openModal('#stats-modal');
  }

  function exportExcel() {
    const rows = state.tasks.map((t) => ({
      '标题': t.title,
      '描述': t.description || '',
      '优先级': priText(t.priority),
      '标签': (t.tags || []).join(', '),
      '截止日期': t.due_date ? dayjs(t.due_date).format('YYYY-MM-DD HH:mm') : '',
      '周期': { none: '一次性', daily: '每天', weekly: '每周', monthly: '每月' }[t.recurrence] || '',
      '状态': { todo: '待办', doing: '进行中', done: '已完成' }[t.status] || '',
      '添加人': t.creator_name || '',
      '创建时间': dayjs(t.created_at).format('YYYY-MM-DD HH:mm')
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '工作任务');
    XLSX.writeFile(wb, '工作任务台_' + dayjs().format('YYYYMMDD') + '.xlsx');
  }

  // ---------- 临期 / 逾期 提醒 ----------
  function getDueTasks() {
    const lead = (state.profile && state.profile.remind_lead_hours) || 24;
    const now = dayjs();
    const soonCut = now.add(lead, 'hour');
    const overdue = [], soon = [];
    state.tasks.forEach((t) => {
      if (!t.due_date || t.status === 'done') return;
      const d = dayjs(t.due_date);
      if (d.isBefore(now)) overdue.push(t);
      else if (d.isBefore(soonCut)) soon.push(t);
    });
    return { overdue, soon };
  }

  function checkReminders() {
    const { overdue, soon } = getDueTasks();
    if (!overdue.length && !soon.length) { reminderBanner.classList.add('hidden'); return; }
    let html = '🔔 <b>待办提醒</b>：';
    if (overdue.length) html += `${overdue.length} 个已逾期 `;
    if (soon.length) html += `${soon.length} 个将在提醒时间内到期`;
    html += '。点“🔔 推送到微信”可发送到微信。';
    reminderBanner.innerHTML = html;
    reminderBanner.classList.remove('hidden');
  }

  async function pushWeChat() {
    const token = state.profile && state.profile.pushplus_token;
    if (!token) { alert('请先在“⚙ 设置”中填写 PushPlus 令牌。'); openSettings(); return; }
    const { overdue, soon } = getDueTasks();
    if (!overdue.length && !soon.length) { alert('当前没有临期或逾期任务，无需推送。'); return; }
    const lines = [...overdue, ...soon].map((t) => {
      const d = dayjs(t.due_date).format('MM-DD HH:mm');
      const tag = overdue.includes(t) ? '【逾期】' : '【临近】';
      return `<p>${tag} <b>${esc(t.title)}</b> 截止 ${d} · ${priText(t.priority)} · ${esc(t.creator_name || '')}</p>`;
    }).join('');
    try {
      const res = await fetch('https://www.pushplus.plus/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, title: '工作任务台 · 待办提醒', content: lines, template: 'html' })
      });
      const data = await res.json();
      if (data.code === 200) alert('✅ 已推送到微信');
      else alert('推送失败：' + (data.msg || JSON.stringify(data)));
    } catch (e) {
      alert('推送请求出错：' + e.message);
    }
  }

  // ============================================================
  // 设置（资料存 profiles 表）
  // ============================================================
  function openSettings() {
    $('#s-name').value = (state.profile && state.profile.name) || '';
    $('#s-token').value = (state.profile && state.profile.pushplus_token) || '';
    $('#s-lead').value = (state.profile && state.profile.remind_lead_hours) || 24;
    openModal('#settings-modal');
  }

  function bindSettingsForm() {
    $('#settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const patch = {
        name: $('#s-name').value.trim(),
        pushplusToken: $('#s-token').value.trim(),
        remindLeadHours: parseInt($('#s-lead').value, 10) || 24
      };
      try {
        await saveProfile(patch);
      } catch (err) {
        return alert('保存失败：' + (err.message || err));
      }
      state.profile = { ...state.profile, ...patch };
      $('#user-name').textContent = patch.name || (state.user && state.user.name) || '';
      closeModal('#settings-modal');
      checkReminders();
      alert('✅ 设置已保存');
    });
  }

  // ============================================================
  // 弹窗通用
  // ============================================================
  function bindModals() {
    document.querySelectorAll('[data-close]').forEach((b) => {
      b.addEventListener('click', () => b.closest('.modal').classList.add('hidden'));
    });
    document.querySelectorAll('.modal').forEach((m) => {
      m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
    });
  }
  function openModal(sel) { $(sel).classList.remove('hidden'); }
  function closeModal(sel) { $(sel).classList.add('hidden'); }

  // ============================================================
  // 工具
  // ============================================================
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }
})();
