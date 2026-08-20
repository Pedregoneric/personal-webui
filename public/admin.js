'use strict';

async function api(path, options = {}) {
  const opts = {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  };
  const res = await fetch(path, opts);
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || 'Request failed');
    return data;
  }
  if (!res.ok) throw new Error(res.statusText || 'Request failed');
  return res;
}

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toast(message, ms = 1800) {
  const host = $('toast-host');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.2s ease';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

const state = {
  me: null,
  users: [],
  app: null,
  resetUserId: null,
};

function renderUsers() {
  const tbody = $('users-tbody');
  if (!tbody) return;
  if (!state.users.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted sm">No users yet.</td></tr>';
    return;
  }
  tbody.innerHTML = state.users
    .map((u) => {
      const disabled = Boolean(u.disabled);
      const isSelf = state.me && u.id === state.me.id;
      return `<tr data-user-id="${escapeHtml(u.id)}">
        <td>
          <strong>${escapeHtml(u.username)}</strong>
          ${isSelf ? '<span class="admin-pill">you</span>' : ''}
        </td>
        <td>
          <select class="admin-inline-select" data-action="role" aria-label="Role for ${escapeHtml(u.username)}">
            <option value="user"${u.role === 'user' ? ' selected' : ''}>user</option>
            <option value="admin"${u.role === 'admin' ? ' selected' : ''}>admin</option>
          </select>
        </td>
        <td>
          <span class="admin-status ${disabled ? 'is-disabled' : 'is-active'}">${disabled ? 'Disabled' : 'Active'}</span>
        </td>
        <td class="muted sm">${escapeHtml(formatDate(u.createdAt))}</td>
        <td class="admin-row-actions">
          <button type="button" class="btn-secondary sm" data-action="toggle-disabled">${disabled ? 'Enable' : 'Disable'}</button>
          <button type="button" class="btn-secondary sm" data-action="reset-password">Reset password</button>
        </td>
      </tr>`;
    })
    .join('');
}

function fillAppForm() {
  const app = state.app || {};
  if ($('signup-enabled')) $('signup-enabled').checked = Boolean(app.signupEnabled);
  if ($('signup-status')) {
    $('signup-status').textContent = app.signupEnabled
      ? 'Signup is currently open.'
      : 'Signup is currently closed.';
  }
  if ($('brand-title')) $('brand-title').value = app.brandTitle || '';
  if ($('tip-url')) $('tip-url').value = app.tipUrl || '';
}

async function loadUsers() {
  const data = await api('/api/admin/users');
  state.users = data.items || [];
  renderUsers();
}

async function loadApp() {
  state.app = await api('/api/admin/app');
  fillAppForm();
}

async function patchUser(id, body) {
  const updated = await api(`/api/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  const idx = state.users.findIndex((u) => u.id === id);
  if (idx >= 0) state.users[idx] = updated;
  else await loadUsers();
  renderUsers();
  return updated;
}

function bindUsersTable() {
  $('users-tbody')?.addEventListener('change', async (e) => {
    const select = e.target.closest('select[data-action="role"]');
    if (!select) return;
    const row = select.closest('tr[data-user-id]');
    if (!row) return;
    const id = row.dataset.userId;
    const prev = state.users.find((u) => u.id === id);
    try {
      await patchUser(id, { role: select.value });
      toast('Role updated');
    } catch (err) {
      if (prev) select.value = prev.role;
      toast(err.message || 'Role update failed');
    }
  });

  $('users-tbody')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('tr[data-user-id]');
    if (!row) return;
    const id = row.dataset.userId;
    const user = state.users.find((u) => u.id === id);
    if (!user) return;

    if (btn.dataset.action === 'toggle-disabled') {
      try {
        await patchUser(id, { disabled: !user.disabled });
        toast(user.disabled ? 'User enabled' : 'User disabled');
      } catch (err) {
        toast(err.message || 'Update failed');
      }
      return;
    }

    if (btn.dataset.action === 'reset-password') {
      state.resetUserId = id;
      if ($('reset-user-label')) {
        $('reset-user-label').textContent = `New password for ${user.username}`;
      }
      if ($('reset-password')) $('reset-password').value = '';
      $('reset-dialog')?.showModal();
    }
  });
}

function bindCreateForm() {
  $('user-create-toggle')?.addEventListener('click', () => {
    $('user-create-form')?.classList.remove('hidden');
    $('create-username')?.focus();
  });
  $('user-create-cancel')?.addEventListener('click', () => {
    $('user-create-form')?.classList.add('hidden');
    $('user-create-form')?.reset();
  });
  $('user-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('create-username')?.value.trim();
    const password = $('create-password')?.value;
    const role = $('create-role')?.value === 'admin' ? 'admin' : 'user';
    try {
      const user = await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({ username, password, role }),
      });
      state.users.push(user);
      state.users.sort((a, b) => String(a.username).localeCompare(String(b.username)));
      renderUsers();
      $('user-create-form')?.reset();
      $('user-create-form')?.classList.add('hidden');
      toast('User created');
    } catch (err) {
      toast(err.message || 'Create failed');
    }
  });
}

function bindSignup() {
  $('signup-enabled')?.addEventListener('change', async (e) => {
    const checked = Boolean(e.target.checked);
    try {
      state.app = await api('/api/admin/app', {
        method: 'PATCH',
        body: JSON.stringify({ signupEnabled: checked }),
      });
      fillAppForm();
      toast(checked ? 'Signup enabled' : 'Signup disabled');
    } catch (err) {
      e.target.checked = !checked;
      toast(err.message || 'Update failed');
    }
  });
}

function bindAppearance() {
  $('appearance-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      state.app = await api('/api/admin/app', {
        method: 'PATCH',
        body: JSON.stringify({
          brandTitle: $('brand-title')?.value || '',
          tipUrl: $('tip-url')?.value || '',
        }),
      });
      fillAppForm();
      toast('Appearance saved');
    } catch (err) {
      toast(err.message || 'Save failed');
    }
  });
}

function bindResetDialog() {
  $('reset-cancel')?.addEventListener('click', () => {
    state.resetUserId = null;
    $('reset-dialog')?.close();
  });
  $('reset-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = state.resetUserId;
    const password = $('reset-password')?.value;
    if (!id) return;
    try {
      await patchUser(id, { password });
      state.resetUserId = null;
      $('reset-dialog')?.close();
      toast('Password reset');
    } catch (err) {
      toast(err.message || 'Reset failed');
    }
  });
}

async function init() {
  try {
    state.me = await api('/api/me');
  } catch {
    location.href = '/login.html';
    return;
  }
  if (state.me.role !== 'admin') {
    location.href = '/';
    return;
  }

  bindUsersTable();
  bindCreateForm();
  bindSignup();
  bindAppearance();
  bindResetDialog();

  try {
    await Promise.all([loadUsers(), loadApp()]);
  } catch (err) {
    toast(err.message || 'Failed to load admin data');
  }
}

init();
