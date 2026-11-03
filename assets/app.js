/* ============================================================
 * 工作任务台 · 前端逻辑（本地版）
 * 数据保存在本机浏览器 localStorage，无需数据库、无需登录、无需加密，打开即用。
 * 功能：任务增删改、拖拽排序、筛选/搜索、完成统计(Chart.js)、导出 Excel、临期微信提醒(PushPlus)。
 * 后续接入「团队共享 + 云端同步」时，只需把本文件的存储层换成 Supabase，其余 UI 不变。
 * ============================================================ */
(function () {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const LS_TASKS = 'wtb_tasks_v1';
  const LS_PROFILE = 'wtb_profile_v1';

  // ---------- 全局状态 ----------
  const state = {
    profile: { name: '', pushplus_token: '', remind_lead_hours: 24 },
    tasks: [],
    filters: { status: '', priority: '', recurrence: '', search: '' },
    chart: null
  };

  // ---------- DOM 引用 ----------
  const $ = (s) => document.querySelector(s);
  const taskList = $('#task-list');
  const emptyHint = $('#empty-hint');
  const reminderBanner = $('#reminder-banner');

  // ---------- 本地存储 ----------
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function loadTasks() {
    try {
      const raw = localStorage.getItem(LS_TASKS);
      state.tasks = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(state.tasks)) state.tasks = [];
    } catch (e) { state.tasks = []; }
  }
  function saveTasks() {
    localStorage.setItem(LS_TASKS, JSON.stringify(state.tasks));
  }
  function loadProfile() {
    try {
      const raw = localStorage.getItem(LS_PROFILE);
      if (raw) state.profile = Object.assign(state.profile, JSON.parse(raw));
    } catch (e) { /* 用默认 */ }
  }
  function saveProfile() {
    localStorage.setItem(LS_PROFILE, JSON.stringify(state.profile));
  }

  // ============================================================
  // 启动
  // ============================================================
  document.addEventListener('DOMContentLoaded', init);

  function init() {
    loadProfile();
    loadTasks();
    bindToolbar();
    bindModals();
    bindTaskForm();
    bindSettingsForm();
    registerSW();
    $('#user-name').textContent = state.profile.name || '我';
    renderTasks();
    checkReminders();
  }

  // ============================================================
  // 任务：渲染 / 筛选 / 状态切换 / 删除 / 拖拽
  // ============================================================
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
    const list = applyFilters()
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
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
            <span>👤 ${esc(t.creator_name || '我')}</span>
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

  function bindTaskItemEvents() {
    taskList.querySelectorAll('.status-select').forEach((sel) => {
      sel.addEventListener('change', () => {
        const t = state.tasks.find((x) => x.id === sel.dataset.id);
        if (t) { t.status = sel.value; saveTasks(); }
        renderTasks(); checkReminders();
      });
    });
    taskList.querySelectorAll('[data-edit]').forEach((b) => {
      b.addEventListener('click', () => openTaskModal(b.dataset.edit));
    });
    taskList.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', () => {
        if (!confirm('确定删除该任务？')) return;
        state.tasks = state.tasks.filter((x) => x.id !== b.dataset.del);
        saveTasks();
        renderTasks(); checkReminders();
      });
    });
  }

  let sortable = null;
  function enableDrag() {
    if (sortable) sortable.destroy();
    sortable = Sortable.create(taskList, {
      handle: '.task-drag',
      animation: 150,
      onEnd: () => {
        const ids = [...taskList.querySelectorAll('.task-card')].map((li) => li.dataset.id);
        const map = Object.fromEntries(state.tasks.map((t) => [t.id, t]));
        const ordered = ids.map((id) => map[id]).filter(Boolean);
        const rest = state.tasks.filter((t) => !ids.includes(t.id));
        ordered.forEach((t, i) => { t.sort_order = i; });
        state.tasks = ordered.concat(rest);
        saveTasks();
        renderTasks();
      }
    });
  }

  // ============================================================
  // 添加 / 编辑 任务
  // ============================================================
  function bindTaskForm() {
    $('#task-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = $('#task-id').value;
      const dueVal = $('#f-due').value;
      const dueIso = dueVal ? new Date(dueVal).toISOString() : null;
      const tags = $('#f-tags').value.split(',').map((s) => s.trim()).filter(Boolean);
      const title = $('#f-title').value.trim();
      const msg = $('#task-form-msg');
      if (!title) { msg.textContent = '请填写标题'; return; }

      const row = {
        title,
        description: $('#f-desc').value.trim(),
        priority: $('#f-priority').value,
        status: $('#f-status').value,
        due_date: dueIso,
        recurrence: $('#f-recurrence').value,
        tags
      };

      if (id) {
        const t = state.tasks.find((x) => x.id === id);
        if (t) Object.assign(t, row);
      } else {
        const maxOrder = state.tasks.reduce((m, t) => Math.max(m, t.sort_order || 0), -1);
        state.tasks.push({
          id: uid(),
          ...row,
          sort_order: maxOrder + 1,
          creator_name: state.profile.name || '我',
          created_at: new Date().toISOString()
        });
      }
      saveTasks();
      closeModal('#task-modal');
      renderTasks(); checkReminders();
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
          backgroundColor: ['#dc2626', '#d97706', '#16a34a', '#94a3b8', '#1e7a4e', '#16a34a']
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
      '添加人': t.creator_name || '我',
      '创建时间': dayjs(t.created_at).format('YYYY-MM-DD HH:mm')
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '工作任务');
    XLSX.writeFile(wb, '工作任务台_' + dayjs().format('YYYYMMDD') + '.xlsx');
  }

  function getDueTasks() {
    const lead = state.profile.remind_lead_hours || 24;
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
    const token = state.profile.pushplus_token;
    if (!token) { alert('请先在“我的”中填写 PushPlus 令牌。'); openSettings(); return; }
    const { overdue, soon } = getDueTasks();
    if (!overdue.length && !soon.length) { alert('当前没有临期或逾期任务，无需推送。'); return; }
    const lines = [...overdue, ...soon].map((t) => {
      const d = dayjs(t.due_date).format('MM-DD HH:mm');
      const tag = overdue.includes(t) ? '【逾期】' : '【临近】';
      return `<p>${tag} <b>${esc(t.title)}</b> 截止 ${d} · ${priText(t.priority)} · ${esc(t.creator_name || '我')}</p>`;
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
  // 我的设置（显示名 + 微信令牌 + 提前量，均存本机）
  // ============================================================
  function openSettings() {
    $('#s-name').value = state.profile.name || '';
    $('#s-token').value = state.profile.pushplus_token || '';
    $('#s-lead').value = state.profile.remind_lead_hours || 24;
    $('#cp-msg').textContent = '';
    openModal('#settings-modal');
  }

  function bindSettingsForm() {
    $('#settings-form').addEventListener('submit', (e) => {
      e.preventDefault();
      state.profile.name = $('#s-name').value.trim();
      state.profile.pushplus_token = $('#s-token').value.trim();
      state.profile.remind_lead_hours = parseInt($('#s-lead').value, 10) || 24;
      saveProfile();
      $('#user-name').textContent = state.profile.name || '我';
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
