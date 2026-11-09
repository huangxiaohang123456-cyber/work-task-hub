/* ============================================================
 * 工作任务台 · 前端逻辑（登录隔离版 · 零外部依赖）
 * 数据存于 Supabase，每用户数据隔离（RLS）。
 * 登录用 Supabase 自带邮箱/密码 Auth；任务读写用 REST，请求带用户 JWT。
 * 无第三方库：日期原生 JS、图表 CSS、导出 CSV、Auth/REST 均用原生 fetch。
 * ============================================================ */
(function () {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const SB_URL = cfg.SUPABASE_URL;
  const KEY = cfg.SUPABASE_ANON_KEY;
  const LS_PROFILE = 'wtb_profile_v1';
  const LS_SESSION = 'wtb_session_v1';

  // ---------- 致命错误兜底：任何 JS 报错都显示在屏幕上，避免默默白屏 ----------
  function showFatal(msg) {
    let el = document.getElementById('fatal-error');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fatal-error';
      el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:9999;background:#b00020;color:#fff;padding:12px 14px;font-size:13px;line-height:1.5;white-space:pre-wrap;';
      document.body.appendChild(el);
    }
    el.textContent = '⚠️ 页面出错了（请截图发给开发者）：\n' + msg;
  }
  window.addEventListener('error', (e) => showFatal((e.error && e.error.stack) || e.message || String(e)));
  window.addEventListener('unhandledrejection', (e) => showFatal('Promise 未处理：' + ((e.reason && (e.reason.stack || e.reason.message)) || e.reason)));

  const state = {
    profile: { name: '' },
    session: null,
    tasks: [],
    filters: { view: 'all', priority: '', search: '' }
  };

  const $ = (s) => document.querySelector(s);
  const taskList = $('#task-list');
  const emptyHint = $('#empty-hint');

  // ---------- 带重试的 fetch（仅网络层失败时重试，业务 4xx/5xx 不重试） ----------
  async function netFetch(url, opt, retries) {
    retries = (retries == null) ? 3 : retries;
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try {
        return await fetch(url, opt);
      } catch (e) {
        lastErr = e;
        if (i < retries) await new Promise((r) => setTimeout(r, 800 * Math.pow(2, i))); // 800/1600/3200ms 退避
      }
    }
    throw lastErr || new Error('network error');
  }

  // ---------- Supabase REST（数据，需登录：请求带用户 JWT） ----------
  async function supa(method, path, body) {
    const token = state.session ? state.session.access_token : KEY;
    const headers = {
      'apikey': KEY,
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json'
    };
    const opt = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Prefer'] = 'return=representation';
      opt.body = JSON.stringify(body);
    }
    const res = await netFetch(SB_URL + '/rest/v1/' + path, opt);
    if (res.status === 401) { clearSession(); showAuth(); throw new Error('AUTH_EXPIRED'); }
    if (!res.ok) {
      let txt = '';
      try { txt = await res.text(); } catch (e) { /* ignore */ }
      throw new Error('HTTP ' + res.status + ' ' + (txt || res.statusText));
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : null;
  }

  // ---------- Supabase Auth（登录，不需要用户 JWT） ----------
  async function authReq(method, path, body) {
    const headers = { 'apikey': KEY, 'Accept': 'application/json' };
    const opt = { method, headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await netFetch(SB_URL + path, opt);
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) {
      const msg = (data && (data.message || data.error_description || (data.error && data.error.message))) || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return data;
  }

  function normalizeSession(resp, userObj) {
    const u = userObj || resp.user || {};
    return {
      access_token: resp.access_token,
      refresh_token: resp.refresh_token,
      expires_in: resp.expires_in || 3600,
      user: { id: u.id, email: u.email }
    };
  }

  async function doSignUp(email, password) {
    const resp = await authReq('POST', '/auth/v1/signup', { email, password });
    if (resp.data && resp.data.session) return normalizeSession(resp.data.session, resp.data.user);
    if (resp.data && resp.data.user && !resp.data.session)
      throw new Error('注册成功，但需先去邮箱确认（请在后台关闭 Confirm email 后重试）');
    return normalizeSession(resp, resp.user);
  }

  async function doSignIn(email, password) {
    const resp = await authReq('POST', '/auth/v1/token?grant_type=password', { email, password });
    return normalizeSession(resp, resp.user);
  }

  async function refreshSession(refresh_token) {
    const resp = await authReq('POST', '/auth/v1/token?grant_type=refresh_token', { refresh_token });
    return normalizeSession(resp, resp.user);
  }

  async function doSignOut() {
    try {
      await fetch(SB_URL + '/auth/v1/logout', {
        method: 'POST',
        headers: { 'apikey': KEY, 'Authorization': 'Bearer ' + (state.session ? state.session.access_token : '') }
      });
    } catch (e) { /* ignore */ }
  }

  // ---------- 会话存储 ----------
  function saveSession(s) { state.session = s; try { localStorage.setItem(LS_SESSION, JSON.stringify(s)); } catch (e) { /* ignore */ } }
  function loadSession() { try { const r = localStorage.getItem(LS_SESSION); if (r) state.session = JSON.parse(r); } catch (e) { /* ignore */ } }
  function clearSession() { state.session = null; try { localStorage.removeItem(LS_SESSION); } catch (e) { /* ignore */ } }

  // ---------- 任务本地缓存（离线兜底，按用户隔离） ----------
  function cacheKey() {
    const id = state.session && state.session.user ? state.session.user.id : null;
    return id ? 'wtb_tasks_cache_' + id : null;
  }
  function saveTasksCache() {
    const k = cacheKey(); if (!k) return;
    try { localStorage.setItem(k, JSON.stringify(state.tasks)); } catch (e) { /* ignore */ }
  }
  function loadTasksCache() {
    const k = cacheKey(); if (!k) return null;
    try { const r = localStorage.getItem(k); return r ? JSON.parse(r) : null; } catch (e) { return null; }
  }
  function clearTasksCache() {
    const k = cacheKey(); if (k) { try { localStorage.removeItem(k); } catch (e) {} }
  }

  function showAuth() { $('#auth-view').classList.remove('hidden'); $('#app').classList.add('hidden'); }
  function showApp() { $('#auth-view').classList.add('hidden'); $('#app').classList.remove('hidden'); applyUserLabels(); }

  function applyUserLabels() {
    const email = state.session && state.session.user ? state.session.user.email : '';
    if ($('#me-email')) $('#me-email').textContent = email;
    $('#me-display').textContent = state.profile.name || email || '我';
  }

  async function boot() {
    loadSession();
    if (state.session && state.session.refresh_token) {
      try { saveSession(await refreshSession(state.session.refresh_token)); }
      catch (e) { /* 刷新失败则用原 token 试一次 */ }
    }
    if (state.session && state.session.access_token) { showApp(); await loadTasks(); }
    else { showAuth(); }
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
  function statusText(s) { return { todo: '待办', doing: '进行中', done: '已完成' }[s] || s; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ============================================================
  // 启动
  // ============================================================
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    try {
      loadProfile();
      bindTabs();
      bindToolbar();
      bindModals();
      bindTaskForm();
      bindSettingsForm();
      bindAuth();
      registerSW();

      $('#me-display').textContent = state.profile.name || '我';

      const rb = $('#btn-retry');
      if (rb) rb.addEventListener('click', () => { hideOfflineBanner(); loadTasks(); });
      $('#fab').addEventListener('click', () => openTaskModal(null));
      await boot();
    } catch (e) {
      showFatal((e && (e.stack || e.message)) || String(e));
    }
  }

  // ============================================================
  // 数据加载
  // ============================================================
  async function loadTasks() {
    try {
      const data = await supa('GET', 'tasks?select=*&order=created_at.asc');
      state.tasks = data || [];
      saveTasksCache();
      hideOfflineBanner();
    } catch (e) {
      const m = e.message || '';
      if (/AUTH_EXPIRED|401/.test(m)) return; // supa 已切到登录页
      const cached = loadTasksCache();
      if (cached && cached.length) {
        state.tasks = cached;
        showOfflineBanner('⚠️ 网络不太稳定，当前显示的是上次缓存的任务（可能不是最新），点“重试”可再次尝试连接。');
      } else if (/404|relation|does not exist|42P01/i.test(m)) {
        showOfflineBanner('⚠️ 还没建表：请到 Supabase 后台 SQL Editor 运行项目里的 supabase/schema.sql 一次（只需一次）。');
        state.tasks = [];
      } else {
        showOfflineBanner('⚠️ 加载失败（网络问题）：' + m + '，点“重试”再试一次。');
        state.tasks = [];
      }
    }
    renderTasks(); renderStats();
  }

  function showOfflineBanner(text) {
    const b = $('#offline-banner');
    if (!b) return;
    $('#offline-text').textContent = text;
    b.classList.remove('hidden');
  }
  function hideOfflineBanner() {
    const b = $('#offline-banner');
    if (b) b.classList.add('hidden');
  }

  // ============================================================
  // 任务：渲染 + 视图/筛选 + 统计卡 + 提醒横幅
  // ============================================================
  function matchView(t) {
    const v = state.filters.view;
    const now = new Date();
    if (v === 'all') return true;
    if (v === 'overdue') return t.due_date && isBefore(t.due_date, now) && t.status !== 'done';
    if (!t.due_date) return false;
    const d = new Date(t.due_date);
    if (v === 'today') return d >= startOfDay(now) && d <= endOfDay(now);
    if (v === 'week') return d >= startOfWeek(now) && d < endOfWeek(now);
    if (v === 'month') return d >= startOfMonth(now) && d < endOfMonth(now);
    if (v === 'future') return d > new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
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
    const active = list.filter((t) => t.status !== 'done');
    const done = list.filter((t) => t.status === 'done');
    active.forEach((t) => taskList.appendChild(makeCard(t, false)));
    if (done.length) {
      const grp = document.createElement('li');
      grp.className = 'done-group';
      grp.innerHTML = `<button class="done-toggle" type="button"><span class="done-toggle-title">已完成任务 (${done.length})</span><span class="chev">▾</span></button><ul class="done-body"></ul>`;
      const body = grp.querySelector('.done-body');
      done.forEach((t) => body.appendChild(makeCard(t, true)));
      taskList.appendChild(grp);
      grp.querySelector('.done-toggle').addEventListener('click', () => grp.classList.toggle('collapsed'));
    }
    bindTaskItemEvents();
    updateTaskStats();
  }

  function makeCard(t, isDone) {
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
          ${t.owner_name ? `<span class="owner">👤 ${esc(t.owner_name)}</span>` : ''}
        </div>
      </div>
      <div class="task-actions">
        <select class="status-select" data-id="${t.id}" ${isDone ? 'disabled' : ''}>
          <option value="todo" ${t.status === 'todo' ? 'selected' : ''}>待办</option>
          <option value="doing" ${t.status === 'doing' ? 'selected' : ''}>进行中</option>
          <option value="done" ${t.status === 'done' ? 'selected' : ''}>已完成</option>
        </select>
        <button class="icon-btn" data-edit="${t.id}">编辑</button>
        <button class="icon-btn danger" data-del="${t.id}">删除</button>
      </div>`;
    return li;
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
        renderTasks(); renderStats();
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
        renderTasks(); renderStats();
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
      const owner = $('#f-owner').value.trim();
      const title = $('#f-title').value.trim();
      const msg = $('#task-form-msg');
      if (!title) { msg.textContent = '请填写标题'; return; }
      if (!dueIso) { msg.textContent = '请填写截止日期'; return; }
      if (!owner) { msg.textContent = '请填写负责人'; return; }
      const status = $('#f-status').value;
      const oldT = id ? state.tasks.find((x) => x.id === id) : null;
      const row = {
        title,
        description: $('#f-desc').value.trim(),
        priority: $('#f-priority').value,
        status,
        due_date: dueIso,
        owner_name: owner
      };
      const wasDone = oldT && oldT.status === 'done';
      if (status === 'done' && !wasDone) row.completed_at = new Date().toISOString();
      else if (status !== 'done') row.completed_at = null;
      try {
        if (id) {
          const t = state.tasks.find((x) => x.id === id);
          if (t) Object.assign(t, row);
          await supa('PATCH', 'tasks?id=eq.' + encodeURIComponent(id), row);
        } else {
          row.created_at = new Date().toISOString();
          row.user_id = state.session ? state.session.user.id : null;
          const data = await supa('POST', 'tasks', row);
          const created = Array.isArray(data) && data[0];
          state.tasks.push(created || Object.assign({ id: 'tmp_' + Date.now() }, row));
        }
      } catch (err) { msg.textContent = '保存失败：' + (err.message || err); return; }
      closeModal('#task-modal');
      renderTasks(); renderStats();
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
      $('#f-status').disabled = (t.status === 'done');
      $('#f-due').value = t.due_date ? toLocalInput(t.due_date) : '';
      $('#f-owner').value = t.owner_name || '';
    } else {
      $('#task-modal-title').textContent = '添加任务';
      $('#task-form').reset();
      $('#task-id').value = '';
      $('#f-priority').value = 'medium';
      $('#f-status').value = 'todo';
      $('#f-status').disabled = false;
      $('#f-owner').value = '';
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
  // 导出：点击「导出 Excel」直接下载真正的 .xlsx 文件（OOXML 格式，
  // 零依赖原生生成）。手机端 WPS / Excel 可直接识别打开，不会报"实际为 xml"的格式错误。
  // ============================================================
  const EXPORT_HEAD = ['标题', '描述', '优先级', '截止时间', '负责人', '完成情况', '创建时间', '完成时间'];
  // 各列宽度（点数），导出为 .xlsx 时按 点数/7 换算为列宽单位。
  const EXPORT_COL_W = [180, 260, 70, 130, 130, 90, 130, 130];

  // —— 真正的 .xlsx 生成（零依赖，store 模式 zip + OOXML）——
  function colLetter(n) {
    let s = '';
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }
  function concatBytes(arrs) {
    let len = 0; arrs.forEach((a) => { len += a.length; });
    const out = new Uint8Array(len); let p = 0;
    arrs.forEach((a) => { out.set(a, p); p += a.length; });
    return out;
  }
  function makeZip(files) {
    const enc = new TextEncoder();
    const crcTable = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) { c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); } t[n] = c >>> 0; }
      return t;
    })();
    const crc32 = (buf) => {
      let c = 0xFFFFFFFF;
      for (let i = 0; i < buf.length; i++) { c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); }
      return (c ^ 0xFFFFFFFF) >>> 0;
    };
    const parts = []; const central = []; let offset = 0;
    files.forEach((f) => {
      const nameBytes = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0x21, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      parts.push(local, data);
      const cen = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(cen.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(4, 20, true);
      cdv.setUint16(6, 20, true);
      cdv.setUint16(8, 0x0800, true);
      cdv.setUint16(10, 0, true);
      cdv.setUint16(12, 0, true);
      cdv.setUint16(14, 0x21, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, data.length, true);
      cdv.setUint32(24, data.length, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint16(30, 0, true);
      cdv.setUint16(32, 0, true);
      cdv.setUint16(34, 0, true);
      cdv.setUint16(36, 0, true);
      cdv.setUint32(38, 0, true);
      cdv.setUint32(42, offset, true);
      cen.set(nameBytes, 46);
      central.push(cen);
      offset += local.length + data.length;
    });
    const centralBuf = concatBytes(central);
    const end = new Uint8Array(22);
    const edv = new DataView(end.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(4, 0, true);
    edv.setUint16(6, 0, true);
    edv.setUint16(8, central.length, true);
    edv.setUint16(10, central.length, true);
    edv.setUint32(12, centralBuf.length, true);
    edv.setUint32(16, offset, true);
    edv.setUint16(20, 0, true);
    return concatBytes(parts.concat([centralBuf, end]));
  }
  function buildXlsx(head, rows, colW, sheetName) {
    const enc = new TextEncoder();
    const xesc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    let cols = '<cols>';
    colW.forEach((w, i) => { const c = i + 1; cols += '<col min="' + c + '" max="' + c + '" width="' + (w / 7).toFixed(1) + '" customWidth="1"/>'; });
    cols += '</cols>';
    let sheetData = '<sheetData>';
    const writeRow = (rn, cells) => {
      let r = '<row r="' + rn + '">';
      cells.forEach((val, ci) => {
        const ref = colLetter(ci + 1) + rn;
        r += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xesc(val == null ? '' : val) + '</t></is></c>';
      });
      r += '</row>';
      return r;
    };
    sheetData += writeRow(1, head);
    rows.forEach((r, i) => { sheetData += writeRow(i + 2, r.map((c) => (c == null ? '' : c))); });
    sheetData += '</sheetData>';
    const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + cols + sheetData + '</worksheet>';
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>'
      + '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
      + '<borders count="1"><border/></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
      + '</styleSheet>';
    const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="' + xesc(sheetName) + '" sheetId="1" r:id="rId1"/></sheets></workbook>';
    const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>';
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>';
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>';
    const files = [
      { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
      { name: '_rels/.rels', data: enc.encode(rootRels) },
      { name: 'xl/workbook.xml', data: enc.encode(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels) },
      { name: 'xl/styles.xml', data: enc.encode(styles) },
      { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheet) }
    ];
    return makeZip(files);
  }

  function buildExportRows() {
    return state.tasks.map((t) => ([
      t.title, t.description || '', priText(t.priority),
      fmt(t.due_date), t.owner_name || '', statusText(t.status),
      fmt(t.created_at), fmt(t.completed_at)
    ]));
  }

  function downloadExport() {
    const rows = buildExportRows();
    const bytes = buildXlsx(EXPORT_HEAD, rows, EXPORT_COL_W, '工作任务台');
    const filename = '工作任务台_' + fmt(new Date(), false) + '.xlsx';
    if (window.URL && typeof URL.createObjectURL === 'function') {
      try {
        const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = URL.createObjectURL(blob);
        triggerDownload(url, filename);
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        return;
      } catch (e) { /* 退回提示 */ }
    }
    alert('当前环境不支持直接下载，请在手机自带浏览器（Safari / Chrome）中打开本页面后再导出。');
  }

  function triggerDownload(href, filename) {
    const a = document.createElement('a');
    a.href = href; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ============================================================
  // 我的（设置）
  // ============================================================
  function bindSettingsForm() {
    $('#btn-export').addEventListener('click', () => {
      if (!state.tasks.length) { alert('当前没有任务可导出'); return; }
      downloadExport();
    });
  }

  // ============================================================
  // 登录 / 注册
  // ============================================================
  let authMode = 'login';
  function bindAuth() {
    $('#tab-login').addEventListener('click', () => setAuthMode('login'));
    $('#tab-register').addEventListener('click', () => setAuthMode('register'));
    $('#auth-form').addEventListener('submit', onAuthSubmit);
    $('#btn-logout').addEventListener('click', logout);
  }
  function setAuthMode(m) {
    authMode = m;
    $('#tab-login').classList.toggle('active', m === 'login');
    $('#tab-register').classList.toggle('active', m === 'register');
    $('#auth-submit').textContent = m === 'login' ? '登录' : '注册';
    $('#auth-msg').textContent = '';
  }
  async function onAuthSubmit(e) {
    e.preventDefault();
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const msg = $('#auth-msg');
    msg.textContent = '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.textContent = '请输入有效的邮箱'; return; }
    if (!/@qq\.com$/i.test(email)) { msg.textContent = '请使用 QQ 邮箱注册 / 登录'; return; }
    if (password.length < 6) { msg.textContent = '密码至少 6 位'; return; }
    $('#auth-submit').disabled = true;
    try {
      const s = authMode === 'login' ? await doSignIn(email, password) : await doSignUp(email, password);
      saveSession(s);
      showApp();
      await loadTasks();
    } catch (err) {
      msg.textContent = err.message || String(err);
    } finally {
      $('#auth-submit').disabled = false;
    }
  }
  async function logout() {
    await doSignOut();
    clearSession();
    clearTasksCache();
    state.tasks = [];
    showAuth();
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
