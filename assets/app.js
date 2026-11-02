/* ============================================================
 * 工作任务台 · 前端逻辑（原生 JS + Supabase 免费版）
 * 登录体系：管理员导入「人事编码 + 姓名」，成员用 人事编码 + 姓名 + 初始密码(123456) 登录。
 * 数据安全：任务正文（标题/描述/标签）在写入 Supabase 前用「团队密钥」做 AES-GCM 加密，
 *           Supabase 只存密文、看不到明文；团队密钥仅保存在各成员本地浏览器，不上传。
 * 团队共享、拖拽/筛选/统计/导出/微信推送逻辑不变。
 * 免费版约 7 天无访问会暂停，已通过 .github/workflows/keepalive.yml 每天 ping 兜底。
 * ============================================================ */
(function () {
  'use strict';

  // ---------- 初始化 Supabase ----------
  const cfg = window.APP_CONFIG || {};
  const URL = cfg.SUPABASE_URL;
  const KEY = cfg.SUPABASE_ANON_KEY;
  const LS_USER = 'wtb_local_user';
  const INITIAL_PWD = '123456';
  // ---------- 浏览器端加密（AES-GCM + PBKDF2） ----------
  const LS_TEAMKEY = 'wtb_team_key_v1';
  const ENC_SALT = 'work-task-hub::static-salt::v1';
  const PBKDF2_ITER = 120000;
  let cryptoKey = null; // 当前会话派生出的 CryptoKey

  let supabase = null, ready = false;
  if (URL && KEY && URL.indexOf('YOUR_') !== 0 && window.supabase) {
    supabase = window.supabase.createClient(URL, KEY);
    ready = true;
  }

  // ---------- 全局状态 ----------
  const state = {
    user: null,        // { code, name, is_admin }
    profile: null,     // { name, pushplus_token, remind_lead_hours }
    mustChange: false, // 是否必须改密码
    tasks: [],
    filters: { status: '', priority: '', recurrence: '', search: '' },
    chart: null
  };

  // ---------- DOM 引用 ----------
  const $ = (s) => document.querySelector(s);
  const authView = $('#auth-view');
  const mainView = $('#main-view');
  const loginCard = $('#login-card');
  const initCard = $('#init-card');
  const loginMsg = $('#login-msg');
  const initMsg = $('#init-msg');
  const taskList = $('#task-list');
  const emptyHint = $('#empty-hint');
  const reminderBanner = $('#reminder-banner');

  // ---------- 工具：SHA-256 ----------
  async function sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  // ---------- 工具：浏览器端加密（AES-GCM + PBKDF2） ----------
  function getTeamKeyRaw() { return localStorage.getItem(LS_TEAMKEY) || ''; }
  function setTeamKeyRaw(k) { if (k) localStorage.setItem(LS_TEAMKEY, k); }

  async function deriveKey(passphrase) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(ENC_SALT), iterations: PBKDF2_ITER, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function encryptObj(obj, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(obj));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
    const buf = new Uint8Array(iv.length + ct.byteLength);
    buf.set(iv, 0);
    buf.set(new Uint8Array(ct), iv.length);
    return bytesToB64(buf);
  }

  async function decryptObj(b64, key) {
    const buf = b64ToBytes(b64);
    const iv = buf.slice(0, 12);
    const ct = buf.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(pt));
  }

  // ============================================================
  // 启动
  // ============================================================
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    if (!ready) {
      loginMsg.textContent = '⚠️ 尚未配置 Supabase。请让管理员在 assets/config.js 填入 SUPABASE_URL 与 SUPABASE_ANON_KEY。';
      return;
    }
    bindLogin();
    bindInit();
    bindToolbar();
    bindModals();
    bindTaskForm();
    bindSettingsForm();
    bindAdmin();
    bindChangePwd();
    bindRekey();
    registerSW();

    // 恢复登录态
    try {
      const saved = JSON.parse(localStorage.getItem(LS_USER) || 'null');
      if (saved && saved.code) {
        state.user = saved;
        await afterLogin();
        return;
      }
    } catch (e) { /* 忽略 */ }

    // 未登录：判断是初始化还是登录
    await decideAuthView();
  }

  async function decideAuthView() {
    try {
      const { count, error } = await supabase
        .from('members').select('*', { count: 'exact', head: true });
      if (error) throw error;
      if (count === 0) {
        initCard.classList.remove('hidden');
        loginCard.classList.add('hidden');
      } else {
        loginCard.classList.remove('hidden');
        initCard.classList.add('hidden');
      }
    } catch (e) {
      loginCard.classList.remove('hidden');
      initCard.classList.add('hidden');
    }
    authView.classList.remove('hidden');
  }

  // ============================================================
  // 登录（人事编码 + 姓名 + 密码）
  // ============================================================
  function bindLogin() {
    $('#login-eye').addEventListener('click', () => {
      const inp = $('#login-pwd');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = $('#login-code').value.trim();
      const name = $('#login-name').value.trim();
      const pwd = $('#login-pwd').value;
      if (!code || !name || !pwd) { loginMsg.textContent = '请填写人事编码、姓名和密码'; return; }
      $('#login-submit').disabled = true;
      loginMsg.textContent = '验证中…';
      try {
        const { data, error } = await supabase
          .from('members').select('*').eq('code', code).single();
        if (error || !data) { loginMsg.textContent = '人事编码不存在，请联系管理员导入'; return; }
        if (data.name.trim() !== name) { loginMsg.textContent = '姓名与档案不符，请检查'; return; }
        const hash = await sha256(pwd);
        if (hash !== data.password_hash) { loginMsg.textContent = '密码错误'; return; }

        const user = { code: data.code, name: data.name, is_admin: data.is_admin };
        localStorage.setItem(LS_USER, JSON.stringify(user));
        state.user = user;
        state.mustChange = data.must_change_pwd;
        await afterLogin();
        if (state.mustChange) openChangePwd(true);
      } catch (err) {
        loginMsg.textContent = '登录出错：' + (err.message || err);
      } finally {
        $('#login-submit').disabled = false;
      }
    });
  }

  // ============================================================
  // 初始化管理员（成员表为空时）
  // ============================================================
  function bindInit() {
    $('#init-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = $('#init-code').value.trim();
      const name = $('#init-name').value.trim();
      const pwd = $('#init-pwd').value;
      const pwd2 = $('#init-pwd2').value;
      const tk = $('#init-teamkey').value;
      const tk2 = $('#init-teamkey2').value;
      if (!code || !name || !pwd) { initMsg.textContent = '请填写完整信息'; return; }
      if (pwd !== pwd2) { initMsg.textContent = '两次密码不一致'; return; }
      if (!tk || tk !== tk2) { initMsg.textContent = '两次团队密钥不一致'; return; }
      $('#init-submit').disabled = true;
      initMsg.textContent = '创建中…';
      try {
        const hash = await sha256(pwd);
        const { error } = await supabase.from('members').insert({
          code, name, password_hash: hash, must_change_pwd: false, is_admin: true
        });
        if (error) throw error;
        setTeamKeyRaw(tk);
        cryptoKey = await deriveKey(tk);
        const user = { code, name, is_admin: true };
        localStorage.setItem(LS_USER, JSON.stringify(user));
        state.user = user;
        state.mustChange = false;
        await afterLogin();
        alert('管理员初始化成功！团队密钥已保存在本机。请把团队密钥《' + tk + '》发给团队成员，他们在登录后需输入它来解锁任务内容。');
      } catch (err) {
        initMsg.textContent = '初始化失败：' + (err.message || err);
      } finally {
        $('#init-submit').disabled = false;
      }
    });
  }

  // ============================================================
  // 登录后
  // ============================================================
  async function afterLogin() {
    showMain();
    await loadProfile();
    await ensureTeamKey();
    await loadTasks();
    checkReminders();
  }

  // 确保已获取团队密钥（用于加解密任务内容）。若本机未保存，则弹出输入框要求输入。
  // 管理员首次登录且无本地密钥时，额外提供“创建团队密钥”入口（SQL 导入管理员不走初始化面板，需此补位）。
  async function ensureTeamKey() {
    const raw = getTeamKeyRaw();
    if (raw) {
      cryptoKey = await deriveKey(raw);
      return cryptoKey;
    }
    return new Promise((resolve) => {
      const input = $('#teamkey-input');
      const msg = $('#teamkey-msg');
      const submit = $('#teamkey-submit');
      const createBox = $('#teamkey-create');
      const isAdmin = !!(state.user && state.user.is_admin);
      msg.textContent = '';
      input.value = '';
      createBox.classList.toggle('hidden', !isAdmin);
      openModal('#teamkey-modal');

      const onEnter = async () => {
        const v = input.value.trim();
        if (!v) { msg.textContent = '请输入团队密钥'; return; }
        try {
          const k = await deriveKey(v);
          cryptoKey = k;
          setTeamKeyRaw(v);
          closeModal('#teamkey-modal');
          submit.removeEventListener('click', onEnter);
          if (onCreate) createBtn.removeEventListener('click', onCreate);
          resolve(k);
        } catch (e) { msg.textContent = '密钥无效：' + (e.message || e); }
      };

      let createBtn = null, onCreate = null;
      if (isAdmin) {
        createBtn = $('#tk-create-btn');
        $('#tk-new').value = '';
        $('#tk-new2').value = '';
        $('#tk-create-msg').textContent = '';
        onCreate = async () => {
          const nk = $('#tk-new').value;
          const nk2 = $('#tk-new2').value;
          const cmsg = $('#tk-create-msg');
          if (!nk || nk !== nk2) { cmsg.textContent = '请输入新团队密钥并两次一致'; return; }
          try {
            const k = await deriveKey(nk);
            cryptoKey = k;
            setTeamKeyRaw(nk);
            closeModal('#teamkey-modal');
            submit.removeEventListener('click', onEnter);
            createBtn.removeEventListener('click', onCreate);
            alert('✅ 团队密钥已设置并保存在本机。请把团队密钥《' + nk + '》发给所有成员，他们在登录后需输入它来解锁任务内容。');
            resolve(k);
          } catch (e) { cmsg.textContent = '创建失败：' + (e.message || e); }
        };
        createBtn.addEventListener('click', onCreate);
      }
      submit.addEventListener('click', onEnter);
    });
  }

  function showMain() {
    authView.classList.add('hidden');
    mainView.classList.remove('hidden');
    $('#user-name').textContent = (state.profile && state.profile.name) || (state.user && state.user.name) || '';
    // 管理员才显示“成员管理”
    $('#btn-admin').style.display = state.user && state.user.is_admin ? '' : 'none';
  }

  function logout() {
    localStorage.removeItem(LS_USER);
    state.user = null; state.profile = null; state.tasks = [];
    location.reload();
  }

  // ============================================================
  // 资料（显示名 / 微信令牌 / 提前量）—— 存在 members 表
  // ============================================================
  async function loadProfile() {
    try {
      const { data } = await supabase
        .from('members')
        .select('name, pushplus_token, remind_lead_hours')
        .eq('code', state.user.code).single();
      if (data) {
        state.profile = {
          name: data.name || state.user.name,
          pushplus_token: data.pushplus_token || '',
          remind_lead_hours: data.remind_lead_hours || 24
        };
        return;
      }
    } catch (e) { /* 用默认 */ }
    state.profile = { name: state.user.name, pushplus_token: '', remind_lead_hours: 24 };
  }

  async function saveProfile(patch) {
    const { error } = await supabase.from('members').update({
      name: patch.name,
      pushplus_token: patch.pushplusToken,
      remind_lead_hours: patch.remindLeadHours
    }).eq('code', state.user.code);
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
    const tasks = [];
    for (const d of (data || [])) {
      let content = { title: '', description: '', tags: [] };
      if (d.data_enc) {
        try {
          content = await decryptObj(d.data_enc, cryptoKey);
        } catch (e) {
          content = { title: '（解密失败·密钥可能不符）', description: '', tags: [] };
          console.warn('任务解密失败', d.id, e);
        }
      }
      tasks.push(dbToTask(d, content));
    }
    state.tasks = tasks;
    renderTasks();
  }

  function dbToTask(d, content) {
    return {
      id: d.id,
      title: content.title || '',
      description: content.description || '',
      priority: d.priority || 'medium',
      tags: content.tags || [],
      due_date: d.due_date || null,
      recurrence: d.recurrence || 'none',
      status: d.status || 'todo',
      sort_order: d.sort_order || 0,
      creator_code: d.creator_code || '',
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

      const content = {
        title: $('#f-title').value.trim(),
        description: $('#f-desc').value.trim(),
        tags
      };
      const msg = $('#task-form-msg');
      if (!content.title) { msg.textContent = '请填写标题'; return; }
      if (!cryptoKey) { msg.textContent = '⚠️ 团队密钥未就绪，无法加密保存'; return; }

      let data_enc;
      try {
        data_enc = await encryptObj(content, cryptoKey);
      } catch (e) { msg.textContent = '❌ 加密失败：' + (e.message || e); return; }

      const row = {
        data_enc,
        priority: $('#f-priority').value,
        status: $('#f-status').value,
        due_date: dueIso,
        recurrence: $('#f-recurrence').value
      };

      try {
        if (id) {
          const { error } = await supabase.from('tasks').update(row).eq('id', id);
          if (error) throw error;
        } else {
          row.creator_code = state.user.code;
          row.creator_name = (state.profile && state.profile.name) || (state.user && state.user.name) || '';
          row.sort_order = state.tasks.length;
          const { error } = await supabase.from('tasks').insert(row);
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
      '添加人': t.creator_name || '',
      '创建时间': dayjs(t.created_at).format('YYYY-MM-DD HH:mm')
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '工作任务');
    XLSX.writeFile(wb, '工作任务台_' + dayjs().format('YYYYMMDD') + '.xlsx');
  }

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
    if (!token) { alert('请先在“我的”中填写 PushPlus 令牌。'); openSettings(); return; }
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
  // 我的（资料 + 改密码）
  // ============================================================
  function openSettings() {
    $('#s-name').value = (state.profile && state.profile.name) || '';
    $('#s-token').value = (state.profile && state.profile.pushplus_token) || '';
    $('#s-lead').value = (state.profile && state.profile.remind_lead_hours) || 24;
    $('#cp-old').value = ''; $('#cp-new').value = ''; $('#cp-new2').value = '';
    $('#cp-msg').textContent = '';
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
      alert('✅ 资料已保存');
    });
  }

  function bindChangePwd() {
    $('#cp-btn').addEventListener('click', () => { doChangePwd(false); });
  }

  // 修改团队密钥：用新密钥重新加密全部任务（旧密钥仍在内存中，可直接解密重算）
  function bindRekey() {
    $('#rekey-btn').addEventListener('click', async () => {
      const nk = $('#rekey-new').value;
      const nk2 = $('#rekey-new2').value;
      const msg = $('#rekey-msg');
      if (!nk || nk !== nk2) { msg.textContent = '请输入新团队密钥并两次一致'; return; }
      if (!confirm('将用新密钥重新加密全部任务。请确保已把新密钥告知所有成员，否则他们将无法解锁旧任务。继续？')) return;
      try {
        const newKey = await deriveKey(nk);
        for (const t of state.tasks) {
          const content = { title: t.title, description: t.description, tags: t.tags };
          const data_enc = await encryptObj(content, newKey);
          const { error } = await supabase.from('tasks').update({ data_enc }).eq('id', t.id);
          if (error) throw error;
        }
        cryptoKey = newKey;
        setTeamKeyRaw(nk);
        msg.textContent = '✅ 已用新密钥重新加密全部任务';
      } catch (e) {
        msg.textContent = '重加密失败：' + (e.message || e);
      }
    });
  }

  async function doChangePwd(force, e) {
    if (e) e.preventDefault();
    const oldP = $('#cp-old').value;
    const newP = $('#cp-new').value;
    const newP2 = $('#cp-new2').value;
    const msg = $('#cp-msg');
    if (!newP || !newP2) { msg.textContent = '请填写新密码和确认新密码'; return; }
    if (newP !== newP2) { msg.textContent = '两次新密码不一致'; return; }
    try {
      if (!force) {
        if (!oldP) { msg.textContent = '请填写旧密码'; return; }
        const { data } = await supabase.from('members')
          .select('password_hash').eq('code', state.user.code).single();
        if (!data || await sha256(oldP) !== data.password_hash) { msg.textContent = '旧密码错误'; return; }
      }
      const { error } = await supabase.from('members').update({
        password_hash: await sha256(newP), must_change_pwd: false
      }).eq('code', state.user.code);
      if (error) { msg.textContent = '修改失败：' + (error.message || error); return; }
      state.mustChange = false;
      closeModal('#settings-modal');
      alert('✅ 密码已修改');
    } catch (err) {
      $('#cp-msg').textContent = '修改出错：' + (err.message || err);
    }
  }

  function openChangePwd(force) {
    $('#cp-old').value = ''; $('#cp-new').value = ''; $('#cp-new2').value = '';
    $('#cp-msg').textContent = force ? '首次登录，请先修改初始密码。' : '';
    openModal('#settings-modal');
  }

  // ============================================================
  // 成员管理（仅管理员）
  // ============================================================
  function bindAdmin() {
    $('#btn-admin').addEventListener('click', openAdmin);
    $('#am-add').addEventListener('click', async () => {
      const code = $('#am-code').value.trim();
      const name = $('#am-name').value.trim();
      if (!code || !name) { amMsg('请填写人事编码和姓名'); return; }
      try {
        const hash = await sha256(INITIAL_PWD);
        const { error } = await supabase.from('members').insert({
          code, name, password_hash: hash, must_change_pwd: true, is_admin: false, created_by: state.user.code
        });
        if (error) throw error;
        $('#am-code').value = ''; $('#am-name').value = '';
        amMsg('✅ 已添加：' + code + ' / ' + name + '（初始密码 123456）', false);
        renderMembers();
      } catch (err) {
        amMsg('添加失败：' + (err.message || err));
      }
    });
    $('#am-bulk-add').addEventListener('click', async () => {
      const text = $('#am-bulk').value;
      const list = parseMembers(text);
      if (!list.length) { amMsg('没有解析到有效的“编码,姓名”行'); return; }
      try {
        const hash = await sha256(INITIAL_PWD);
        const rows = list.map((m) => ({
          code: m.code, name: m.name, password_hash: hash,
          must_change_pwd: true, is_admin: false, created_by: state.user.code
        }));
        const { error } = await supabase.from('members').insert(rows);
        if (error) throw error;
        $('#am-bulk').value = '';
        amMsg('✅ 已批量导入 ' + list.length + ' 名成员（初始密码 123456）', false);
        renderMembers();
      } catch (err) {
        amMsg('批量导入失败：' + (err.message || err));
      }
    });
  }

  function parseMembers(text) {
    return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((line) => {
      const parts = line.split(/[,，\t]+/).map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) return { code: parts[0], name: parts.slice(1).join(' ') };
      return null;
    }).filter(Boolean);
  }

  async function openAdmin() {
    openModal('#admin-modal');
    await renderMembers();
  }

  async function renderMembers() {
    try {
      const { data, error } = await supabase.from('members')
        .select('code, name, is_admin, must_change_pwd').order('created_at', { ascending: true });
      if (error) throw error;
      const box = $('#am-list');
      box.innerHTML = '';
      (data || []).forEach((m) => {
        const row = document.createElement('div');
        row.className = 'am-item';
        row.innerHTML = `
          <span class="am-code">${esc(m.code)}</span>
          <span class="am-name">${esc(m.name)}</span>
          ${m.is_admin ? '<span class="am-tag admin">管理员</span>' : ''}
          ${m.must_change_pwd ? '<span class="am-tag pwd">待改密</span>' : ''}
          <span class="am-ops">
            <button class="mini-btn" data-reset="${esc(m.code)}">重置密码</button>
            ${m.is_admin ? '' : `<button class="mini-btn danger" data-del="${esc(m.code)}">删除</button>`}
          </span>`;
        box.appendChild(row);
      });
      box.querySelectorAll('[data-reset]').forEach((b) => {
        b.addEventListener('click', () => resetPwd(b.dataset.reset));
      });
      box.querySelectorAll('[data-del]').forEach((b) => {
        b.addEventListener('click', () => delMember(b.dataset.del));
      });
    } catch (e) {
      amMsg('加载成员失败：' + (e.message || e));
    }
  }

  async function resetPwd(code) {
    if (!confirm('确定将 ' + code + ' 的密码重置为 123456 吗？')) return;
    try {
      const { error } = await supabase.from('members')
        .update({ password_hash: await sha256(INITIAL_PWD), must_change_pwd: true })
        .eq('code', code);
      if (error) throw error;
      amMsg('✅ 已重置 ' + code + ' 的密码为 123456', false);
      renderMembers();
    } catch (e) { amMsg('重置失败：' + (e.message || e)); }
  }

  async function delMember(code) {
    if (!confirm('确定删除成员 ' + code + ' 吗？该成员的任务记录仍会保留（仅创建人显示为原名）。')) return;
    try {
      const { error } = await supabase.from('members').delete().eq('code', code);
      if (error) throw error;
      amMsg('✅ 已删除 ' + code, false);
      renderMembers();
    } catch (e) { amMsg('删除失败：' + (e.message || e)); }
  }

  function amMsg(text, isErr) {
    const el = $('#am-msg');
    el.textContent = text;
    el.style.color = isErr === false ? 'var(--green)' : 'var(--red)';
  }

  // ============================================================
  // 弹窗通用
  // ============================================================
  function bindModals() {
    document.querySelectorAll('[data-close]').forEach((b) => {
      b.addEventListener('click', () => b.closest('.modal').classList.add('hidden'));
    });
    document.querySelectorAll('.modal').forEach((m) => {
      if (m.hasAttribute('data-noclose')) return; // 团队密钥弹窗不可点背景关闭
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
