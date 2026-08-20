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

const state = {
  kind: 'characters', // characters | personas
  items: { characters: [], personas: [] },
  selectedId: null,
  search: '',
  dirty: false,
};

function currentItems() {
  return state.items[state.kind] || [];
}

function selectedItem() {
  return currentItems().find((i) => i.id === state.selectedId) || null;
}

function setKind(kind) {
  if (state.dirty && !confirm('Discard unsaved changes?')) return;
  state.kind = kind;
  state.selectedId = null;
  state.dirty = false;
  document.querySelectorAll('.lib-tab').forEach((tab) => {
    const on = tab.dataset.kind === kind;
    tab.classList.toggle('active', on);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if ($('lib-hint')) {
    $('lib-hint').textContent =
      kind === 'personas'
        ? 'Personas describe you — injected as the human in prompts.'
        : 'Characters define who the AI is — personality, scenario, first message.';
  }
  if ($('lib-empty-title')) {
    $('lib-empty-title').textContent =
      kind === 'personas' ? 'Create your first persona' : 'Create your first character';
  }
  if ($('lib-empty-copy')) {
    $('lib-empty-copy').textContent =
      kind === 'personas'
        ? 'Tell the model who you are: name, vibe, preferences, boundaries.'
        : 'Give the AI a name, personality, scenario, and opening line.';
  }
  if ($('lib-empty-new')) {
    $('lib-empty-new').textContent = kind === 'personas' ? 'Create persona' : 'Create character';
  }
  if ($('lib-kind')) $('lib-kind').value = kind;
  renderList();
  showEmpty();
}

function showEmpty() {
  $('lib-empty')?.classList.remove('hidden');
  $('lib-editor-wrap')?.classList.add('hidden');
  $('lib-duplicate')?.setAttribute('hidden', '');
  $('lib-delete')?.setAttribute('hidden', '');
}

function showEditor() {
  $('lib-empty')?.classList.add('hidden');
  $('lib-editor-wrap')?.classList.remove('hidden');
  $('lib-duplicate')?.removeAttribute('hidden');
  $('lib-delete')?.removeAttribute('hidden');
}

function renderList() {
  const list = $('lib-list');
  if (!list) return;
  const q = state.search.trim().toLowerCase();
  let items = currentItems();
  if (q) {
    items = items.filter((i) => {
      const hay = [i.name, i.description, i.personality, i.about, i.scenario, ...(i.tags || [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }

  if ($('count-characters')) $('count-characters').textContent = String(state.items.characters.length);
  if ($('count-personas')) $('count-personas').textContent = String(state.items.personas.length);

  if (!items.length) {
    list.innerHTML = `<p class="lib-list-empty">${q ? 'No matches' : 'Nothing here yet'}</p>`;
    return;
  }

  list.innerHTML = items
    .map((item) => {
      const blurb = (item.personality || item.description || item.about || item.scenario || 'No details yet').slice(0, 70);
      return `
      <button type="button" class="lib-item${item.id === state.selectedId ? ' active' : ''}" data-id="${escapeHtml(item.id)}">
        <span class="lib-item-av">${escapeHtml((item.name || '?').slice(0, 1).toUpperCase())}</span>
        <span class="lib-item-copy">
          <strong>${escapeHtml(item.name || 'Untitled')}</strong>
          <em>${escapeHtml(blurb)}</em>
        </span>
      </button>`;
    })
    .join('');
}

function renderFields(item) {
  const box = $('lib-fields');
  const kind = state.kind;
  if (!box) return;

  if (kind === 'characters') {
    box.innerHTML = `
      <label class="full">Description
        <textarea id="f-description" rows="2" placeholder="Short summary of who they are">${escapeHtml(item?.description || '')}</textarea>
      </label>
      <label class="full">Personality
        <textarea id="f-personality" rows="4" placeholder="Tone, quirks, how they talk…">${escapeHtml(item?.personality || '')}</textarea>
      </label>
      <label class="full">Scenario
        <textarea id="f-scenario" rows="3" placeholder="Where / when this character exists">${escapeHtml(item?.scenario || '')}</textarea>
      </label>
      <label class="full">First message
        <textarea id="f-first" rows="3" placeholder="Their opening line when a chat starts">${escapeHtml(item?.firstMessage || '')}</textarea>
      </label>
      <label class="full">Example dialogue
        <textarea id="f-examples" rows="3" placeholder="Optional few-shot style samples">${escapeHtml(item?.exampleDialogue || '')}</textarea>
      </label>
      <label class="full">System prompt
        <textarea id="f-system" rows="4" placeholder="Instructions that lock the character in">${escapeHtml(item?.systemPrompt || '')}</textarea>
      </label>
      <label class="full">Tags
        <input id="f-tags" type="text" placeholder="friend, coach, rp" value="${escapeHtml((item?.tags || []).join(', '))}">
      </label>`;
  } else {
    box.innerHTML = `
      <label class="full">Description
        <textarea id="f-description" rows="2" placeholder="Who is this version of you?">${escapeHtml(item?.description || '')}</textarea>
      </label>
      <label class="full">About you
        <textarea id="f-about" rows="6" placeholder="Preferences, background, how you want to be addressed, boundaries…">${escapeHtml(item?.about || '')}</textarea>
      </label>`;
  }

  box.querySelectorAll('input, textarea').forEach((el) => {
    el.addEventListener('input', () => {
      state.dirty = true;
      updatePreview();
    });
  });
}

function updatePreview() {
  const name = $('lib-name')?.value?.trim() || 'Untitled';
  const blurb =
    ($('f-personality')?.value ||
      $('f-about')?.value ||
      $('f-description')?.value ||
      $('f-scenario')?.value ||
      'Fill in the fields to preview.')
      .trim()
      .slice(0, 140);
  if ($('lib-preview-name')) $('lib-preview-name').textContent = name;
  if ($('lib-preview-avatar')) $('lib-preview-avatar').textContent = name.slice(0, 1).toUpperCase();
  if ($('lib-preview-blurb')) $('lib-preview-blurb').textContent = blurb || 'Fill in the fields to preview.';
}

function openItem(id) {
  if (state.dirty && id !== state.selectedId && !confirm('Discard unsaved changes?')) return;
  const item = currentItems().find((i) => i.id === id);
  if (!item) return;
  state.selectedId = id;
  state.dirty = false;
  showEditor();
  $('lib-id').value = item.id;
  $('lib-kind').value = state.kind;
  $('lib-name').value = item.name || '';
  renderFields(item);
  updatePreview();
  renderList();
}

function startNew() {
  if (state.dirty && !confirm('Discard unsaved changes?')) return;
  state.selectedId = null;
  state.dirty = false;
  showEditor();
  $('lib-id').value = '';
  $('lib-kind').value = state.kind;
  $('lib-name').value = '';
  renderFields({ name: '' });
  updatePreview();
  renderList();
  $('lib-name')?.focus();
}

function collectBody() {
  const kind = state.kind;
  const body = { name: $('lib-name').value.trim() };
  if (!body.name) throw new Error('Name is required');
  if (kind === 'characters') {
    body.description = $('f-description')?.value || '';
    body.personality = $('f-personality')?.value || '';
    body.scenario = $('f-scenario')?.value || '';
    body.firstMessage = $('f-first')?.value || '';
    body.exampleDialogue = $('f-examples')?.value || '';
    body.systemPrompt = $('f-system')?.value || '';
    body.tags = ($('f-tags')?.value || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  } else {
    body.description = $('f-description')?.value || '';
    body.about = $('f-about')?.value || '';
  }
  return body;
}

async function loadAll() {
  const [chars, personas] = await Promise.all([api('/api/characters'), api('/api/personas')]);
  state.items.characters = chars.items || [];
  state.items.personas = personas.items || [];
  renderList();
}

async function saveItem(e) {
  e.preventDefault();
  try {
    const body = collectBody();
    const id = $('lib-id').value;
    const pathBase = state.kind === 'characters' ? '/api/characters' : '/api/personas';
    const saved = id
      ? await api(`${pathBase}/${id}`, { method: 'PUT', body: JSON.stringify(body) })
      : await api(pathBase, { method: 'POST', body: JSON.stringify(body) });
    await loadAll();
    state.selectedId = saved.id;
    state.dirty = false;
    openItem(saved.id);
    toast('Saved');
  } catch (err) {
    toast(err.message || 'Save failed');
  }
}

async function deleteItem() {
  const id = $('lib-id').value || state.selectedId;
  if (!id) return;
  if (!confirm(`Delete this ${state.kind === 'personas' ? 'persona' : 'character'}?`)) return;
  const pathBase = state.kind === 'characters' ? '/api/characters' : '/api/personas';
  await api(`${pathBase}/${id}`, { method: 'DELETE' });
  state.selectedId = null;
  state.dirty = false;
  await loadAll();
  showEmpty();
  toast('Deleted');
}

async function duplicateItem() {
  const item = selectedItem();
  if (!item) return;
  const pathBase = state.kind === 'characters' ? '/api/characters' : '/api/personas';
  const body = { ...item, name: `${item.name || 'Untitled'} (copy)` };
  delete body.id;
  delete body.createdAt;
  delete body.updatedAt;
  const saved = await api(pathBase, { method: 'POST', body: JSON.stringify(body) });
  await loadAll();
  openItem(saved.id);
  toast('Duplicated');
}

async function init() {
  try {
    await api('/api/me');
  } catch {
    location.href = '/login.html';
    return;
  }

  // Theme from settings if available
  try {
    const settings = await api('/api/settings');
    document.body.dataset.theme = settings.theme || 'dark';
    document.body.dataset.accent = settings.accent || 'neutral';
  } catch {
    /* ignore */
  }

  await loadAll();

  // Deep link ?tab=personas&id=...
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab');
  if (tab === 'personas' || tab === 'characters') setKind(tab);
  else setKind('characters');
  const deepId = params.get('id');
  if (deepId && currentItems().some((i) => i.id === deepId)) openItem(deepId);

  document.querySelectorAll('.lib-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => setKind(tabBtn.dataset.kind));
  });
  $('lib-search')?.addEventListener('input', (e) => {
    state.search = e.target.value;
    renderList();
  });
  $('lib-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-id]');
    if (btn) openItem(btn.dataset.id);
  });
  $('lib-new')?.addEventListener('click', startNew);
  $('lib-empty-new')?.addEventListener('click', startNew);
  $('lib-form')?.addEventListener('submit', saveItem);
  $('lib-name')?.addEventListener('input', () => {
    state.dirty = true;
    updatePreview();
  });
  $('lib-cancel')?.addEventListener('click', () => {
    if (state.dirty && !confirm('Discard unsaved changes?')) return;
    state.dirty = false;
    if (state.selectedId) openItem(state.selectedId);
    else showEmpty();
  });
  $('lib-delete')?.addEventListener('click', () => deleteItem().catch((err) => toast(err.message)));
  $('lib-duplicate')?.addEventListener('click', () => duplicateItem().catch((err) => toast(err.message)));
}

init().catch((err) => {
  console.error(err);
  toast(err.message || 'Failed to load');
});
