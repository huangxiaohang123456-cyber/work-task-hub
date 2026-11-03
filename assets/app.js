/* ============================================================
 * 工作任务台 · 前端逻辑（团队共享版 · 零外部依赖）
 * 数据存于 Supabase（云端共享），任何人打开网址即可查看/添加/修改/完成任务。
 * 无登录、无浏览器端加密。第三方库一律不用：日期用原生 JS、图表用 CSS、导出用 CSV、
 * Supabase 用原生 fetch 直连 REST。这样彻底避免 CDN 被墙导致脚本加载失败、按钮无响应。
 * ============================================================ */
(function () {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const URL = cfg.SUPABASE_URL;
  const KEY = cfg.SUPABASE_ANON_KEY;
  const LS_PROFILE = 'wtb_profile_v1';

  const state = {
    profile: { name: '', pushplus_token: '', remind_lead_hours: 24 },
    tasks: [],
    filters: { view: 'all', priority: '', search: '' }
  };

  const $ = (s) => document.querySelector(s);
  const taskList = $('#task-list');
  const emptyHint = $('#empty-hint');
  const reminderBanner = $('#reminder-banner');

  // ---------- Supabase REST 直连（无需 supabase-js 库） ----------
  async function supa(method, path, body) {
    const headers = {
      'apikey': KEY,
      'Authorization': 'Bearer ' + KEY,
      'Accept': 'application/json'
    };
    const opt = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Prefer'] = 'return=representation';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(URL + '/rest/v1/' + path, opt);
    if (!res.ok) {
      let txt = '';
      try { txt = await res.text(); } catch (e) { /* ignore */ }
      throw new Error('HTTP ' + res.status + ' ' + (txt || res.statusText));
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : null;
  }

  // ---------- 本地存储（仅存个人设置） ----------
  function loadProfile() {
    try {
      const raw = localStorage.getItem(LS_PROFILE);
      if (raw) state.profile = Object.assign(state.profile, JSON.parse(raw));
    } catch (e) { /* 用默认 */ }
  }
  function saveProfile() {
    localStorage.setItem(LS_PROFILE, JSON.stringify(state.profile));
  }

  // ---------- 原生日期工具（替代 dayjs） ----------
  function fmt(iso, withTime) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    const day = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    return withTime === false ? day : day + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function startOfDay(d) { d = new Date(d); d.setHours(0, 0, 0, 0); return d; }
  function endOfDay(d) { d = new Date(d); d.setHours(23, 59, 59, 999); return d; }
  function startOfWeek(d) { d = startOfDay(d); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); return d; }
  function endOfWeek(d) { const s = startOfWeek(d); s.setDate(s.getDate() + 7); return s; }
  function startOfMonth(d) { d = startOfDay(d); d.setDate(1); return d; }
  function endOfMonth(d) { d = startOfDay(d); d.setMonth(d.getMonth() + 1, 1); return d; }
  function isBefore(a, b) { return new Date(a).getTime() < new Date(b).getTime(); }

  // ---------- 文本辅助 ----------
  function priText(p) { return { high: '高', medium: '中', low: '低' }[p] || p; }
  function recLabel(r) { return { none: '', daily: '🔁 每天', weekly: '🔁 每周', monthly: '🔁 每月' }[r] || ''; }
  function recText(r) { return { none: '一次性', daily: '每天', weekly: '每周', monthly: '每月' }[r] || ''; }
  function statusText(s) { return { todo: '待办', doing: '进行中', done: '已完成' }[s] || s; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ============================================================
  // 启动
  // ============================================================
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    loadProfile();
    bindTabs();
    bindToolbar();
    bindModals();
    bindTaskForm();
    bindSettingsForm();
    registerSW();

    $('#me-name').value = state.profile.name || '';
    $('#me-token').value = state.profile.pushplus_token || '';
    $('#me-lead').value = state.profile.remind_lead_hours || 24;
    $('#me-display').textContent = state.profile.name || '我';
    $('#rem-lead').textContent = state.profile.remind_lead_hours || 24;

    $('#fab').addEventListener('click', () => openTaskModal(null));
    await loadTasks();
  }

  // ============================================================
  // 数据加载
  // ============================================================
  async function loadTasks() {
    try {
      const data = await supa('GET', 'tasks?select=*&order=created_at.asc');
      state.tasks = data || [];
    } catch (e) {
      const m = e.message || '';
      if (/404|relation|does not exist|42P01/i.test(m)) {
        alert('⚠️ 还没建表：请到 Supabase 后台 SQL Editor 运行项目里的 supabase/schema.sql 一次（只需一次）。');
      } else {
        alert('加载任务失败：' + m);
      }
      state.tasks = [];
    }
    renderTasks(); renderStats(); renderRemind();
  }

  // ============================================================
  // 任务：渲染 + 视图/筛选 + 统计卡 + 提醒横幅
  // ============================================================
  function matchView(t) {
    const v = state.filters.view;
    const now = new Date();
    if (v === 'all') return true;
    if (v === 'overdue') return t.due_date && isBefore(t.due_date, now) && t.status !== 'done';
    if (v === 'none') return !t.due_date;
    if (!t.due_date) return false;
    const d = new Date(t.due_date);
    if (v === 'today') return d >= startOfDay(now) && d <= endOfDay(now);
    if (v === 'week') return d >= startOfWeek(now) && d < endOfWeek(now);
    if (v === 'month') return d >= startOfMonth(now) && d < endOfMonth(now);
    return true;
  }
  function matchOther(t) {
    const f = state.filters;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.search) {
      const q = f.search.toLowerCase();
      const hay = (t.title + ' ' + (t.tags || []).join(' ')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function renderTasks() {
    const list = state.tasks.filter((t) => matchView(t) && matchOther(t));
    taskList.innerHTML = '';
    emptyHint.classList.toggle('hidden', list.length > 0);

    list.forEach((t) => {
      const li = document.createElement('li');
      li.className = 'task-card';
      const dueCls = (() => {
        if (!t.due_date) return '';
        const d = new Date(t.due_date), now = new Date();
        if (t.status !== 'done' && isBefore(d, now)) return 'over';
        if (t.status !== 'done' && (d - now) <= 24 * 3600 * 1000) return 'soon';
        return '';
      })();
      li.innerHTML = `
        <div class="task-main">
          <div class="task-title"><span class="badge ${t.priority}">${priText(t.priority)}</span><span>${esc(t.title)}</span></div>
          ${t.description ? `<div class="task-desc">${esc(t.description)}</div>` : ''}
          <div class="task-meta">
            ${t.due_date ? `<span class="due ${dueCls}">⏰ ${fmt(t.due_date)}</span>` : ''}
            ${recLabel(t.recurrence)}
            ${(t.tags || []).map((x) => `<span class="tag">${esc(x)}</span>`).join('')}
            ${t.creator_name ? `<span>👤 ${esc(t.creator_name)}</span>` : ''}
          </div>
        </div>
        <div class="task-actions">
          <select class="status-select" data-id="${t.id}">
            <option value="todo" ${t.status === 'todo' ? 'selected' : ''}>待办</option>
            <option value="doing" ${t.status === 'doing' ? 'selected' : ''}>进行中</option>
            <option value="done" ${t.status === 'done' ? 'selected' : ''}>已完成</option>
          </select>
          <button class="icon-btn" data-edit="${t.id}" title="编辑">✏️</button>
          <button class="icon-btn" data-del="${t.id}" title="删除">🗑️</button>
        </div>`;
      taskList.appendChild(li);
    });

    bindTaskItemEvents();
    updateTaskStats();
    updateBanner();
  }

  function updateTaskStats() {
    const now = new Date();
    const c = { todo: 0, doing: 0, done: 0, over: 0 };
    state.tasks.forEach((t) => {
      if (t.status === 'todo') c.todo++;
      else if (t.status === 'doing') c.doing++;
      else if (t.status === 'done') c.done++;
      if (t.due_date && isBefore(t.due_date, now) && t.status !== 'done') c.over++;
    });
    $('#sc-todo').textContent = c.todo;
    $('#sc-doing').textContent = c.doing;
    $('#sc-done').textContent = c.done;
    $('#sc-over').textContent = c.over;
  }

  function updateBanner() {
    const now = new Date();
    const lead = state.profile.remind_lead_hours || 24;
    const soonCut = new Date(now.getTime() + lead * 3600 * 1000);
    let over = 0, soon = 0;
    state.tasks.forEach((t) => {
      if (!t.due_date || t.status === 'done') return;
      const d = new Date(t.due_date);
      if (isBefore(d, now)) over++;
      else if (d < soonCut) soon++;
    });
    if (!over && !soon) { reminderBanner.classList.add('hidden'); return; }
    reminderBanner.innerHTML = `🔔 <b>待办提醒</b>：${over ? over + ' 个已逾期 ' : ''}${soon ? soon + ' 个即将到期' : ''}。可在「提醒」页推送到微信。`;
    reminderBanner.classList.remove('hidden');
  }

  function bindTaskItemEvents() {
    taskList.querySelectorAll('.status-select').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const t = state.tasks.find((x) => x.id === sel.dataset.id);
        if (!t) return;
        const v = sel.value;
        t.status = v;
        t.completed_at = v === 'done' ? new Date().toISOString() : null;
        try {
          await supa('PATCH', 'tasks?id=eq.' + encodeURIComponent(t.id), { status: v, completed_at: t.completed_at });
        } catch (e) { alert('更新失败：' + (e.message || e)); }
        renderTasks(); renderStats(); renderRemind();
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
          await supa('DELETE', 'tasks?id=eq.' + encodeURIComponent(id));
          state.tasks = state.tasks.filter((t) => t.id !== id);
        } catch (e) { return alert('删除失败：' + (e.message || e)); }
        renderTasks(); renderStats(); renderRemind();
      });
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
      const title = $('#f-title').value.trim();
      const msg = $('#task-form-msg');
      if (!title) { msg.textContent = '请填写标题'; return; }
      const status = $('#f-status').value;
      const row = {
        title,
        description: $('#f-desc').value.trim(),
        priority: $('#f-priority').value,
        status,
        due_date: dueIso,
        recurrence: $('#f-recurrence').value,
        tags
      };
      if (status === 'done') row.completed_at = new Date().toISOString();
      try {
        if (id) {
          const t = state.tasks.find((x) => x.id === id);
          if (t) Object.assign(t, row);
          await supa('PATCH', 'tasks?id=eq.' + encodeURIComponent(id), row);
        } else {
          row.creator_name = state.profile.name || '匿名';
          row.created_at = new Date().toISOString();
          const data = await supa('POST', 'tasks', row);
          const created = Array.isArray(data) && data[0];
          state.tasks.push(created || Object.assign({ id: 'tmp_' + Date.now() }, row));
        }
      } catch (err) { msg.textContent = '保存失败：' + (err.message || err); return; }
      closeModal('#task-modal');
      renderTasks(); renderStats(); renderRemind();
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
  // 底部 Tab / 工具栏
  // ============================================================
  function bindTabs() {
    document.querySelectorAll('.tab').forEach((b) => {
      b.addEventListener('click', () => switchPage(b.dataset.page));
    });
  }
  function switchPage(page) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
    $('#fab').classList.toggle('hidden', page !== 'tasks');
  }

  function bindToolbar() {
    $('#view-seg').querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => {
        $('#view-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
        state.filters.view = b.dataset.view;
        renderTasks();
      });
    });
    $('#filter-priority').addEventListener('change', (e) => { state.filters.priority = e.target.value; renderTasks(); });
    $('#filter-search').addEventListener('input', (e) => { state.filters.search = e.target.value.trim(); renderTasks(); });
    $('#btn-export').addEventListener('click', exportCSV);
    $('#btn-push').addEventListener('click', pushWeChat);
  }

  // ============================================================
  // 统计页（CSS 图表，无 Chart.js）
  // ============================================================
  function renderStats() {
    const tasks = state.tasks;
    const total = tasks.length;
    const done = tasks.filter((t) => t.status === 'done').length;
    const doing = tasks.filter((t) => t.status === 'doing').length;
    const todo = tasks.filter((t) => t.status === 'todo').length;
    const over = tasks.filter((t) => t.due_date && isBefore(t.due_date, new Date()) && t.status !== 'done').length;
    const rate = total ? Math.round(done / total * 100) : 0;
    $('#st-total').textContent = total;
    $('#st-done').textContent = done;
    $('#st-rate').textContent = rate + '%';
    $('#st-over').textContent = over;

    const byPri = { high: 0, medium: 0, low: 0 };
    tasks.forEach((t) => byPri[t.priority] = (byPri[t.priority] || 0) + 1);
    $('#dist-priority').innerHTML = barRows([['高', byPri.high, 'var(--red)'], ['中', byPri.medium, 'var(--amber)'], ['低', byPri.low, 'var(--green)']]);
    $('#dist-status').innerHTML = barRows([['待办', todo, 'var(--primary)'], ['进行中', doing, 'var(--amber)'], ['已完成', done, 'var(--green)']]);

    renderTrend();
  }

  function barRows(arr) {
    const max = Math.max(1, ...arr.map((x) => x[1]));
    return arr.map(([lab, val, color]) =>
      `<div class="bar-row"><span class="bar-label">${lab}</span><span class="bar-track"><span class="bar-fill" style="width:${val / max * 100}%;background:${color}"></span></span><span class="bar-val">${val}</span></div>`
    ).join('');
  }

  function renderTrend() {
    const now = new Date();
    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const end = new Date(now); end.setDate(end.getDate() - i * 7);
      weeks.push({ ws: startOfWeek(end), we: endOfWeek(end), label: fmt(startOfWeek(end), false).slice(5) });
    }
    const counts = weeks.map((w) =>
      state.tasks.filter((t) => {
        if (!t.completed_at) return false;
        const c = new Date(t.completed_at);
        return c >= w.ws && c < w.we;
      }).length
    );
    const max = Math.max(1, ...counts);
    $('#trend').innerHTML = weeks.map((w, i) =>
      `<div class="col"><span class="col-num">${counts[i]}</span><span class="col-bar" style="height:${counts[i] / max * 100}%"></span><span class="col-lab">${w.label}</span></div>`
    ).join('');
  }

  // ============================================================
  // 提醒页
  // ============================================================
  function renderRemind() {
    const now = new Date();
    const lead = state.profile.remind_lead_hours || 24;
    const soonCut = new Date(now.getTime() + lead * 3600 * 1000);
    const over = [], soon = [];
    state.tasks.forEach((t) => {
      if (!t.due_date || t.status === 'done') return;
      const d = new Date(t.due_date);
      if (isBefore(d, now)) over.push(t);
      else if (d < soonCut) soon.push(t);
    });
    over.sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
    soon.sort((a, b) => new Date(a.due_date) - new Date(b.due_date));
    const box = $('#remind-list');
    box.innerHTML = '';
    if (!over.length && !soon.length) { box.innerHTML = '<p class="hint">暂无逾期或临近任务，继续保持 🎉</p>'; return; }
    [...over.map((t) => ['over', t]), ...soon.map((t) => ['soon', t])].forEach(([cls, t]) => {
      const div = document.createElement('div');
      div.className = 'remind-item ' + cls;
      div.innerHTML = `<span class="dot"></span><div class="ri-main"><div class="ri-title">${esc(t.title)}</div><div class="ri-sub">${cls === 'over' ? '已逾期' : '即将到期'} · 截止 ${fmt(t.due_date)} · ${priText(t.priority)}</div></div>`;
      box.appendChild(div);
    });
    $('#rem-lead').textContent = lead;
  }

  async function pushWeChat() {
    const token = state.profile.pushplus_token;
    if (!token) { alert('请先在「我的」中填写 PushPlus 令牌。'); switchPage('me'); return; }
    const now = new Date();
    const lead = state.profile.remind_lead_hours || 24;
    const soonCut = new Date(now.getTime() + lead * 3600 * 1000);
    const over = [], soon = [];
    state.tasks.forEach((t) => {
      if (!t.due_date || t.status === 'done') return;
      const d = new Date(t.due_date);
      if (isBefore(d, now)) over.push(t);
      else if (d < soonCut) soon.push(t);
    });
    if (!over.length && !soon.length) { alert('当前没有临期或逾期任务，无需推送。'); return; }
    const lines = [...over, ...soon].map((t) => {
      const tag = over.includes(t) ? '【逾期】' : '【临近】';
      return `<p>${tag} <b>${esc(t.title)}</b> 截止 ${fmt(t.due_date)} · ${priText(t.priority)} · ${esc(t.creator_name || '')}</p>`;
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
    } catch (e) { alert('推送请求出错：' + e.message); }
  }

  // ============================================================
  // 导出 CSV（Excel 可直接打开，无需 XLSX 库）
  // ============================================================
  function exportCSV() {
    const head = ['标题', '描述', '优先级', '标签', '截止日期', '周期', '状态', '添加人', '创建时间', '完成时间'];
    const rows = [head];
    state.tasks.forEach((t) => rows.push([
      t.title, t.description || '', priText(t.priority), (t.tags || []).join(','),
      fmt(t.due_date), recText(t.recurrence), statusText(t.status), t.creator_name || '',
      fmt(t.created_at), fmt(t.completed_at)
    ]));
    const csv = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url; a.download = '工作任务台_' + fmt(new Date(), false) + '.csv';
    a.click(); URL.revokeObjectURL(url);
  }
  function csvCell(v) {
    v = String(v == null ? '' : v);
    if (/[",\r\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
    return v;
  }

  // ============================================================
  // 我的（设置）
  // ============================================================
  function bindSettingsForm() {
    $('#btn-save-me').addEventListener('click', () => {
      state.profile.name = $('#me-name').value.trim();
      state.profile.pushplus_token = $('#me-token').value.trim();
      state.profile.remind_lead_hours = parseInt($('#me-lead').value, 10) || 24;
      saveProfile();
      $('#me-display').textContent = state.profile.name || '我';
      $('#rem-lead').textContent = state.profile.remind_lead_hours;
      alert('✅ 已保存');
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

  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }
})();
