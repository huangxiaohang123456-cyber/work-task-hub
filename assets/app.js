/* ============================================================
 * 工作任务台 · 前端逻辑（原生 JS + Supabase）
 * 依赖（已在 index.html 以 UMD 引入）：supabase、dayjs、Sortable、XLSX、Chart
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 初始化 Supabase ----------
  const cfg = window.APP_CONFIG || {};
  const URL = cfg.SUPABASE_URL;
  const KEY = cfg.SUPABASE_ANON_KEY;
  let client = null;
  if (URL && URL.indexOf('YOUR_') !== 0 && KEY && KEY.indexOf('YOUR_') !== 0) {
    client = supabase.createClient(URL, KEY);
  }

  // ---------- 全局状态 ----------
  const state = {
    user: null,
    profile: null,
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

  function init() {
    if (!client) {
      authMsg.textContent = '⚠️ 尚未配置 Supabase。请让管理员在 assets/config.js 填入项目 URL 与 anon key。';
      authSubmit.disabled = true;
      return;
    }
    bindAuth();
    bindToolbar();
    bindModals();
    bindTaskForm();
    bindSettingsForm();
    registerSW();

    client.auth.getSession().then(({ data }) => {
      if (data.session) onLogin(data.session);
      else showAuth();
    });
    client.auth.onAuthStateChange((_e, session) => {
      if (session) onLogin(session);
      else showAuth();
    });
  }

  // ============================================================
  // 认证
  // ============================================================
  function bindAuth() {
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        const tab = t.dataset.tab;
        authSubmit.textContent = tab === 'login' ? '登录' : '注册';
        authMsg.textContent = '';
      });
    });

    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = $('#auth-email').value.trim();
      const password = $('#auth-password').value;
      const isLogin = authSubmit.textContent.trim() === '登录';
      authSubmit.disabled = true;
      authMsg.textContent = '处理中…';
      try {
        if (isLogin) {
          const { error } = await client.auth.signInWithPassword({ email, password });
          if (error) throw error;
        } else {
          const { error } = await client.auth.signUp({ email, password });
          if (error) throw error;
          authMsg.textContent = '注册成功！若管理员开启了邮箱确认，请先查收验证邮件；否则直接登录。';
        }
      } catch (err) {
        authMsg.textContent = '❌ ' + (err.message || err);
      } finally {
        authSubmit.disabled = false;
      }
    });
  }

  async function onLogin(session) {
    state.user = session.user;
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
    const name = (state.profile && state.profile.name) || state.user.email;
    $('#user-name').textContent = name;
  }

  async function logout() {
    await client.auth.signOut();
    state.user = null; state.profile = null; state.tasks = [];
    showAuth();
  }

  // ============================================================
  // 资料（显示名 / 微信令牌 / 提前量）
  // ============================================================
  async function loadProfile() {
    const { data, error } = await client
      .from('profiles').select('*').eq('id', state.user.id).single();
    if (error && error.code !== 'PGRST116') console.warn(error);
    state.profile = data || { id: state.user.id, name: '', pushplus_token: '', remind_lead_hours: 24 };
  }

  // ============================================================
  // 任务：加载 / 渲染 / 筛选
  // ============================================================
  async function loadTasks() {
    const { data, error } = await client
      .from('tasks').select('*').order('sort_order', { ascending: true });
    if (error) { alert('加载任务失败：' + error.message); return; }
    state.tasks = data || [];
    renderTasks();
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
        await updateTask(id, { status: sel.value });
      });
    });
    taskList.querySelectorAll('[data-edit]').forEach((b) => {
      b.addEventListener('click', () => openTaskModal(b.dataset.edit));
    });
    taskList.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!confirm('确定删除该任务？')) return;
        const { error } = await client.from('tasks').delete().eq('id', b.dataset.del);
        if (error) return alert('删除失败：' + error.message);
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
        // 给当前可见列表按顺序编号；隐藏任务保持原 sort_order
        const visibleSet = new Set(ids);
        let i = 0;
        for (const id of ids) {
          await client.from('tasks').update({ sort_order: i++ }).eq('id', id);
        }
        // 同步本地顺序
        state.tasks.sort((a, b) => {
          const ia = ids.indexOf(a.id), ib = ids.indexOf(b.id);
          if (ia === -1 && ib === -1) return a.sort_order - b.sort_order;
          if (ia === -1) return 1; if (ib === -1) return -1;
          return ia - ib;
        });
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
      const payload = {
        title: $('#f-title').value.trim(),
        description: $('#f-desc').value.trim(),
        priority: $('#f-priority').value,
        status: $('#f-status').value,
        due_date: $('#f-due').value ? new Date($('#f-due').value).toISOString() : null,
        recurrence: $('#f-recurrence').value,
        tags: $('#f-tags').value.split(',').map((s) => s.trim()).filter(Boolean)
      };
      const msg = $('#task-form-msg');
      if (!payload.title) { msg.textContent = '请填写标题'; return; }

      let error;
      if (id) {
        ({ error } = await client.from('tasks').update(payload).eq('id', id));
      } else {
        payload.creator_id = state.user.id;
        payload.creator_name = (state.profile && state.profile.name) || state.user.email;
        payload.sort_order = state.tasks.length;
        ({ error } = await client.from('tasks').insert(payload));
      }
      if (error) { msg.textContent = '❌ ' + error.message; return; }
      closeModal('#task-modal');
      await loadTasks(); checkReminders();
    });
  }

  async function updateTask(id, patch) {
    const { error } = await client.from('tasks').update(patch).eq('id', id);
    if (error) return alert('更新失败：' + error.message);
    await loadTasks(); checkReminders();
  }

  function openTaskModal(id) {
    const msg = $('#task-form-msg'); msg.textContent = '';
    if (id) {
      const t = state.tasks.find((x) => x.id === id);
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
  // 设置
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
        pushplus_token: $('#s-token').value.trim(),
        remind_lead_hours: parseInt($('#s-lead').value, 10) || 24
      };
      const { error } = await client.from('profiles').upsert({ id: state.user.id, ...patch });
      if (error) return alert('保存失败：' + error.message);
      state.profile = { ...state.profile, ...patch };
      $('#user-name').textContent = patch.name || state.user.email;
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
