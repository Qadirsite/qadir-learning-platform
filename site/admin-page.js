'use strict';
(() => {
  const pageSize = 50;
  const permissionLabels = [
    ['users.view', 'عرض الحسابات'],
    ['users.search', 'البحث عن الحسابات'],
    ['leaderboard.view', 'عرض ترتيب الطلاب'],
    ['users.manage_roles', 'إسناد رتب للحسابات'],
    ['users.manage', 'إدارة الحسابات وتفعيلها وتعطيلها وحذفها'],
    ['dashboard.view', 'عرض الملخص والإحصاءات'],
    ['content.view', 'عرض المحتوى'], ['content.manage', 'إدارة المحتوى'],
    ['messages.view', 'عرض الرسائل'], ['messages.manage', 'الرد وإدارة الرسائل'],
    ['media.view', 'عرض الملفات'], ['media.manage', 'رفع وإدارة الملفات'],
    ['settings.view', 'عرض الإعدادات'], ['settings.manage', 'تعديل الإعدادات'],
    ['navigation.manage', 'إدارة القوائم'], ['audit.view', 'عرض سجل النشاط'],
    ['backups.manage', 'تصدير النسخ الاحتياطية'], ['security.manage', 'إدارة الجلسات'],
    ['integrations.manage', 'إدارة التكاملات']
  ];
  const state = {
    user: null, csrfToken: '', search: '', offset: 0, total: 0, busy: false,
    timer: 0, requestId: 0, roles: [], assignableRoles: [], canManageDefinitions: false
  };
  const $ = selector => document.querySelector(selector);
  const gate = $('#gate');
  const content = $('#admin-content');
  const searchInput = $('#account-search');
  const list = $('#user-list');
  const summary = $('#result-summary');
  const pageLabel = $('#page-label');
  const previous = $('#previous-page');
  const next = $('#next-page');
  const toast = $('#toast');
  const roleManager = $('#role-manager');
  const roleList = $('#role-list');
  let toastTimer;

  function setTheme(theme) {
    const value = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = value;
    $('#theme-toggle').textContent = value === 'dark' ? 'الوضع الفاتح' : 'الوضع الداكن';
    try { localStorage.setItem('qadir-theme-v1', value); } catch {}
  }
  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3800);
  }
  function showGate(title, message, login = false) {
    gate.replaceChildren();
    const heading = document.createElement('h1');
    heading.textContent = title;
    const paragraph = document.createElement('p');
    paragraph.textContent = message;
    gate.append(heading, paragraph);
    if (login) {
      const form = document.createElement('form');
      form.className = 'admin-login-form';
      const usernameLabel = document.createElement('label');
      usernameLabel.textContent = 'اسم المستخدم';
      const username = document.createElement('input');
      username.name = 'username'; username.autocomplete = 'username'; username.required = true; username.maxLength = 24; username.dir = 'ltr';
      const passwordLabel = document.createElement('label');
      passwordLabel.textContent = 'كلمة المرور';
      const password = document.createElement('input');
      password.type = 'password'; password.name = 'password'; password.autocomplete = 'current-password'; password.required = true; password.maxLength = 128; password.dir = 'ltr';
      const submit = document.createElement('button');
      submit.className = 'button primary'; submit.type = 'submit'; submit.textContent = 'دخول النظام الإداري';
      form.append(usernameLabel, username, passwordLabel, password, submit);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        submit.disabled = true;
        try {
          await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: username.value, password: password.value }) });
          location.reload();
        } catch (error) { password.value = ''; showToast(error.message); submit.disabled = false; }
      });
      gate.append(form);
    }
    const home = document.createElement('a');
    home.className = 'button'; home.href = '/'; home.textContent = 'العودة إلى قادر';
    gate.append(home);
    gate.hidden = false;
    content.hidden = true;
  }
  async function request(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    if (method !== 'GET' && method !== 'HEAD') {
      headers['Content-Type'] = 'application/json';
      headers['X-CSRF-Token'] = state.csrfToken;
    }
    const response = await fetch(url, { ...options, method, headers, credentials: 'same-origin', cache: 'no-store' });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) {
    if (response.status === 401) showGate('دخول النظام الإداري', data.error || 'أدخل بيانات حساب إداري للمتابعة.', true);
      if (response.status === 403 && method === 'GET') showGate('لا تملك صلاحية الإدارة', data.error || 'لا يملك الحساب الحالي إذن الوصول إلى هذه الصفحة.');
      throw new Error(data.error || 'تعذر إتمام الطلب. حاول مرة أخرى.');
    }
    if (data.csrfToken) state.csrfToken = data.csrfToken;
    if (Object.prototype.hasOwnProperty.call(data, 'user')) state.user = data.user;
    return data;
  }
  function formatTime(value) {
    const seconds = Math.max(0, Number(value) || 0);
    if (seconds < 60) return `${Math.floor(seconds)} ثانية`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} دقيقة`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes ? `${hours} ساعة و${minutes} دقيقة` : `${hours} ساعة`;
  }
  function formatDate(value) {
    if (!value) return 'لا يوجد نشاط مسجل';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'لا يوجد نشاط مسجل' : `آخر نشاط ${new Intl.DateTimeFormat('ar-SA', { year: 'numeric', month: 'short', day: 'numeric' }).format(date)}`;
  }
  function canManageUsers() { return state.user?.permissions?.includes('users.manage_roles') === true; }
  function canManageStatus(user) { return state.user?.permissions?.includes('users.manage') === true && !isProtectedFromActor(user); }
  function canDeleteUser(user) { return state.user?.permissions?.includes('users.manage') === true && !isProtectedFromActor(user); }
  function actorPriority() { return state.user?.username === 'ak9' ? 100 : Number(state.user?.rolePriority) || 0; }
  function isProtectedFromActor(user) {
    if (user.username === state.user?.username || user.username === 'ak9') return true;
    return !state.canManageDefinitions && Number(user.rolePriority) >= actorPriority();
  }
  function roleLabel(key, provided) {
    if (provided) return provided;
    return state.roles.find(role => role.role_key === key)?.label || key;
  }
  async function assignRole(user, roleKey, select) {
    if (state.busy || !roleKey || roleKey === user.role) return;
    const selected = state.assignableRoles.find(role => role.role_key === roleKey);
    if (!selected) { showToast('لا يمكنك إسناد هذه الرتبة.'); return; }
    state.busy = true;
    searchInput.disabled = true;
    setRoleControlsDisabled(true);
    if (select) select.disabled = true;
    try {
      await request('/api/admin/users/role', { method: 'POST', body: JSON.stringify({ username: user.username, role: roleKey }) });
      showToast(`تم تحديث رتبة ${user.username}.`);
      await Promise.all([loadRoles(), loadUsers()]);
    } catch (error) {
      if (gate.hidden) showToast(error.message);
      await loadUsers();
    } finally { state.busy = false; searchInput.disabled = !state.user?.permissions?.includes('users.search'); }
  }
  async function toggleUserActive(user) {
    if (state.busy || !canManageStatus(user)) return;
    const active = !user.isActive;
    if (!active && !window.confirm(`تعطيل حساب ${user.username}؟ سيُسجّل خروجه من الجلسات الحالية.`)) return;
    state.busy = true;
    setRoleControlsDisabled(true);
    try {
      await request('/api/admin/users/status', { method:'POST', body:JSON.stringify({username:user.username,active}) });
      showToast(active ? `تم تفعيل حساب ${user.username}.` : `تم تعطيل حساب ${user.username}.`);
      await loadUsers();
    } catch (error) { if (gate.hidden) showToast(error.message); }
    finally { state.busy=false; }
  }
  async function deleteUser(user) {
    if (state.busy || !canDeleteUser(user)) return;
    if (!window.confirm(`حذف حساب ${user.username} نهائيًا؟ ستُحذف جلساته ورسائله ولا يمكن التراجع.`)) return;
    state.busy = true;
    setRoleControlsDisabled(true);
    try {
      await request('/api/admin/users/delete', { method:'POST', body:JSON.stringify({username:user.username,confirm:true}) });
      showToast(`تم حذف حساب ${user.username}.`);
      await loadUsers();
    } catch (error) { if (gate.hidden) showToast(error.message); }
    finally { state.busy=false; }
  }
  function roleControl(user) {
    const currentLabel = roleLabel(user.role, user.roleLabel);
    const badge = document.createElement('span');
    badge.className = `badge${user.role === 'student' ? ' student' : ''}`;
    badge.textContent = currentLabel;
    return badge;
  }
  function roleAssignmentControl(user) {
    const protectedTarget = user.username === state.user?.username || user.username === 'ak9' || isProtectedFromActor(user);
    if (!canManageUsers() || protectedTarget || !state.assignableRoles.length) return null;

    const select = document.createElement('select');
    select.className = 'user-role-select';
    select.setAttribute('aria-label', `ترقية ${user.username} إلى رتبة`);
    select.title = 'اضغط لعرض جميع الرتب؛ الرتب غير المتاحة حسب التدرج معطلة';
    const prompt = document.createElement('option');
    prompt.value = '';
    prompt.textContent = 'ترقية إلى';
    prompt.disabled = true;
    prompt.selected = true;
    select.append(prompt);
    for (const role of state.roles) {
      const option = document.createElement('option');
      const assignable = state.assignableRoles.some(item => item.role_key === role.role_key);
      const current = role.role_key === user.role;
      option.value = role.role_key;
      option.textContent = current ? `${role.label} (الرتبة الحالية)` : role.label;
      option.disabled = !assignable || current;
      option.title = option.disabled ? 'لا يمكن اختيار الرتبة الحالية أو رتبة مساوية أو أعلى من رتبتك.' : '';
      select.append(option);
    }
    select.disabled = state.busy;
    select.addEventListener('change', () => assignRole(user, select.value, select));
    return select;
  }
  function setRoleControlsDisabled(disabled) {
    list.querySelectorAll('.user-role-select').forEach(control => { control.disabled = disabled; });
  }
  function createUserCard(user) {
    const card = document.createElement('article');
    card.className = 'panel user-card';
    card.setAttribute('role', 'listitem');
    const main = document.createElement('div');
    main.className = 'user-main';
    const name = document.createElement('div');
    name.className = 'user-name';
    name.textContent = user.username;
    const nameRow = document.createElement('div');
    nameRow.className = 'user-name-row';
    nameRow.append(name);
    const assignment = roleAssignmentControl(user);
    if (assignment) nameRow.append(assignment);
    const meta = document.createElement('div');
    meta.className = 'user-meta';
    const badge = roleControl(user);
    const activity = document.createElement('span');
    activity.textContent = `النشاط المسجل: ${formatTime(user.activeSeconds)}`;
    const activeBadge = document.createElement('span');
    activeBadge.className = `badge account-status${user.isActive ? ' is-active' : ' is-inactive'}`;
    activeBadge.textContent = user.isActive ? 'حساب مفعّل' : 'حساب موقوف';
    const lastActive = document.createElement('span');
    lastActive.textContent = formatDate(user.lastActiveAt);
    meta.append(badge, activeBadge, activity, lastActive);
    main.append(nameRow, meta);
    const actions = document.createElement('div');
    actions.className = 'user-actions';
    if (!canManageUsers()) {
      const note = document.createElement('span');
      note.className = 'protected';
      note.textContent = 'عرض فقط';
      actions.append(note);
    } else if (user.username === state.user.username || user.username === 'ak9') {
      const protectedLabel = document.createElement('span');
      protectedLabel.className = 'protected';
      protectedLabel.textContent = user.username === 'ak9' ? 'مالك النظام محمي' : 'لا يمكن تغيير رتبتك الذاتية';
      actions.append(protectedLabel);
    } else if (isProtectedFromActor(user)) {
      const protectedLabel = document.createElement('span');
      protectedLabel.className = 'protected';
      protectedLabel.textContent = 'لا يمكن تعديل رتبة مساوية أو أعلى';
      actions.append(protectedLabel);
    } else if (!state.assignableRoles.length) {
      const note = document.createElement('span');
      note.className = 'protected';
      note.textContent = 'لا توجد رتب متاحة للإسناد لهذا الحساب';
      actions.append(note);
    }
    if (canManageStatus(user)) {
      const statusButton = document.createElement('button');
      statusButton.type='button';
      statusButton.className=`button ${user.isActive ? 'danger' : 'primary'}`;
      statusButton.textContent=user.isActive?'تعطيل الحساب':'تفعيل الحساب';
      statusButton.addEventListener('click',()=>toggleUserActive(user));
      actions.append(statusButton);
    }
    if (canDeleteUser(user)) {
      const deleteButton = document.createElement('button');
      deleteButton.type='button';
      deleteButton.className='button danger';
      deleteButton.textContent='حذف الحساب';
      deleteButton.addEventListener('click',()=>deleteUser(user));
      actions.append(deleteButton);
    }
    actions.hidden = actions.childElementCount === 0;
    card.append(main, actions);
    return card;
  }
  function updatePagination(users) {
    const start = state.total ? state.offset + 1 : 0;
    const end = Math.min(state.offset + users.length, state.total);
    summary.textContent = state.search ? `${state.total} نتيجة مطابقة` : `${state.total} حساب`;
    pageLabel.textContent = state.total ? `${start}–${end} من ${state.total}` : 'لا توجد نتائج';
    previous.disabled = state.busy || state.offset === 0;
    next.disabled = state.busy || state.offset + users.length >= state.total;
    $('#list-status').textContent = state.search ? `نتائج البحث عن «${state.search}»` : 'جميع الحسابات';
  }
  async function loadUsers() {
    const requestId = ++state.requestId;
    state.search = searchInput.hidden || !state.user?.permissions?.includes('users.search') ? '' : searchInput.value.trim().toLowerCase();
    state.busy = true;
    setRoleControlsDisabled(true);
    list.setAttribute('aria-busy', 'true');
    summary.textContent = 'جارٍ تحميل الحسابات…';
    previous.disabled = true;
    next.disabled = true;
    try {
      const params = new URLSearchParams({ limit: String(pageSize), offset: String(state.offset), search: state.search });
      const data = await request(`/api/admin/users?${params}`);
      if (requestId !== state.requestId) return;
      state.total = Number(data.total) || 0;
      list.replaceChildren();
      if (data.users.length) list.append(...data.users.map(createUserCard));
      else {
        const empty = document.createElement('div');
        empty.className = 'panel empty';
        empty.textContent = state.search ? 'لا توجد حسابات بهذا الاسم.' : 'لا توجد حسابات لعرضها.';
        list.append(empty);
      }
      updatePagination(data.users);
    } catch (error) {
      if (requestId !== state.requestId || !gate.hidden) return;
      list.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'panel empty';
      empty.textContent = error.message;
      list.append(empty);
      summary.textContent = 'تعذر تحميل الحسابات';
      pageLabel.textContent = '';
    } finally {
      if (requestId === state.requestId) {
        state.busy = false;
        setRoleControlsDisabled(false);
        list.setAttribute('aria-busy', 'false');
        previous.disabled = state.offset === 0;
        next.disabled = state.offset + list.querySelectorAll('.user-card').length >= state.total;
      }
    }
  }
  function addPermissionInputs(container, initial = [], disabled = false) {
    container.replaceChildren();
    for (const [permission, label] of permissionLabels) {
      const wrapper = document.createElement('label');
      wrapper.className = 'permission-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = permission;
      checkbox.checked = initial.includes(permission);
      checkbox.disabled = disabled;
      checkbox.dataset.permission = permission;
      checkbox.addEventListener('change', () => {
        const viewPermission = container.querySelector('input[data-permission="users.view"]');
        const dependentPermissions = container.querySelectorAll('input[data-permission="users.search"],input[data-permission="users.manage_roles"]');
        if (permission === 'users.view' && !checkbox.checked) dependentPermissions.forEach(input => { input.checked = false; });
        else if (['users.search', 'users.manage_roles'].includes(permission) && checkbox.checked && viewPermission) viewPermission.checked = true;
      });
      const text = document.createElement('span');
      text.textContent = label;
      wrapper.append(checkbox, text);
      container.append(wrapper);
    }
  }
  function selectedPermissions(container) {
    return [...container.querySelectorAll('input[data-permission]:checked')].map(input => input.dataset.permission);
  }
  async function loadRoles() {
    const data = await request('/api/admin/roles');
    state.roles = Array.isArray(data.roles) ? data.roles : [];
    state.assignableRoles = Array.isArray(data.assignableRoles) ? data.assignableRoles : [];
    state.canManageDefinitions = data.canManageDefinitions === true;
    roleManager.hidden = !state.canManageDefinitions;
    if (state.canManageDefinitions) renderRoleDefinitions();
  }
  function createRoleCard(role) {
    const article = document.createElement('article');
    article.className = 'panel role-card';
    const header = document.createElement('div');
    header.className = 'role-card-head';
    const titleWrap = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'role-card-title';
    title.textContent = role.label;
    const note = document.createElement('span');
    note.className = 'role-card-note';
    note.textContent = `${role.users_count} حساب · مستوى ${role.priority}`;
    titleWrap.append(title, note);
    const badge = document.createElement('span');
    badge.className = 'badge role-card-badge';
    badge.textContent = role.is_system ? 'رتبة أساسية' : 'رتبة مخصصة';
    header.append(titleWrap, badge);
    article.append(header);
    if (role.category !== 'admin' || role.role_key === 'student') {
      const protectedNote = document.createElement('div');
      protectedNote.className = 'role-protected-note';
      protectedNote.textContent = 'رتبة الطلاب الأساسية محمية ولا يمكن تعديل صلاحياتها.';
      article.append(protectedNote);
      return article;
    }
    const form = document.createElement('form');
    form.className = 'role-editor';
    const fields = document.createElement('div');
    fields.className = 'role-editor-fields';
    const labelWrap = document.createElement('label');
    labelWrap.className = 'field-wrap';
    const labelText = document.createElement('span');
    labelText.textContent = 'اسم الرتبة';
    const labelInput = document.createElement('input');
    labelInput.className = 'search role-input role-editor-name';
    labelInput.type = 'text';
    labelInput.required = true;
    labelInput.minLength = 2;
    labelInput.maxLength = 40;
    labelInput.value = role.label;
    labelWrap.append(labelText, labelInput);
    const priorityWrap = document.createElement('label');
    priorityWrap.className = 'field-wrap';
    const priorityText = document.createElement('span');
    priorityText.textContent = 'المستوى';
    const priorityInput = document.createElement('input');
    priorityInput.className = 'search role-input role-priority-input';
    priorityInput.type = 'number';
    priorityInput.min = '1';
    priorityInput.max = '99';
    priorityInput.step = '1';
    priorityInput.required = true;
    priorityInput.value = String(role.priority);
    priorityWrap.append(priorityText, priorityInput);
    fields.append(labelWrap, priorityWrap);
    const permissions = document.createElement('div');
    permissions.className = 'permission-grid';
    addPermissionInputs(permissions, role.permissions, false);
    const permissionHint = document.createElement('p');
    permissionHint.className = 'list-note';
    permissionHint.textContent = 'البحث وإسناد الرتب يتطلبان إذن عرض الحسابات؛ يُفعّل هذا الإذن تلقائيًا.';
    const actions = document.createElement('div');
    actions.className = 'role-card-actions';
    const save = document.createElement('button');
    save.className = 'button primary';
    save.type = 'submit';
    save.textContent = 'حفظ التغييرات';
    actions.append(save);
    if (!role.is_system) {
      const remove = document.createElement('button');
      remove.className = 'button danger';
      remove.type = 'button';
      remove.textContent = 'حذف الرتبة';
      remove.disabled = Number(role.users_count) > 0;
      remove.title = remove.disabled ? 'أعد إسناد حساباتها أولًا قبل حذفها.' : 'حذف تعريف الرتبة';
      remove.addEventListener('click', () => deleteRole(role));
      actions.append(remove);
    }
    form.append(fields, permissions, permissionHint, actions);
    form.addEventListener('submit', event => {
      event.preventDefault();
      updateRole(role, labelInput.value, priorityInput.value, selectedPermissions(permissions));
    });
    article.append(form);
    return article;
  }
  function renderRoleDefinitions() {
    addPermissionInputs($('[data-permissions="create"]'), [], false);
    roleList.replaceChildren(...state.roles.map(createRoleCard));
  }
  async function loadAll() {
    await loadRoles();
    await loadUsers();
  }
  async function setBusy(value) {
    state.busy = value;
    list.setAttribute('aria-busy', String(value));
    searchInput.disabled = value || !state.user?.permissions?.includes('users.search');
    $('#previous-page').disabled = value || state.offset === 0;
    $('#next-page').disabled = value || state.offset + list.querySelectorAll('.user-card').length >= state.total;
  }
  async function createRole(event) {
    event.preventDefault();
    if (state.busy || !state.canManageDefinitions) return;
    const form = $('#create-role-form');
    const label = $('#new-role-label').value.trim();
    const priority = Number($('#new-role-priority').value);
    const permissions = selectedPermissions($('[data-permissions="create"]'));
    state.busy = true;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await request('/api/admin/roles', { method: 'POST', body: JSON.stringify({ label, priority, permissions }) });
      form.reset();
      $('#new-role-priority').value = '40';
      showToast(`تم إنشاء رتبة «${label}».`);
      await loadAll();
    } catch (error) { if (gate.hidden) showToast(error.message); }
    finally { state.busy = false; submit.disabled = false; }
  }
  async function updateRole(role, label, priorityText, permissions) {
    if (state.busy || !state.canManageDefinitions) return;
    const priority = Number(priorityText);
    if (!window.confirm(`حفظ التعديلات على رتبة «${role.label}»؟ ستتغير صلاحيات كل الحسابات التابعة لها.`)) return;
    state.busy = true;
    try {
      await request(`/api/admin/roles/${encodeURIComponent(role.role_key)}`, { method: 'PUT', body: JSON.stringify({ label: label.trim(), priority, permissions }) });
      showToast(`تم تحديث رتبة «${label.trim()}».`);
      await loadAll();
    } catch (error) { if (gate.hidden) showToast(error.message); }
    finally { state.busy = false; }
  }
  async function deleteRole(role) {
    if (state.busy || !state.canManageDefinitions || role.is_system || Number(role.users_count) > 0) return;
    if (!window.confirm(`حذف تعريف الرتبة «${role.label}»؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
    state.busy = true;
    try {
      await request(`/api/admin/roles/${encodeURIComponent(role.role_key)}`, { method: 'DELETE', body: '{}' });
      showToast(`تم حذف رتبة «${role.label}».`);
      await loadAll();
    } catch (error) { if (gate.hidden) showToast(error.message); }
    finally { state.busy = false; }
  }
  async function start() {
    let theme = 'light';
    try { theme = localStorage.getItem('qadir-theme-v1') || 'light'; } catch {}
    setTheme(theme);
    $('#theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    searchInput.closest('.field-wrap').hidden = true;
    try {
      const data = await request('/api/auth/session');
      state.user = data.user;
      if (!state.user) return showGate('دخول النظام الإداري', 'أدخل بيانات حساب إداري للوصول إلى لوحة قادر.', true);
      const permissions = state.user.permissions || [];
      const hasAdminAccess = permissions.some(permission => ['dashboard.view','content.view','users.view','messages.view','media.view','settings.view','audit.view','security.manage'].includes(permission));
      if (!hasAdminAccess) return showGate('لا تملك صلاحية الإدارة', 'هذا الحساب لا يملك أي إذن إداري. سجّل الخروج ثم استخدم حسابًا إداريًا.', true);
      gate.hidden = true;
      content.hidden = false;
      const usersSection = $('#section-users');
      const canViewUsers = permissions.includes('users.view');
      if (usersSection) usersSection.hidden = !canViewUsers;
      searchInput.closest('.field-wrap').hidden = !permissions.includes('users.search');
      searchInput.disabled = !permissions.includes('users.search');
      window.dispatchEvent(new CustomEvent('qadir-admin-authenticated', { detail: { user: state.user, csrfToken: state.csrfToken } }));
      if (canViewUsers) {
        searchInput.addEventListener('input', () => {
          clearTimeout(state.timer);
          state.offset = 0;
          state.requestId += 1;
          state.timer = setTimeout(loadUsers, 220);
        });
        previous.addEventListener('click', () => { state.offset = Math.max(0, state.offset - pageSize); loadUsers(); });
        next.addEventListener('click', () => { state.offset += pageSize; loadUsers(); });
        $('#create-role-form').addEventListener('submit', createRole);
        await loadAll();
      }
    } catch (error) {
      if (!state.user) showGate('تعذر التحقق من الجلسة', 'ارجع إلى قادر، سجّل الدخول، ثم افتح النظام الإداري مجددًا.', true);
      else if (gate.hidden) showToast(error.message);
    }
  }
  start();
})();
