'use strict';

const isLoginPage = Boolean(document.getElementById('login-form') || document.getElementById('setup-form'));

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

function parseFenceHeader(header) {
  const raw = String(header || '').trim();
  if (!raw) return { lang: '', path: '' };
  // `path/to/file.ext` or `lang path/to/file.ext` or `lang:path`
  const colon = raw.match(/^([A-Za-z0-9_+#.-]{1,32}):\s*(.+)$/);
  if (colon && /[./]/.test(colon[2])) {
    return { lang: colon[1], path: colon[2].trim() };
  }
  const parts = raw.split(/\s+/);
  if (parts.length >= 2 && /[./]/.test(parts.slice(1).join(' '))) {
    return { lang: parts[0], path: parts.slice(1).join(' ').trim() };
  }
  if (/[./]/.test(raw) || /\.[A-Za-z0-9]+$/.test(raw)) {
    return { lang: '', path: raw };
  }
  return { lang: raw, path: '' };
}

function extractPathFences(text) {
  const out = [];
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const { lang, path } = parseFenceHeader(m[1]);
    if (!path) continue;
    out.push({ path, lang, content: m[2].replace(/\n$/, '') });
  }
  return out;
}

let _codeBlockSeq = 0;
const codeBlockStore = new Map();

function renderCodeFence(header, body) {
  const { lang, path } = parseFenceHeader(header);
  const code = String(body || '').replace(/\n$/, '');
  const id = `cb-${++_codeBlockSeq}`;
  codeBlockStore.set(id, { code, path, lang });
  const label = path || lang || 'code';
  const labelText = path && lang ? `${lang} · ${path}` : label;
  const applyBtn = path
    ? `<button type="button" class="code-tool" data-code-apply="${escapeHtml(id)}">Apply</button>`
    : '';
  return `<div class="code-block" data-code-id="${escapeHtml(id)}">
    <div class="code-toolbar">
      <span class="code-label" title="${escapeHtml(labelText)}">${escapeHtml(labelText)}</span>
      <div class="code-tools">
        <button type="button" class="code-tool" data-code-copy="${escapeHtml(id)}">Copy</button>
        <button type="button" class="code-tool" data-code-download="${escapeHtml(id)}">Download</button>
        ${applyBtn}
      </div>
    </div>
    <pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(code)}</code></pre>
  </div>`;
}

function simpleMarkdown(text) {
  codeBlockStore.clear();
  _codeBlockSeq = 0;
  const blocks = [];
  let raw = String(text ?? '');
  raw = raw.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_, header, body) => {
    const token = `%%CODEBLOCK${blocks.length}%%`;
    blocks.push(renderCodeFence(header, body));
    return token;
  });
  raw = raw.replace(/```([^\n`]*?)```/g, (_, body) => {
    const token = `%%CODEBLOCK${blocks.length}%%`;
    blocks.push(renderCodeFence('', body));
    return token;
  });
  let html = escapeHtml(raw);
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    const safe = String(src).startsWith('/api/media/') || String(src).startsWith('data:image/') ? src : '#';
    return `<img class="msg-image" src="${escapeHtml(safe)}" alt="${escapeHtml(alt || 'image')}" loading="lazy">`;
  });
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  blocks.forEach((block, i) => {
    html = html.replace(`%%CODEBLOCK${i}%%`, block);
  });
  return html;
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'file.txt';
  a.click();
  URL.revokeObjectURL(url);
}

function bindCodeBlockTools(root) {
  root?.querySelectorAll('[data-code-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = codeBlockStore.get(btn.getAttribute('data-code-copy'));
      if (item) copyText(item.code);
    });
  });
  root?.querySelectorAll('[data-code-download]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = codeBlockStore.get(btn.getAttribute('data-code-download'));
      if (!item) return;
      const name = (item.path && item.path.split('/').pop()) || `snippet.${item.lang || 'txt'}`;
      downloadTextFile(name, item.code);
    });
  });
  root?.querySelectorAll('[data-code-apply]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = codeBlockStore.get(btn.getAttribute('data-code-apply'));
      if (item?.path) applyWorkspaceFile(item.path, item.code).catch((err) => toast(err.message || 'Apply failed'));
    });
  });
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v > 1e9) return `${(v / 1e9).toFixed(1)} GB`;
  if (v > 1e6) return `${(v / 1e6).toFixed(0)} MB`;
  return `${v} B`;
}

/* ---------------- Login ---------------- */
async function initLogin() {
  const status = await api('/api/setup-status');
  const setupForm = $('setup-form');
  const loginForm = $('login-form');
  const signupForm = $('signup-form');
  const signupEnabled = Boolean(status.signupEnabled);

  if (status.brandTitle && $('auth-title') && !status.setupRequired) {
    $('auth-title').textContent = status.brandTitle;
  }
  if (status.tipUrl && $('tip-link')) $('tip-link').href = status.tipUrl;

  function showLogin() {
    if (setupForm) setupForm.hidden = true;
    if (loginForm) loginForm.hidden = false;
    if (signupForm) signupForm.hidden = true;
    if ($('signup-switch')) $('signup-switch').hidden = !signupEnabled;
  }

  function showSignup() {
    if (setupForm) setupForm.hidden = true;
    if (loginForm) loginForm.hidden = true;
    if (signupForm) signupForm.hidden = false;
  }

  if (status.setupRequired) {
    if (setupForm) setupForm.hidden = false;
    if (loginForm) loginForm.hidden = true;
    if (signupForm) signupForm.hidden = true;
    if ($('auth-title')) $('auth-title').textContent = 'Create your login';
  } else {
    showLogin();
  }

  $('show-signup')?.addEventListener('click', showSignup);
  $('show-login')?.addEventListener('click', showLogin);

  setupForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('setup-error');
    err.textContent = '';
    if ($('setup-password').value !== $('setup-confirm').value) {
      err.textContent = 'Passwords do not match';
      return;
    }
    try {
      await api('/api/setup', {
        method: 'POST',
        body: JSON.stringify({
          username: $('setup-username').value.trim(),
          password: $('setup-password').value,
        }),
      });
      location.href = '/';
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('login-error');
    err.textContent = '';
    try {
      await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          username: $('username').value.trim(),
          password: $('password').value,
        }),
      });
      location.href = '/';
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  signupForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('signup-error');
    err.textContent = '';
    if ($('signup-password').value !== $('signup-confirm').value) {
      err.textContent = 'Passwords do not match';
      return;
    }
    try {
      await api('/api/signup', {
        method: 'POST',
        body: JSON.stringify({
          username: $('signup-username').value.trim(),
          password: $('signup-password').value,
        }),
      });
      location.href = '/';
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
}

/* ---------------- Main app ---------------- */
const state = {
  me: null,
  settings: null,
  modes: [],
  mode: null,
  chats: [],
  chat: null,
  folders: [],
  activeFolderId: null,
  characters: [],
  personas: [],
  presets: [],
  models: [],
  generating: false,
  imageGenerating: false,
  libraryTab: 'characters',
  librarySelectedId: null,
  search: '',
  comfyModels: null,
  comfyAssets: null,
  gallery: [],
  llm: null,
  llmPresets: [],
  editingProviderId: null,
  workspace: { files: [], openPath: null, content: '', savedContent: '', dirty: false, loading: false },
  workspaceSaveTimer: null,
  dismissedProposals: new Set(),
};

function currentMode() {
  return (
    state.mode ||
    state.modes.find((m) => m.id === (state.settings?.activeMode || 'chat')) || {
      id: 'chat',
      name: 'Chat',
      icon: '◎',
      tagline: 'Clean conversation',
      description: '',
      accent: 'violet',
      density: 'comfortable',
      chatWidth: 'wide',
      layoutId: 'chat',
      layout: {
        showCharacter: false,
        showPersona: true,
        showImageGen: false,
        showCompanionPanel: false,
        showSceneHeader: false,
        showStudioCanvas: false,
        showCastRail: false,
        filterChatsByMode: true,
      },
      tools: { imageGen: false },
      starters: [],
      templates: [],
      defaults: { temperature: 0.75, topP: 0.95, maxTokens: 4096 },
    }
  );
}

function characterName(id) {
  return state.characters.find((c) => c.id === id)?.name || 'Character';
}
function personaName(id) {
  return state.personas.find((p) => p.id === id)?.name || 'You';
}
function getModeName(id) {
  return state.modes.find((m) => m.id === id)?.name || id || 'Chat';
}

function fillSelect(el, items, valueKey, labelKey, emptyLabel, selected) {
  if (!el) return;
  const opts = [];
  if (emptyLabel != null) opts.push(`<option value="">${escapeHtml(emptyLabel)}</option>`);
  for (const item of items) {
    const val = item[valueKey];
    const label = item[labelKey] || val;
    opts.push(`<option value="${escapeHtml(val)}"${String(val) === String(selected || '') ? ' selected' : ''}>${escapeHtml(label)}</option>`);
  }
  el.innerHTML = opts.join('');
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

function updateProviderChip() {
  const chip = $('provider-chip');
  if (!chip) return;
  const active = (state.llm?.providers || state.settings?.llm?.providers || []).find(
    (p) => p.id === (state.llm?.activeProviderId || state.settings?.llm?.activeProviderId),
  ) || state.me?.provider;
  chip.textContent = active?.name || 'LLM';
  chip.title = active?.baseUrl ? `${active.name} · ${active.baseUrl}` : 'Active model provider';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    toast('Copy failed');
  }
}

function setStatus(mode, label) {
  const pill = $('run-status');
  const conn = $('connection');
  const connLabel = $('connection-label');
  pill?.classList.remove('busy', 'err', 'hidden');
  conn?.classList.remove('busy', 'err');
  if (mode === 'busy') {
    pill?.classList.add('busy');
    conn?.classList.add('busy');
  } else if (mode === 'err') {
    pill?.classList.add('err');
    conn?.classList.add('err');
  } else {
    // Keep top bar calm when idle — ChatGPT-style
    pill?.classList.add('hidden');
  }
  if (pill) pill.innerHTML = `<i></i><span>${escapeHtml(label)}</span>`;
  if (connLabel) connLabel.textContent = label === 'Ready' ? 'Ready' : label;
}

function openModal(id) {
  $(id)?.classList.remove('hidden');
}
function closeModal(id) {
  $(id)?.classList.add('hidden');
}

function applySettings(settings) {
  state.settings = settings;
  document.body.dataset.theme = settings.theme || 'dark';
  document.body.dataset.accent = settings.accent || 'neutral';
  document.body.dataset.density = settings.density || 'comfortable';
  document.body.dataset.chatWidth = settings.chatWidth || 'wide';
  document.body.dataset.mode = settings.activeMode || 'chat';
  document.documentElement.style.setProperty('--font-scale', String(settings.fontScale || 1));
  const slot = $('custom-css-slot');
  if (slot) slot.textContent = settings.customCss || '';
  if (settings.llm) state.llm = settings.llm;
  updateProviderChip();
  applyModeUi();
}

function applyModeUi() {
  const mode = currentMode();
  state.mode = mode;
  document.body.dataset.mode = mode.id;
  document.body.dataset.layout = mode.layoutId || mode.id || 'chat';

  if ($('thread-heading-label')) {
    $('thread-heading-label').textContent =
      mode.id === 'studio'
        ? 'Sessions'
        : mode.id === 'code'
          ? 'Projects'
          : mode.id === 'story'
            ? 'Scenes'
            : mode.id === 'companion'
              ? 'Chats'
              : 'Chats';
  }

  renderModeRail();
  syncComposerSelects();

  const showChar = Boolean(mode.layout?.showCharacter);
  const showPersona = Boolean(mode.layout?.showPersona);
  $('character-chip')?.classList.toggle('hidden', !showChar);
  $('persona-chip')?.classList.toggle('hidden', !showPersona);

  const comfyOn = state.settings?.comfy?.enabled !== false;
  const showImg = Boolean(mode.layout?.showImageGen && mode.tools?.imageGen && comfyOn);
  $('open-image-gen')?.classList.toggle('hidden', !showImg || mode.layoutId === 'studio');
  if (!showImg || mode.layoutId === 'studio') $('image-gen-panel')?.classList.add('hidden');

  if ($('composer-hint')) {
    $('composer-hint').textContent =
      mode.id === 'code' ? 'Path-tagged fences can Apply into the workspace. Attach a .zip to import.' : '';
  }

  if ($('message')) {
    $('message').placeholder = mode.id === 'code' ? 'Ask, paste an error, or describe what to build…' : 'Message…';
  }

  renderEmptyState();
  renderCompanionPanel();
  renderCastRail();
  renderSceneHeader();
  renderStudioStage();
  renderCodeStage();
  renderChatList();
  renderCharacterCard();
}

function renderModeRail() {
  const rail = $('mode-rail');
  const select = $('mode-select');
  if (select && state.modes.length) {
    fillSelect(select, state.modes, 'id', 'name', null, currentMode().id);
  }
  if (!rail) return;
  const active = currentMode().id;
  rail.innerHTML = state.modes
    .map(
      (m) => `
    <button type="button" class="mode-btn${m.id === active ? ' active' : ''}" data-mode="${escapeHtml(m.id)}" title="${escapeHtml(m.description || m.tagline || '')}">
      <span class="mode-name">${escapeHtml(m.name)}</span>
    </button>`,
    )
    .join('');
}

function renderEmptyState() {
  const mode = currentMode();
  if ($('empty-eyebrow')) $('empty-eyebrow').textContent = mode.name;
  const titles = {
    chat: 'What are you working on?',
    companion: 'Who do you want to talk to?',
    story: 'What happens next?',
    studio: 'What should we make?',
    code: 'What are we building?',
  };
  if ($('empty-title')) $('empty-title').textContent = titles[mode.id] || titles.chat;
  if ($('empty-lead')) {
    $('empty-lead').textContent =
      mode.id === 'chat'
        ? 'Private chat on your machine.'
        : mode.id === 'code'
          ? 'Import a zip, co-write files in the editor, Apply AI proposals, export when ready.'
          : mode.tagline || mode.description || '';
  }

  const box = $('suggestions');
  if (!box) return;
  box.innerHTML = (mode.starters || [])
    .map(
      (s) => `
    <button type="button" data-prompt="${escapeHtml(s.prompt)}">
      <strong>${escapeHtml(s.title)}</strong>
      <span>${escapeHtml(s.hint || '')}</span>
    </button>`,
    )
    .join('');
  box.querySelectorAll('[data-prompt]').forEach((btn) => {
    btn.addEventListener('click', () => createChat(btn.dataset.prompt));
  });
}

function renderCompanionPanel() {
  const mode = currentMode();
  if (!mode.layout?.showCompanionPanel) return;

  const charId = state.chat?.characterId || state.settings?.defaultCharacterId;
  const c = state.characters.find((x) => x.id === charId);
  if ($('companion-avatar')) $('companion-avatar').textContent = (c?.name || '?').slice(0, 1).toUpperCase();
  if ($('companion-name')) $('companion-name').textContent = c?.name || 'Choose a character';
  if ($('companion-bio')) {
    $('companion-bio').textContent = c
      ? (c.personality || c.description || c.scenario || 'No bio yet — edit them in Library.').slice(0, 220)
      : 'Pick someone from the library to talk with.';
  }
  fillSelect($('companion-character-select'), state.characters, 'id', 'name', 'Select character', charId || '');
  fillSelect(
    $('companion-persona-select'),
    state.personas,
    'id',
    'name',
    'Select persona',
    state.chat?.personaId || state.settings?.defaultPersonaId || '',
  );
  if ($('companion-notes') && document.activeElement !== $('companion-notes')) {
    $('companion-notes').value = state.chat?.storyNotes || '';
  }
}

function renderCastRail() {
  const mode = currentMode();
  const list = $('cast-list');
  if (!list || !mode.layout?.showCastRail) return;
  const active = state.chat?.characterId;
  list.innerHTML = (state.characters || [])
    .map(
      (c) => `
    <button type="button" class="cast-item${c.id === active ? ' active' : ''}" data-char-id="${escapeHtml(c.id)}">
      <span class="av">${escapeHtml((c.name || '?').slice(0, 1))}</span>
      <span><strong>${escapeHtml(c.name)}</strong><span>${escapeHtml((c.tags || []).slice(0, 2).join(' · ') || 'Character')}</span></span>
    </button>`,
    )
    .join('') || '<p class="muted sm" style="padding:8px">No characters yet</p>';
}

function renderSceneHeader() {
  const mode = currentMode();
  if (!mode.layout?.showSceneHeader) return;
  if ($('scene-title')) $('scene-title').textContent = state.chat?.title || 'Untitled scene';
  if ($('scene-character-label')) {
    $('scene-character-label').textContent = state.chat?.characterId ? characterName(state.chat.characterId) : '';
  }
  if ($('scene-notes-preview')) {
    const notes = (state.chat?.storyNotes || '').trim();
    $('scene-notes-preview').textContent = notes
      ? notes.slice(0, 180) + (notes.length > 180 ? '…' : '')
      : 'Add story notes in Chat settings to ground the scene.';
  }
}

function renderStudioStage() {
  const mode = currentMode();
  if (!mode.layout?.showStudioCanvas) return;
  // Lazy-load Comfy assets when entering Studio
  if (!state.comfyAssets) loadComfyAssets().catch(() => {});
  const imgs = (state.gallery || []).filter((g) => g.kind === 'image');
  const latest = imgs[0];
  const preview = $('studio-preview');
  const empty = $('studio-empty');
  if (latest && preview) {
    preview.src = latest.url;
    preview.classList.remove('hidden');
    empty?.classList.add('hidden');
  } else {
    preview?.classList.add('hidden');
    empty?.classList.remove('hidden');
  }
  const thumbs = $('studio-thumbs');
  if (thumbs) {
    thumbs.innerHTML = imgs
      .slice(0, 12)
      .map(
        (g) => `
      <button type="button" data-url="${escapeHtml(g.url)}" title="${escapeHtml(g.filename || g.prompt || '')}">
        <img src="${escapeHtml(g.url)}" alt="">
      </button>`,
      )
      .join('');
    thumbs.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (preview) {
          preview.src = btn.dataset.url;
          preview.classList.remove('hidden');
          empty?.classList.add('hidden');
        }
      });
    });
  }
}

function resetWorkspaceState() {
  if (state.workspaceSaveTimer) clearTimeout(state.workspaceSaveTimer);
  state.workspaceSaveTimer = null;
  state.workspace = { files: [], openPath: null, content: '', savedContent: '', dirty: false, loading: false };
}

function renderCodeStage() {
  const stage = $('code-stage');
  const mode = currentMode();
  if (!stage) return;
  const show = Boolean(mode.layout?.showCodeStage);
  stage.hidden = !show;
  if (!show) return;
  renderCodeTree();
  syncCodeEditorUi();
}

function renderCodeTree() {
  const tree = $('code-tree');
  if (!tree) return;
  const files = state.workspace.files || [];
  const open = state.workspace.openPath;
  if (!files.length) {
    tree.innerHTML = '<p class="muted sm code-tree-empty">No files yet — New or Import zip.</p>';
    return;
  }
  tree.innerHTML = files
    .map((f) => {
      const name = f.path.split('/').pop();
      const depth = Math.max(0, f.path.split('/').length - 1);
      return `<button type="button" class="code-tree-item${f.path === open ? ' active' : ''}" data-path="${escapeHtml(f.path)}" style="--depth:${depth}" title="${escapeHtml(f.path)}">
        <span class="code-tree-name">${escapeHtml(name)}</span>
        <span class="code-tree-size">${escapeHtml(formatBytes(f.size))}</span>
      </button>`;
    })
    .join('');
  tree.querySelectorAll('[data-path]').forEach((btn) => {
    btn.addEventListener('click', () => openWorkspaceFile(btn.dataset.path).catch((err) => toast(err.message)));
  });
}

function syncCodeEditorUi() {
  const ws = state.workspace;
  if ($('code-path')) $('code-path').textContent = ws.openPath || '—';
  $('code-dirty')?.classList.toggle('hidden', !ws.dirty);
  const editor = $('code-editor');
  if (editor && document.activeElement !== editor) {
    editor.value = ws.content || '';
  } else if (editor && !ws.openPath) {
    editor.value = '';
  }
}

async function loadWorkspace() {
  if (!state.chat?.id || !currentMode().layout?.showCodeStage) {
    resetWorkspaceState();
    renderCodeStage();
    return;
  }
  state.workspace.loading = true;
  try {
    const data = await api(`/api/chats/${state.chat.id}/workspace`);
    state.workspace.files = data.files || [];
    const prefer = state.workspace.openPath;
    const stillThere = prefer && state.workspace.files.some((f) => f.path === prefer);
    const nextPath = stillThere ? prefer : data.openPath || state.workspace.files[0]?.path || 'scratch.md';
    if (nextPath) await openWorkspaceFile(nextPath, { force: !stillThere });
    else {
      state.workspace.openPath = null;
      state.workspace.content = '';
      state.workspace.savedContent = '';
      state.workspace.dirty = false;
    }
  } finally {
    state.workspace.loading = false;
    renderCodeStage();
  }
}

async function openWorkspaceFile(relPath, { force = false } = {}) {
  if (!state.chat?.id || !relPath) return;
  if (state.workspace.dirty && state.workspace.openPath && state.workspace.openPath !== relPath) {
    const ok = confirm(`Save changes to ${state.workspace.openPath} before switching?`);
    if (ok) await saveWorkspaceFile();
    else if (!force) {
      /* discard */
    }
  }
  const data = await api(`/api/chats/${state.chat.id}/workspace/file?path=${encodeURIComponent(relPath)}`);
  state.workspace.openPath = data.path;
  state.workspace.content = data.content ?? '';
  state.workspace.savedContent = state.workspace.content;
  state.workspace.dirty = false;
  const editor = $('code-editor');
  if (editor) editor.value = state.workspace.content;
  renderCodeTree();
  syncCodeEditorUi();
}

async function saveWorkspaceFile() {
  if (!state.chat?.id || !state.workspace.openPath) return;
  const editor = $('code-editor');
  const content = editor ? editor.value : state.workspace.content;
  await api(`/api/chats/${state.chat.id}/workspace/file`, {
    method: 'PUT',
    body: JSON.stringify({ path: state.workspace.openPath, content }),
  });
  state.workspace.content = content;
  state.workspace.savedContent = content;
  state.workspace.dirty = false;
  syncCodeEditorUi();
  const listing = await api(`/api/chats/${state.chat.id}/workspace`);
  state.workspace.files = listing.files || [];
  renderCodeTree();
  toast('Saved');
}

function scheduleWorkspaceSave() {
  if (state.workspaceSaveTimer) clearTimeout(state.workspaceSaveTimer);
  state.workspaceSaveTimer = setTimeout(() => {
    if (state.workspace.dirty) saveWorkspaceFile().catch((err) => toast(err.message || 'Save failed'));
  }, 600);
}

async function applyWorkspaceFile(relPath, content, { quiet = false } = {}) {
  if (!state.chat?.id) await createChat();
  if (
    state.workspace.dirty &&
    state.workspace.openPath === relPath &&
    state.workspace.content !== content
  ) {
    const ok = confirm(`Replace unsaved edits in ${relPath} with the AI proposal?`);
    if (!ok) return;
  }
  await api(`/api/chats/${state.chat.id}/workspace/file`, {
    method: 'PUT',
    body: JSON.stringify({ path: relPath, content }),
  });
  if (state.workspace.openPath === relPath || !state.workspace.openPath) {
    state.workspace.openPath = relPath;
    state.workspace.content = content;
    state.workspace.savedContent = content;
    state.workspace.dirty = false;
    const editor = $('code-editor');
    if (editor) editor.value = content;
  }
  const listing = await api(`/api/chats/${state.chat.id}/workspace`);
  state.workspace.files = listing.files || [];
  renderCodeStage();
  if (!quiet) toast(`Applied ${relPath}`);
}

async function createWorkspaceFile() {
  if (!state.chat?.id) await createChat();
  const rel = prompt('New file path', 'src/main.js');
  if (!rel) return;
  await applyWorkspaceFile(rel.trim().replace(/^\/+/, ''), '', { quiet: true });
  await openWorkspaceFile(rel.trim().replace(/^\/+/, ''));
  toast('Created');
}

async function deleteWorkspaceFile() {
  if (!state.chat?.id || !state.workspace.openPath) return;
  const path = state.workspace.openPath;
  if (!confirm(`Delete ${path}?`)) return;
  await api(`/api/chats/${state.chat.id}/workspace/file?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });
  state.workspace.openPath = null;
  state.workspace.content = '';
  state.workspace.savedContent = '';
  state.workspace.dirty = false;
  await loadWorkspace();
  toast('Deleted');
}

async function importWorkspaceZip(file) {
  if (!state.chat?.id) await createChat();
  const fd = new FormData();
  fd.append('file', file, file.name);
  fd.append('mode', 'merge');
  const result = await api(`/api/chats/${state.chat.id}/workspace/import-zip`, { method: 'POST', body: fd });
  await loadWorkspace();
  toast(`Imported ${result.written || result.entries || 0} files`);
}

async function exportWorkspaceZip() {
  if (!state.chat?.id) return;
  const res = await fetch(`/api/chats/${state.chat.id}/workspace/export-zip`, { credentials: 'same-origin' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText || 'Export failed');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(state.chat.title || 'project').replace(/[^\w.-]+/g, '_').slice(0, 40)}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

function renderCharacterCard() {
  const strip = $('character-card-strip');
  if (!strip) return;
  const mode = currentMode();
  if (!mode.layout?.showCharacterCard || mode.layout?.showCompanionPanel || !state.chat?.characterId) {
    strip.classList.add('hidden');
    strip.innerHTML = '';
    return;
  }
  const c = state.characters.find((x) => x.id === state.chat.characterId);
  if (!c) {
    strip.classList.add('hidden');
    return;
  }
  strip.classList.remove('hidden');
  strip.innerHTML = `
    <div class="char-card">
      <div class="char-card-avatar">${escapeHtml((c.name || '?').slice(0, 1))}</div>
      <div class="char-card-body">
        <strong>${escapeHtml(c.name)}</strong>
        <span>${escapeHtml((c.personality || c.description || c.scenario || '').slice(0, 160))}</span>
      </div>
    </div>`;
}

function folderById(id) {
  return state.folders.find((f) => f.id === id) || null;
}

function renderThreadItem(c) {
  const preview = (c.preview || '').replace(/\s+/g, ' ').replace(/!\[.*?\]\([^)]*\)/g, '🖼').trim();
  const pinLabel = c.pinned ? 'Unpin' : 'Pin';
  return `
    <div class="thread-item${state.chat?.id === c.id ? ' active' : ''}" data-chat-id="${escapeHtml(c.id)}">
      <button type="button" class="thread-item-main">
        <strong>${c.pinned ? '● ' : ''}${escapeHtml(c.title || 'Untitled')}</strong>
        <span>${escapeHtml(preview || 'No messages yet')}</span>
        <div class="thread-meta-row">
          <span class="thread-tag">${escapeHtml(getModeName(c.modeId))}</span>
          ${c.characterId ? `<span class="thread-tag dim">${escapeHtml(characterName(c.characterId))}</span>` : ''}
          <span class="thread-time">${escapeHtml(formatTime(c.updatedAt) || '')}</span>
        </div>
      </button>
      <div class="thread-actions">
        <button type="button" class="thread-action" data-thread-action="move" title="Move to folder" aria-label="Move to folder">Move</button>
        <button type="button" class="thread-action" data-thread-action="pin" title="${pinLabel}" aria-label="${pinLabel}">${pinLabel}</button>
        <button type="button" class="thread-action danger" data-thread-action="delete" title="Delete" aria-label="Delete">Delete</button>
      </div>
    </div>`;
}

function renderChatList() {
  const list = $('chat-list');
  if (!list) return;
  const mode = currentMode();
  const q = state.search.trim().toLowerCase();
  let items = state.chats.slice();
  if (mode.layout?.filterChatsByMode) {
    items = items.filter((c) => !c.modeId || c.modeId === mode.id || legacyModeMatch(c.modeId, mode.id));
  }
  if (q) {
    items = items.filter((c) => (c.title || '').toLowerCase().includes(q) || (c.preview || '').toLowerCase().includes(q));
  }
  if (!items.length && !state.folders.length) {
    list.innerHTML = `<p class="muted sm" style="padding:12px">No ${mode.name.toLowerCase()} chats yet</p>`;
    return;
  }

  const folderIds = new Set(state.folders.map((f) => f.id));
  const byFolder = new Map();
  for (const f of state.folders) byFolder.set(f.id, []);
  const unfiled = [];
  for (const c of items) {
    if (c.folderId && folderIds.has(c.folderId)) byFolder.get(c.folderId).push(c);
    else unfiled.push(c);
  }

  const parts = [];
  for (const folder of state.folders) {
    const chats = byFolder.get(folder.id) || [];
    if (q && !chats.length) continue;
    const collapsed = Boolean(folder.collapsed);
    const active = state.activeFolderId === folder.id;
    const swatch = folder.color
      ? `<span class="folder-swatch" style="background:${escapeHtml(folder.color)}"></span>`
      : `<span class="folder-swatch muted-swatch"></span>`;
    parts.push(`
      <div class="folder-group${active ? ' active-folder' : ''}${collapsed ? ' collapsed' : ''}" data-folder-id="${escapeHtml(folder.id)}">
        <div class="folder-header">
          <button type="button" class="folder-caret-btn" data-folder-toggle="${escapeHtml(folder.id)}" aria-expanded="${collapsed ? 'false' : 'true'}" title="${collapsed ? 'Expand' : 'Collapse'}">
            <span class="folder-caret">${collapsed ? '▸' : '▾'}</span>
          </button>
          <button type="button" class="folder-toggle" data-folder-activate="${escapeHtml(folder.id)}" title="New chats go here">
            ${swatch}
            <strong class="folder-name">${escapeHtml(folder.name || 'Folder')}</strong>
            <span class="folder-count">${chats.length}</span>
          </button>
          <div class="folder-actions">
            <button type="button" class="thread-action" data-folder-action="settings" data-folder-id="${escapeHtml(folder.id)}" title="Folder settings" aria-label="Folder settings">Edit</button>
          </div>
        </div>
        <div class="folder-chats"${collapsed ? ' hidden' : ''}>
          ${chats.length ? chats.map(renderThreadItem).join('') : `<p class="muted sm folder-empty">Empty folder</p>`}
        </div>
      </div>`);
  }

  if (!q || unfiled.length) {
    const unfiledActive = state.activeFolderId === null;
    parts.push(`
      <div class="folder-group unfiled${unfiledActive ? ' active-folder' : ''}" data-folder-id="">
        <div class="folder-header">
          <button type="button" class="folder-toggle" data-folder-activate-unfiled="1" title="Unfiled chats">
            <span class="folder-caret">·</span>
            <strong class="folder-name">Unfiled</strong>
            <span class="folder-count">${unfiled.length}</span>
          </button>
        </div>
        <div class="folder-chats">
          ${unfiled.length ? unfiled.map(renderThreadItem).join('') : `<p class="muted sm folder-empty">No unfiled chats</p>`}
        </div>
      </div>`);
  }

  if (!parts.length) {
    list.innerHTML = `<p class="muted sm" style="padding:12px">No ${mode.name.toLowerCase()} chats yet</p>`;
    return;
  }
  list.innerHTML = parts.join('');
}

const threadActionInflight = new Set();

async function togglePinChat(id) {
  if (threadActionInflight.has(id)) return;
  threadActionInflight.add(id);
  try {
    const summary = state.chats.find((c) => c.id === id);
    const currentlyPinned = Boolean(
      summary?.pinned ?? (state.chat?.id === id ? state.chat.pinned : false),
    );
    const next = await api(`/api/chats/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned: !currentlyPinned }),
    });
    // Pin is metadata-only — avoid patchChat's full conversation re-render
    if (state.chat?.id === id) state.chat = next;
    await loadChats();
  } finally {
    threadActionInflight.delete(id);
  }
}

async function deleteChatFromList(id) {
  if (threadActionInflight.has(id)) return;
  threadActionInflight.add(id);
  try {
    if (!confirm('Delete this chat?')) return;
    await api(`/api/chats/${id}`, { method: 'DELETE' });
    if (state.chat?.id === id) await selectChat(null);
    await loadChats();
  } finally {
    threadActionInflight.delete(id);
  }
}

function legacyModeMatch(chatMode, activeMode) {
  const map = { personal: 'chat', coding: 'code', business: 'chat', rp: 'story' };
  return map[chatMode] === activeMode;
}

function syncComposerSelects() {
  const folder = state.chat?.folderId ? folderById(state.chat.folderId) : null;
  fillSelect(
    $('model-select'),
    state.models.map((m) => ({ id: m, name: m })),
    'id',
    'name',
    null,
    state.chat?.model || folder?.model || state.settings?.defaultModel,
  );
  fillSelect(
    $('character-select'),
    state.characters,
    'id',
    'name',
    'No character',
    state.chat?.characterId || state.settings?.defaultCharacterId,
  );
  fillSelect(
    $('persona-select'),
    state.personas,
    'id',
    'name',
    'No persona',
    state.chat?.personaId || state.settings?.defaultPersonaId,
  );
  fillSelect($('chat-set-preset'), state.presets, 'id', 'name', 'No preset', state.chat?.presetId || state.settings?.defaultPresetId);
}

function renderConversation() {
  const empty = $('empty-state');
  const convo = $('conversation');
  if (!state.chat) {
    empty?.classList.remove('hidden');
    convo?.classList.add('hidden');
    if ($('chat-title')) $('chat-title').textContent = 'Personal WebUI';
    if ($('chat-subtitle')) $('chat-subtitle').textContent = currentMode().name;
    renderCompanionPanel();
    renderSceneHeader();
    return;
  }
  empty?.classList.add('hidden');
  convo?.classList.remove('hidden');
  if ($('chat-title')) $('chat-title').textContent = state.chat.title || 'Chat';
  if ($('chat-subtitle')) {
    $('chat-subtitle').textContent = [getModeName(state.chat.modeId || state.settings?.activeMode), state.chat.model]
      .filter(Boolean)
      .join(' · ');
  }

  const showTs = state.settings?.showTimestamps !== false;
  const showAv = state.settings?.showAvatars !== false;
  const msgs = state.chat.messages || [];
  convo.innerHTML = msgs
    .map((m) => {
      const who = m.role === 'user' ? personaName(state.chat.personaId) : characterName(state.chat.characterId) || 'Assistant';
      const initial = (who || m.role).slice(0, 1).toUpperCase();
      const showAssistantAvatar = m.role === 'assistant' && showAv;
      return `
      <article class="message ${escapeHtml(m.role)}${m.streaming ? ' streaming' : ''}" data-msg-id="${escapeHtml(m.id || '')}">
        ${showAssistantAvatar ? `<div class="avatar" aria-hidden="true">${escapeHtml(initial)}</div>` : m.role === 'assistant' ? `<div class="avatar" aria-hidden="true">✦</div>` : ''}
        <div class="message-main">
          <div class="message-label"><strong>${escapeHtml(who)}</strong>${showTs ? `<span>${escapeHtml(formatTime(m.createdAt))}</span>` : ''}</div>
          <div class="message-bubble">
            <div class="message-body">${simpleMarkdown(m.content || '')}</div>
            ${m.streaming ? '' : `<div class="message-actions">
              <button type="button" class="msg-action" data-copy-msg="${escapeHtml(m.id || '')}">Copy</button>
              ${m.role === 'assistant' ? `<button type="button" class="msg-action" data-regen-msg="${escapeHtml(m.id || '')}"${state.generating || state.imageGenerating ? ' disabled' : ''}>Regenerate</button>
              <button type="button" class="msg-action" data-branch-msg="${escapeHtml(m.id || '')}"${state.generating || state.imageGenerating ? ' disabled' : ''}>Branch</button>` : ''}
            </div>`}
          </div>
        </div>
      </article>`;
    })
    .join('');

  convo.querySelectorAll('[data-copy-msg]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-copy-msg');
      const msg = (state.chat?.messages || []).find((m) => m.id === id);
      if (msg?.content) copyText(msg.content);
    });
  });
  convo.querySelectorAll('[data-regen-msg]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-regen-msg');
      if (id) regenerateMessage(id).catch((err) => toast(err.message || 'Regenerate failed'));
    });
  });
  convo.querySelectorAll('[data-branch-msg]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-branch-msg');
      if (id) branchFromMessage(id).catch((err) => toast(err.message || 'Branch failed'));
    });
  });
  bindCodeBlockTools(convo);
  renderCodeProposals(convo, msgs);

  requestAnimationFrame(() => {
    const pane = $('main-pane');
    if (pane) pane.scrollTop = pane.scrollHeight;
  });
  renderCompanionPanel();
  renderCastRail();
  renderSceneHeader();
  renderCharacterCard();
  if (currentMode().layout?.showCodeStage && state.chat?.id) {
    loadWorkspace().catch(() => {});
  }
}

function renderCodeProposals(convo, msgs) {
  if (!convo || currentMode().id !== 'code') return;
  const lastAssistant = [...(msgs || [])].reverse().find((m) => m.role === 'assistant' && !m.streaming && m.content);
  if (!lastAssistant) return;
  if (state.dismissedProposals.has(lastAssistant.id)) return;
  const fences = extractPathFences(lastAssistant.content);
  if (!fences.length) return;
  const card = document.createElement('div');
  card.className = 'code-proposal';
  card.innerHTML = `
    <div class="code-proposal-head">
      <strong>${fences.length} file${fences.length === 1 ? '' : 's'} proposed</strong>
      <span class="muted">${fences.map((f) => escapeHtml(f.path)).join(' · ')}</span>
    </div>
    <div class="code-proposal-actions">
      <button type="button" class="btn-primary sm" data-apply-all>Apply all</button>
      <button type="button" class="btn-secondary sm" data-download-proposal>Download zip</button>
      <button type="button" class="btn-secondary sm" data-dismiss-proposal>Dismiss</button>
    </div>`;
  const article = convo.querySelector(`[data-msg-id="${CSS.escape(lastAssistant.id)}"] .message-main`);
  if (article) article.appendChild(card);
  else convo.appendChild(card);
  card.querySelector('[data-apply-all]')?.addEventListener('click', async () => {
    try {
      for (const f of fences) await applyWorkspaceFile(f.path, f.content, { quiet: true });
      toast(`Applied ${fences.length} file${fences.length === 1 ? '' : 's'}`);
      state.dismissedProposals.add(lastAssistant.id);
      card.remove();
      await loadWorkspace();
    } catch (err) {
      toast(err.message || 'Apply failed');
    }
  });
  card.querySelector('[data-dismiss-proposal]')?.addEventListener('click', () => {
    state.dismissedProposals.add(lastAssistant.id);
    card.remove();
  });
  card.querySelector('[data-download-proposal]')?.addEventListener('click', async () => {
    try {
      for (const f of fences) await applyWorkspaceFile(f.path, f.content, { quiet: true });
      await exportWorkspaceZip();
      toast('Exported zip');
    } catch (err) {
      toast(err.message || 'Export failed');
    }
  });
}

async function loadLibrary() {
  const [chars, personas, presets, models] = await Promise.all([
    api('/api/characters'),
    api('/api/personas'),
    api('/api/presets'),
    api('/api/models'),
  ]);
  state.characters = chars.items || [];
  state.personas = personas.items || [];
  state.presets = presets.items || [];
  state.models = models.models || [];
  syncComposerSelects();
}

async function loadFolders() {
  const data = await api('/api/folders');
  state.folders = data.items || [];
  if (state.activeFolderId && !state.folders.some((f) => f.id === state.activeFolderId)) {
    state.activeFolderId = null;
  }
  renderChatList();
}

async function loadChats() {
  const data = await api('/api/chats');
  state.chats = data.items || [];
  renderChatList();
}

function fillFolderSelect(el, selected, { includeUnfiled = true } = {}) {
  if (!el) return;
  const opts = [];
  if (includeUnfiled) opts.push(`<option value="">Unfiled</option>`);
  for (const f of state.folders) {
    opts.push(
      `<option value="${escapeHtml(f.id)}"${String(f.id) === String(selected || '') ? ' selected' : ''}>${escapeHtml(f.name || 'Folder')}</option>`,
    );
  }
  el.innerHTML = opts.join('');
}

async function createFolder() {
  const name = prompt('Folder name', 'New folder');
  if (name == null) return;
  const trimmed = String(name).trim().slice(0, 80) || 'New folder';
  const folder = await api('/api/folders', {
    method: 'POST',
    body: JSON.stringify({ name: trimmed }),
  });
  state.folders.push(folder);
  state.folders.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
  state.activeFolderId = folder.id;
  renderChatList();
  openFolderSettings(folder.id);
  toast('Folder created');
}

const folderCollapseInflight = new Set();

async function toggleFolderCollapsed(folderId) {
  if (folderCollapseInflight.has(folderId)) return;
  const folder = folderById(folderId);
  if (!folder) return;
  folderCollapseInflight.add(folderId);
  try {
    const next = await api(`/api/folders/${folderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ collapsed: !folder.collapsed }),
    });
    const idx = state.folders.findIndex((f) => f.id === folderId);
    if (idx >= 0) state.folders[idx] = next;
    renderChatList();
  } finally {
    folderCollapseInflight.delete(folderId);
  }
}

/** Persist model only when chat already overrides inherit, or user picks a non-inherited value. */
function modelPatchForChat() {
  const selected = $('model-select')?.value || '';
  if (!selected) return {};
  if (state.chat?.model) return { model: selected };
  const folder = state.chat?.folderId ? folderById(state.chat.folderId) : null;
  const inherited = folder?.model || state.settings?.defaultModel || '';
  if (selected !== inherited) return { model: selected };
  return {};
}

function openFolderSettings(folderId) {
  const folder = folderById(folderId);
  if (!folder) return;
  $('folder-set-id').value = folder.id;
  $('folder-set-name').value = folder.name || '';
  $('folder-set-color').value = folder.color || '';
  $('folder-set-system').value = folder.systemPrompt || '';
  $('folder-set-style').value = folder.stylePrompt || '';
  $('folder-set-model').value = folder.model || '';
  $('folder-set-temp').value = folder.temperature ?? '';
  $('folder-set-top-p').value = folder.topP ?? '';
  $('folder-set-max-tokens').value = folder.maxTokens ?? '';
  fillSelect($('folder-set-preset'), state.presets, 'id', 'name', 'Inherit / none', folder.presetId);
  const dl = $('folder-model-list');
  if (dl) dl.innerHTML = state.models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
  openModal('folder-modal');
}

function openMoveFolderModal(chatId) {
  const summary = state.chats.find((c) => c.id === chatId);
  $('move-chat-id').value = chatId;
  fillFolderSelect($('move-folder-select'), summary?.folderId || null);
  openModal('move-folder-modal');
}

async function moveChatToFolder(chatId, folderId) {
  const next = await api(`/api/chats/${chatId}`, {
    method: 'PATCH',
    body: JSON.stringify({ folderId: folderId || null }),
  });
  if (state.chat?.id === chatId) state.chat = next;
  await loadChats();
  toast(folderId ? 'Moved to folder' : 'Moved to Unfiled');
}

async function loadGallery() {
  try {
    const data = await api('/api/gallery');
    state.gallery = data.items || [];
    renderStudioStage();
    return state.gallery;
  } catch {
    state.gallery = [];
    return [];
  }
}

async function selectChat(id) {
  if (!id) {
    state.chat = null;
    resetWorkspaceState();
    renderConversation();
    renderChatList();
    renderCodeStage();
    return;
  }
  const chat = await api(`/api/chats/${id}`);
  state.chat = chat;
  state.dismissedProposals = new Set();
  syncComposerSelects();
  renderConversation();
  renderChatList();
  if (currentMode().layout?.showCodeStage) await loadWorkspace().catch(() => {});
}

async function createChat(seedPrompt) {
  const mode = currentMode();
  const characterId = mode.layout?.showCharacter
    ? $('character-select')?.value || $('companion-character-select')?.value || state.settings?.defaultCharacterId || null
    : null;
  const personaId = mode.layout?.showPersona
    ? $('persona-select')?.value || $('companion-persona-select')?.value || state.settings?.defaultPersonaId || null
    : null;
  const model =
    $('model-select')?.value ||
    state.settings?.defaultModel ||
    state.llm?.providers?.find((p) => p.id === state.llm?.activeProviderId)?.defaultModel ||
    '';
  const folderId = state.activeFolderId || null;
  const payload = {
    characterId,
    personaId,
    modeId: mode.id,
    folderId,
  };
  if (!folderId) {
    payload.model = model || undefined;
    payload.temperature = mode.defaults?.temperature;
    payload.topP = mode.defaults?.topP;
    payload.maxTokens = mode.defaults?.maxTokens;
  }
  const chat = await api('/api/chats', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  state.chat = chat;
  state.dismissedProposals = new Set();
  await loadChats();
  renderConversation();
  syncComposerSelects();
  if (mode.layout?.showCodeStage) await loadWorkspace().catch(() => {});
  if (seedPrompt) {
    $('message').value = seedPrompt;
    await sendMessage();
  }
}

async function patchChat(partial) {
  if (!state.chat) return;
  const next = await api(`/api/chats/${state.chat.id}`, {
    method: 'PATCH',
    body: JSON.stringify(partial),
  });
  state.chat = next;
  await loadChats();
  renderConversation();
  syncComposerSelects();
}

function looksLikeImageRequest(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  // Clear image asks
  if (/\b(pic|picture|photo|selfie|image|illustration|render|drawing|artwork|portrait)\b/i.test(t) &&
      /\b(make|send|draw|generate|create|give|show|want|need|another|more|of)\b/i.test(t)) {
    return true;
  }
  if (/^(gen(erate)?|draw|paint)\b/i.test(t)) return true;
  if (/\b(comfy|txt2img)\b/i.test(t)) return true;
  // Casual NSFW / character pic shorthand
  if (/\b(nsfw|waifu|husbando)\b/i.test(t) &&
      /\b(pic|picture|photo|selfie|image|draw|gen)\b/i.test(t)) {
    return true;
  }
  return false;
}

function imageGenAvailable() {
  // Code mode is for files — never divert to Comfy. Other modes may when enabled.
  if (currentMode().id === 'code' || currentMode().layout?.showCodeStage) return false;
  return state.settings?.comfy?.enabled !== false;
}

async function sendImageRequest(idea) {
  if (!state.chat) await createChat();
  const mode = currentMode();
  await patchChat({
    ...modelPatchForChat(),
    characterId: mode.layout?.showCharacter ? $('character-select')?.value || null : state.chat.characterId,
    personaId: mode.layout?.showPersona ? $('persona-select')?.value || null : state.chat.personaId,
  });

  state.generating = true;
  state.imageGenerating = true;
  $('stop-gen')?.classList.remove('hidden');
  setStatus('busy', 'Generating image…');

  // Optimistic UI
  state.chat.messages = [
    ...(state.chat.messages || []),
    { id: 'temp-user', role: 'user', content: idea, createdAt: new Date().toISOString() },
    {
      id: 'temp-assistant',
      role: 'assistant',
      content: 'Generating image…',
      streaming: true,
      createdAt: new Date().toISOString(),
    },
  ];
  renderConversation();

  try {
    const studioOpts = mode.layoutId === 'studio' ? collectStudioGenOptions() : {};
    const result = await api(`/api/chats/${state.chat.id}/generate-image`, {
      method: 'POST',
      body: JSON.stringify({
        idea,
        saveUserMessage: true,
        ...studioOpts,
      }),
    });
    if (result.chat) {
      state.chat = result.chat;
    } else {
      await selectChat(state.chat.id);
    }
    renderConversation();
    await loadChats();
    await loadGallery();
    if (result.image?.url && $('studio-preview')) {
      $('studio-preview').src = result.image.url;
      $('studio-preview').classList.remove('hidden');
      $('studio-empty')?.classList.add('hidden');
    }
    if (result.prompt && $('image-prompt')) $('image-prompt').value = result.prompt;
    if (result.negative && $('studio-negative')) $('studio-negative').value = result.negative;
    setStatus('ok', 'Image ready');
    toast('Image generated');
  } catch (err) {
    if (err.chat) state.chat = err.chat;
    else if (state.chat?.id) await selectChat(state.chat.id).catch(() => {});
    // api() throws Error without chat - reload
    if (state.chat?.id) {
      try {
        state.chat = await api(`/api/chats/${state.chat.id}`);
      } catch {
        /* ignore */
      }
    }
    renderConversation();
    setStatus('err', 'Image failed');
    toast(err.message || 'Image generation failed');
  } finally {
    state.generating = false;
    state.imageGenerating = false;
    $('stop-gen')?.classList.add('hidden');
  }
}

async function regenerateMessage(messageId) {
  if (!state.chat?.id || !messageId || state.generating || state.imageGenerating) return;
  const idx = (state.chat.messages || []).findIndex((m) => m.id === messageId);
  if (idx < 0) return;
  const target = state.chat.messages[idx];
  if (target.role !== 'assistant') return;

  const chatId = state.chat.id;
  const mode = currentMode();
  const modelPatch = modelPatchForChat();
  await patchChat({
    ...modelPatch,
    characterId: mode.layout?.showCharacter ? $('character-select').value || null : state.chat.characterId,
    personaId: mode.layout?.showPersona ? $('persona-select').value || null : state.chat.personaId,
  });
  if (state.chat?.id !== chatId) return;

  state.generating = true;
  $('stop-gen')?.classList.remove('hidden');
  setStatus('busy', 'Regenerating…');

  const kept = state.chat.messages.slice(0, idx);
  const tempAssistant = {
    id: 'temp-assistant',
    role: 'assistant',
    content: '',
    streaming: true,
    createdAt: new Date().toISOString(),
  };
  state.chat.messages = [...kept, tempAssistant];
  renderConversation();

  const stillThisChat = () => state.chat?.id === chatId;

  let streamFailed = false;
  try {
    const res = await fetch(`/api/chats/${chatId}/regenerate`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messageId,
        ...(modelPatch.model ? { model: modelPatch.model } : {}),
        openPath: mode.layout?.showCodeStage ? state.workspace.openPath || undefined : undefined,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        if (!stillThisChat()) continue;
        let event = 'message';
        let data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        if (event === 'truncated') {
          state.chat.messages = Array.isArray(payload.messages) ? [...payload.messages, tempAssistant] : [tempAssistant];
          if (payload.title) state.chat.title = payload.title;
          renderConversation();
        } else if (event === 'delta') {
          tempAssistant.content = payload.content || '';
          renderConversation();
        } else if (event === 'done') {
          state.chat.messages = state.chat.messages.filter((m) => m !== tempAssistant);
          state.chat.messages.push(payload.message);
          if (payload.title) state.chat.title = payload.title;
        } else if (event === 'stopped' || event === 'error') {
          state.chat.messages = state.chat.messages.filter((m) => m !== tempAssistant);
          if (payload.message?.content) state.chat.messages.push(payload.message);
          else if (event === 'error') {
            streamFailed = true;
            state.chat.messages.push({
              id: 'err',
              role: 'assistant',
              content: `Error: ${payload.error || 'failed'}`,
              createdAt: new Date().toISOString(),
            });
            toast(payload.error || 'Regenerate failed');
          }
          if (event === 'error') setStatus('err', 'Error');
        }
      }
    }
    await loadChats();
    if (!stillThisChat()) return;
    if (streamFailed) {
      renderConversation();
    } else {
      await selectChat(chatId);
      setStatus('ok', 'Ready');
    }
  } catch (err) {
    streamFailed = true;
    if (stillThisChat()) {
      state.chat.messages = kept.slice();
      state.chat.messages.push({
        id: 'err',
        role: 'assistant',
        content: `Error: ${err.message}`,
        createdAt: new Date().toISOString(),
      });
      renderConversation();
      setStatus('err', 'Error');
    }
    toast(err.message || 'Regenerate failed');
  } finally {
    state.generating = false;
    $('stop-gen')?.classList.add('hidden');
  }
}

async function branchFromMessage(messageId) {
  if (!state.chat?.id || !messageId || state.generating || state.imageGenerating) return;
  const branched = await api(`/api/chats/${state.chat.id}/branch`, {
    method: 'POST',
    body: JSON.stringify({ messageId }),
  });
  await loadChats();
  await selectChat(branched.id);
  toast('Branched chat');
}

async function sendMessage() {
  const input = $('message');
  const content = input.value.trim();
  if (!content || state.generating || state.imageGenerating) return;
  if (!state.chat) await createChat();

  const mode = currentMode();

  // Any mode: pic asks go to Comfy (skips censored cloud chat refusals)
  if (imageGenAvailable() && looksLikeImageRequest(content)) {
    input.value = '';
    input.style.height = 'auto';
    await sendImageRequest(content);
    return;
  }

  if (mode.layout?.showCodeStage && state.workspace.dirty) {
    try {
      await saveWorkspaceFile();
    } catch {
      /* still send; context may be slightly stale */
    }
  }

  const modelPatch = modelPatchForChat();
  await patchChat({
    ...modelPatch,
    characterId: mode.layout?.showCharacter ? $('character-select').value || null : state.chat.characterId,
    personaId: mode.layout?.showPersona ? $('persona-select').value || null : state.chat.personaId,
  });

  input.value = '';
  input.style.height = 'auto';
  state.generating = true;
  $('stop-gen')?.classList.remove('hidden');
  setStatus('busy', 'Thinking…');

  const chatId = state.chat.id;
  const tempUser = { id: 'temp-user', role: 'user', content, createdAt: new Date().toISOString() };
  const tempAssistant = { id: 'temp-assistant', role: 'assistant', content: '', streaming: true, createdAt: new Date().toISOString() };
  state.chat.messages = [...(state.chat.messages || []), tempUser, tempAssistant];
  renderConversation();

  const stillThisChat = () => state.chat?.id === chatId;

  let streamFailed = false;
  try {
    const res = await fetch(`/api/chats/${chatId}/message`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        ...(modelPatch.model ? { model: modelPatch.model } : {}),
        openPath: currentMode().layout?.showCodeStage ? state.workspace.openPath || undefined : undefined,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || res.statusText);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';
      for (const chunk of chunks) {
        if (!stillThisChat()) continue;
        let event = 'message';
        let data = '';
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        if (event === 'user') {
          state.chat.messages = state.chat.messages.filter((m) => m !== tempUser && m !== tempAssistant);
          state.chat.messages.push(payload.message, tempAssistant);
          if (payload.title) state.chat.title = payload.title;
        } else if (event === 'delta') {
          tempAssistant.content = payload.content || '';
          renderConversation();
        } else if (event === 'done') {
          state.chat.messages = state.chat.messages.filter((m) => m !== tempAssistant && m !== tempUser);
          state.chat.messages.push(payload.message);
          if (payload.title) state.chat.title = payload.title;
        } else if (event === 'stopped' || event === 'error') {
          state.chat.messages = state.chat.messages.filter((m) => m !== tempAssistant);
          if (payload.message?.content) state.chat.messages.push(payload.message);
          else if (event === 'error') {
            streamFailed = true;
            state.chat.messages.push({
              id: 'err',
              role: 'assistant',
              content: `Error: ${payload.error || 'failed'}`,
              createdAt: new Date().toISOString(),
            });
            toast(payload.error || 'Generation failed');
          }
          if (event === 'error') setStatus('err', 'Error');
        }
      }
    }
    await loadChats();
    if (!stillThisChat()) return;
    if (streamFailed) {
      renderConversation();
    } else {
      await selectChat(chatId);
      setStatus('ok', 'Ready');
    }
  } catch (err) {
    streamFailed = true;
    if (stillThisChat()) {
      state.chat.messages = (state.chat.messages || []).filter((m) => m !== tempAssistant && m !== tempUser);
      // Keep the real user message if the server already saved it; otherwise keep temp user.
      const hasUser = (state.chat.messages || []).some((m) => m.role === 'user' && m.content === content);
      if (!hasUser) state.chat.messages.push(tempUser);
      state.chat.messages.push({
        id: 'err',
        role: 'assistant',
        content: `Error: ${err.message}`,
        createdAt: new Date().toISOString(),
      });
      renderConversation();
      setStatus('err', 'Error');
    }
    toast(err.message || 'Generation failed');
  } finally {
    state.generating = false;
    $('stop-gen')?.classList.add('hidden');
  }
}

/* Image gen */
function imagePromptEl() {
  if (currentMode().layoutId === 'studio') return $('image-prompt');
  return $('image-prompt-inline') || $('image-prompt');
}
function imageStatusEl() {
  if (currentMode().layoutId === 'studio') return $('image-gen-status');
  return $('image-gen-status-inline') || $('image-gen-status');
}

function collectStudioGenOptions() {
  const loraName = $('studio-lora')?.value || '';
  const loras = loraName
    ? [
        {
          name: loraName,
          weight: Number($('studio-lora-weight')?.value || 0.8),
          trigger: $('studio-lora-trigger')?.value || '',
        },
      ]
    : undefined;
  const seedRaw = $('studio-seed')?.value;
  const seed = seedRaw === '' || seedRaw == null ? -1 : Number(seedRaw);
  return {
    checkpoint: $('studio-checkpoint')?.value || undefined,
    negative: $('studio-negative')?.value ?? state.settings?.comfy?.negative,
    sizePreset: $('studio-size')?.value || undefined,
    style: $('studio-style')?.value || undefined,
    steps: $('studio-steps')?.value ? Number($('studio-steps').value) : undefined,
    cfg: $('studio-cfg')?.value ? Number($('studio-cfg').value) : undefined,
    seed: Number.isFinite(seed) ? seed : -1,
    loras,
  };
}

async function loadComfyAssets(force) {
  if (state.comfyAssets && !force) {
    applyComfyAssets(state.comfyAssets);
    return state.comfyAssets;
  }
  try {
    const assets = await api('/api/comfy/assets');
    state.comfyAssets = assets;
    applyComfyAssets(assets);
    return assets;
  } catch (err) {
    if ($('image-gen-status')) $('image-gen-status').textContent = err.message;
    if ($('comfy-status-label')) {
      $('comfy-status-label').textContent = 'ComfyUI · offline';
      $('comfy-status-label').title = err.message;
    }
    return null;
  }
}

function applyComfyAssets(assets) {
  if (!assets) return;
  const ckpt = $('studio-checkpoint');
  if (ckpt && assets.checkpoints?.length) {
    const current = ckpt.value || state.settings?.comfy?.checkpoint || assets.defaults?.checkpoint;
    ckpt.innerHTML = assets.checkpoints
      .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
      .join('');
    if (current && assets.checkpoints.includes(current)) ckpt.value = current;
  }

  const lora = $('studio-lora');
  if (lora) {
    const current = lora.value;
    const options = ['<option value="">None</option>'].concat(
      (assets.loras || []).slice(0, 400).map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`),
    );
    lora.innerHTML = options.join('');
    if (current && [...lora.options].some((o) => o.value === current)) lora.value = current;
  }

  // Prefs checkpoint list too
  applyComfyModelOptions({
    checkpoints: assets.checkpoints || [],
    samplers: assets.samplers || [],
    schedulers: assets.schedulers || [],
  });

  if ($('studio-negative') && !$('studio-negative').value && assets.defaults?.negative) {
    $('studio-negative').value = assets.defaults.negative;
  }
  if ($('studio-steps') && assets.defaults?.steps) $('studio-steps').value = assets.defaults.steps;
  if ($('studio-cfg') && assets.defaults?.cfg != null) $('studio-cfg').value = assets.defaults.cfg;

  const styles = $('studio-quick-styles');
  if (styles && assets.quickStyles) {
    styles.innerHTML = assets.quickStyles
      .map((s) => `<button type="button" class="studio-style-chip" data-style="${escapeHtml(s.id)}">${escapeHtml(s.label)}</button>`)
      .join('');
  }

  if ($('comfy-status-label')) {
    $('comfy-status-label').textContent = `ComfyUI · ${(assets.checkpoints || []).length} models`;
  }
}

async function generateImage() {
  if (state.imageGenerating) return;
  const prompt = (imagePromptEl()?.value || '').trim();
  const statusEl = imageStatusEl();
  if (!prompt) {
    if (statusEl) statusEl.textContent = 'Enter an image prompt first.';
    return;
  }
  if (!state.chat) await createChat();
  state.imageGenerating = true;
  if (statusEl) statusEl.textContent = 'Queueing on ComfyUI…';
  setStatus('busy', 'Generating image…');
  try {
    const studioOpts = currentMode().layoutId === 'studio' ? collectStudioGenOptions() : {};
    const result = await api('/api/comfy/generate', {
      method: 'POST',
      body: JSON.stringify({
        prompt,
        chatId: state.chat?.id,
        negative: studioOpts.negative ?? state.settings?.comfy?.negative,
        ...studioOpts,
      }),
    });
    if (statusEl) {
      statusEl.textContent = `Done · seed ${result.seed}${result.model ? ` · ${result.model}` : ''}`;
    }
    if (result.seed != null && $('studio-seed') && Number($('studio-seed').value) === -1) {
      // keep -1 for random next time
    }
    if (result.image?.url && $('studio-preview')) {
      $('studio-preview').src = result.image.url;
      $('studio-preview').classList.remove('hidden');
      $('studio-empty')?.classList.add('hidden');
    }
    if (state.chat?.id) await selectChat(state.chat.id);
    await loadChats();
    await loadGallery();
    setStatus('ok', 'Image ready');
  } catch (err) {
    if (statusEl) statusEl.textContent = err.message;
    setStatus('err', 'Image failed');
    throw err;
  } finally {
    state.imageGenerating = false;
  }
}

function fillLlmPrefs(llmCfg = null) {
  const llm = llmCfg || state.llm || state.settings?.llm;
  if (!llm) return;
  state.llm = llm;
  const activeId = llm.activeProviderId;
  const providers = llm.providers || [];
  fillSelect($('pref-llm-active'), providers, 'id', 'name', null, activeId);
  const provider = providers.find((p) => p.id === (state.editingProviderId || activeId)) || providers[0];
  state.editingProviderId = provider?.id || null;
  if ($('pref-llm-active') && state.editingProviderId) $('pref-llm-active').value = state.editingProviderId;
  if ($('pref-llm-name')) $('pref-llm-name').value = provider?.name || '';
  if ($('pref-llm-url')) $('pref-llm-url').value = provider?.baseUrl || '';
  if ($('pref-llm-key')) {
    $('pref-llm-key').value = '';
    $('pref-llm-key').placeholder = provider?.hasApiKey ? 'Saved · leave blank to keep' : 'Optional for local models';
  }
  if ($('pref-llm-requires-key')) $('pref-llm-requires-key').checked = Boolean(provider?.requiresKey);
  if ($('pref-llm-default-model')) {
    $('pref-llm-default-model').value = state.settings?.defaultModel || provider?.defaultModel || '';
  }
  if ($('pref-llm-hint')) {
    const preset = state.llmPresets.find((p) => p.kind === provider?.kind);
    $('pref-llm-hint').textContent = preset?.hint
      || 'Tip: LM Studio and Ollama usually need no key. Base URL should end with /v1.';
  }
  if ($('provider-info')) {
    const active = providers.find((p) => p.id === llm.activeProviderId);
    $('provider-info').textContent = active
      ? `Active: ${active.name} · ${active.baseUrl} · ${active.hasApiKey || !active.requiresKey ? 'ready' : 'needs API key'}`
      : 'No provider configured';
  }
}

function renderLlmPresets() {
  const box = $('llm-presets');
  if (!box) return;
  box.innerHTML = (state.llmPresets || [])
    .map(
      (p) =>
        `<button type="button" class="llm-preset-btn" data-preset="${escapeHtml(p.kind)}" title="${escapeHtml(p.hint || '')}">+ ${escapeHtml(p.name)}</button>`,
    )
    .join('');
}

async function loadLlmPresets() {
  try {
    const data = await api('/api/llm/presets');
    state.llmPresets = data.items || [];
    renderLlmPresets();
  } catch {
    state.llmPresets = [];
  }
}

async function refreshLlmModels(providerId) {
  try {
    const q = providerId ? `?provider=${encodeURIComponent(providerId)}` : '';
    const data = await api(`/api/models${q}`);
    state.models = data.models || [];
    syncComposerSelects();
    const list = $('pref-llm-model-list');
    if (list) {
      list.innerHTML = state.models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
    }
    return data;
  } catch (err) {
    if ($('pref-llm-test-result')) $('pref-llm-test-result').textContent = err.message;
    return null;
  }
}

function collectProviderForm() {
  const id = state.editingProviderId;
  const prev = (state.llm?.providers || []).find((p) => p.id === id) || {};
  const keyVal = $('pref-llm-key')?.value || '';
  return {
    id,
    kind: prev.kind || 'custom',
    name: $('pref-llm-name')?.value?.trim() || prev.name || 'Provider',
    baseUrl: $('pref-llm-url')?.value?.trim() || '',
    apiKey: keyVal || (prev.hasApiKey ? '********' : ''),
    defaultModel: $('pref-llm-default-model')?.value?.trim() || '',
    requiresKey: $('pref-llm-requires-key')?.checked || false,
    enabled: true,
  };
}

function fillComfyPrefs(comfyCfg = {}) {
  if ($('pref-comfy-enabled')) $('pref-comfy-enabled').checked = comfyCfg.enabled !== false;
  if ($('pref-comfy-url')) $('pref-comfy-url').value = comfyCfg.baseUrl || '';
  if ($('pref-comfy-width')) $('pref-comfy-width').value = comfyCfg.width || 832;
  if ($('pref-comfy-height')) $('pref-comfy-height').value = comfyCfg.height || 1216;
  if ($('pref-comfy-steps')) $('pref-comfy-steps').value = comfyCfg.steps || 28;
  if ($('pref-comfy-cfg')) $('pref-comfy-cfg').value = comfyCfg.cfg ?? 5.5;
  if ($('pref-comfy-sampler')) $('pref-comfy-sampler').value = comfyCfg.sampler || 'euler_ancestral';
  if ($('pref-comfy-scheduler')) $('pref-comfy-scheduler').value = comfyCfg.scheduler || 'normal';
  if ($('pref-comfy-negative')) $('pref-comfy-negative').value = comfyCfg.negative || '';
  const sel = $('pref-comfy-checkpoint');
  if (sel && comfyCfg.checkpoint) {
    if (![...sel.options].some((o) => o.value === comfyCfg.checkpoint)) {
      const opt = document.createElement('option');
      opt.value = comfyCfg.checkpoint;
      opt.textContent = comfyCfg.checkpoint;
      sel.appendChild(opt);
    }
    sel.value = comfyCfg.checkpoint;
  }
}

async function loadComfyModelOptions(force) {
  if (state.comfyModels && !force) {
    applyComfyModelOptions(state.comfyModels);
    return state.comfyModels;
  }
  try {
    const models = await api('/api/comfy/models');
    state.comfyModels = models;
    applyComfyModelOptions(models);
    return models;
  } catch (err) {
    if ($('pref-comfy-test-result')) $('pref-comfy-test-result').textContent = err.message;
    return null;
  }
}

function applyComfyModelOptions(models) {
  const sel = $('pref-comfy-checkpoint');
  if (!sel || !models?.checkpoints) return;
  const current = state.settings?.comfy?.checkpoint || sel.value;
  sel.innerHTML = models.checkpoints.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  if (current && models.checkpoints.includes(current)) sel.value = current;
  if (models.samplers?.length && $('pref-comfy-sampler')) {
    const cur = $('pref-comfy-sampler').value;
    $('pref-comfy-sampler').innerHTML = models.samplers.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    if (models.samplers.includes(cur)) $('pref-comfy-sampler').value = cur;
  }
  if (models.schedulers?.length && $('pref-comfy-scheduler')) {
    const cur = $('pref-comfy-scheduler').value;
    $('pref-comfy-scheduler').innerHTML = models.schedulers.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
    if (models.schedulers.includes(cur)) $('pref-comfy-scheduler').value = cur;
  }
}

async function refreshComfyStatus() {
  const label = $('comfy-status-label');
  if (!label) return;
  if (state.settings?.comfy?.enabled === false) {
    label.textContent = 'ComfyUI off';
    return;
  }
  try {
    const status = await api('/api/comfy/status');
    label.textContent = status.ok ? 'ComfyUI · online' : 'ComfyUI · offline';
    label.title = status.ok ? status.baseUrl : status.error || 'offline';
  } catch {
    label.textContent = 'ComfyUI · unknown';
  }
}

/* Library */
function libraryItems() {
  if (state.libraryTab === 'characters') return state.characters;
  if (state.libraryTab === 'personas') return state.personas;
  return state.presets;
}

function renderLibraryList() {
  const list = $('library-list');
  if (!list) return;
  const items = libraryItems();
  list.innerHTML =
    items
      .map(
        (item) =>
          `<button type="button" class="${item.id === state.librarySelectedId ? 'active' : ''}" data-id="${escapeHtml(item.id)}">${escapeHtml(item.name)}</button>`,
      )
      .join('') || '<p class="muted sm" style="padding:10px">Empty</p>';
}

function renderLibraryFields(item) {
  const box = $('lib-fields');
  const kind = state.libraryTab;
  $('lib-id').value = item?.id || '';
  $('lib-kind').value = kind;
  $('lib-name').value = item?.name || '';
  if (kind === 'characters') {
    box.innerHTML = `
      <label>Description <textarea id="lib-description" rows="2">${escapeHtml(item?.description || '')}</textarea></label>
      <label>Personality <textarea id="lib-personality" rows="3">${escapeHtml(item?.personality || '')}</textarea></label>
      <label>Scenario <textarea id="lib-scenario" rows="2">${escapeHtml(item?.scenario || '')}</textarea></label>
      <label>First message <textarea id="lib-first" rows="3">${escapeHtml(item?.firstMessage || '')}</textarea></label>
      <label>Example dialogue <textarea id="lib-examples" rows="3">${escapeHtml(item?.exampleDialogue || '')}</textarea></label>
      <label>System prompt <textarea id="lib-system" rows="3">${escapeHtml(item?.systemPrompt || '')}</textarea></label>
      <label>Tags <input id="lib-tags" type="text" value="${escapeHtml((item?.tags || []).join(', '))}"></label>`;
  } else if (kind === 'personas') {
    box.innerHTML = `
      <label>Description <textarea id="lib-description" rows="2">${escapeHtml(item?.description || '')}</textarea></label>
      <label>About me <textarea id="lib-about" rows="4">${escapeHtml(item?.about || '')}</textarea></label>`;
  } else {
    box.innerHTML = `
      <label>System prompt <textarea id="lib-system" rows="3">${escapeHtml(item?.systemPrompt || '')}</textarea></label>
      <label>Style prompt <textarea id="lib-style" rows="2">${escapeHtml(item?.stylePrompt || '')}</textarea></label>
      <label>Temperature <input id="lib-temp" type="number" min="0" max="2" step="0.05" value="${escapeHtml(item?.temperature ?? 0.8)}"></label>
      <label>Top P <input id="lib-top-p" type="number" min="0" max="1" step="0.05" value="${escapeHtml(item?.topP ?? 0.95)}"></label>
      <label>Max tokens <input id="lib-max" type="number" min="64" max="32000" step="64" value="${escapeHtml(item?.maxTokens ?? 4096)}"></label>`;
  }
}

function selectLibraryItem(id) {
  state.librarySelectedId = id;
  const item = libraryItems().find((i) => i.id === id) || null;
  renderLibraryList();
  renderLibraryFields(item || { name: '' });
}

async function refreshLibraryAndSelect(id) {
  await loadLibrary();
  if (id) selectLibraryItem(id);
  else if (libraryItems()[0]) selectLibraryItem(libraryItems()[0].id);
  else {
    state.librarySelectedId = null;
    renderLibraryList();
    renderLibraryFields({ name: '' });
  }
  applyModeUi();
}

async function saveLibraryItem(e) {
  e.preventDefault();
  const kind = $('lib-kind').value;
  const id = $('lib-id').value;
  let body = { name: $('lib-name').value.trim() };
  if (kind === 'characters') {
    body = {
      ...body,
      description: $('lib-description')?.value || '',
      personality: $('lib-personality')?.value || '',
      scenario: $('lib-scenario')?.value || '',
      firstMessage: $('lib-first')?.value || '',
      exampleDialogue: $('lib-examples')?.value || '',
      systemPrompt: $('lib-system')?.value || '',
      tags: ($('lib-tags')?.value || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    };
  } else if (kind === 'personas') {
    body = { ...body, description: $('lib-description')?.value || '', about: $('lib-about')?.value || '' };
  } else {
    body = {
      ...body,
      systemPrompt: $('lib-system')?.value || '',
      stylePrompt: $('lib-style')?.value || '',
      temperature: Number($('lib-temp')?.value || 0.8),
      topP: Number($('lib-top-p')?.value || 0.95),
      maxTokens: Number($('lib-max')?.value || 4096),
    };
  }
  const pathBase = kind === 'characters' ? '/api/characters' : kind === 'personas' ? '/api/personas' : '/api/presets';
  const saved = id
    ? await api(`${pathBase}/${id}`, { method: 'PUT', body: JSON.stringify(body) })
    : await api(pathBase, { method: 'POST', body: JSON.stringify(body) });
  await refreshLibraryAndSelect(saved.id);
}

async function renderGalleryModal() {
  await loadGallery();
  const grid = $('gallery-grid');
  if (!grid) return;
  const items = state.gallery || [];
  if (!items.length) {
    grid.innerHTML = '<p class="muted">No files yet.</p>';
    return;
  }
  grid.innerHTML = items
    .map((item) => {
      const preview =
        item.kind === 'image'
          ? `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.filename)}" loading="lazy">`
          : `<div style="height:110px;display:grid;place-items:center;color:var(--text-3);font-size:28px">📄</div>`;
      return `<button type="button" class="gallery-item" data-url="${escapeHtml(item.url)}">${preview}<div class="meta">${escapeHtml(item.filename)}</div></button>`;
    })
    .join('');
}

async function uploadFiles(fileList) {
  for (const file of fileList) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    await api('/api/upload', { method: 'POST', body: fd });
  }
  await renderGalleryModal();
  await loadGallery();
}

async function switchMode(activeMode) {
  const next = await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({ activeMode }),
  });
  state.mode = state.modes.find((m) => m.id === activeMode) || state.mode;
  resetWorkspaceState();
  applySettings(next);
  state.chat = null;
  renderConversation();
  renderCodeStage();
  setStatus('ok', `${currentMode().name}`);
}

async function initApp() {
  try {
    state.me = await api('/api/me');
  } catch {
    location.href = '/login.html';
    return;
  }

  if (state.me?.role === 'admin') {
    $('open-admin')?.classList.remove('hidden');
    $('open-admin-footer')?.classList.remove('hidden');
  }

  const [settings, modesPayload] = await Promise.all([api('/api/settings'), api('/api/modes')]);
  state.modes = modesPayload.items || [];
  state.mode = state.modes.find((m) => m.id === (settings.activeMode || modesPayload.activeMode)) || state.modes[0];
  applySettings(settings);

  if ($('pref-theme')) $('pref-theme').value = settings.theme || 'dark';
  if ($('pref-accent')) $('pref-accent').value = settings.accent || 'neutral';
  if ($('pref-density')) $('pref-density').value = settings.density || 'comfortable';
  if ($('pref-chat-width')) $('pref-chat-width').value = settings.chatWidth || 'wide';
  if ($('pref-font-scale')) $('pref-font-scale').value = settings.fontScale || 1;
  if ($('pref-timestamps')) $('pref-timestamps').checked = settings.showTimestamps !== false;
  if ($('pref-avatars')) $('pref-avatars').checked = settings.showAvatars !== false;
  if ($('pref-mode-follow')) $('pref-mode-follow').checked = settings.modeFollowLayout !== false;
  if ($('pref-custom-css')) $('pref-custom-css').value = settings.customCss || '';
  fillComfyPrefs(settings.comfy || {});
  state.llm = settings.llm || state.me.llm || null;
  fillLlmPrefs(state.llm);
  updateProviderChip();
  await loadLlmPresets();

  await loadLibrary();
  await loadFolders();
  await loadChats();
  await loadGallery();
  refreshComfyStatus();
  // Preload studio assets in background
  loadComfyAssets().catch(() => {});
  setStatus('ok', 'Ready');

  // Mode rail
  $('mode-rail')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (btn) switchMode(btn.dataset.mode).catch((err) => alert(err.message));
  });
  $('mode-select')?.addEventListener('change', (e) => switchMode(e.target.value).catch((err) => alert(err.message)));

  // Sidebar
  $('new-chat')?.addEventListener('click', () => createChat());
  $('new-folder')?.addEventListener('click', () => createFolder().catch((err) => toast(err.message || 'Create failed')));
  $('refresh-chats')?.addEventListener('click', () => {
    Promise.all([loadFolders(), loadChats()]).catch((err) => toast(err.message || 'Refresh failed'));
  });
  $('chat-search')?.addEventListener('input', (e) => {
    state.search = e.target.value;
    renderChatList();
  });

  function openSidebar() {
    $('sidebar')?.classList.add('open');
    const scrim = $('sidebar-scrim');
    if (scrim) scrim.hidden = false;
  }
  function closeSidebar() {
    $('sidebar')?.classList.remove('open');
    const scrim = $('sidebar-scrim');
    if (scrim) scrim.hidden = true;
  }
  $('open-sidebar')?.addEventListener('click', openSidebar);
  $('close-sidebar')?.addEventListener('click', closeSidebar);
  $('sidebar-scrim')?.addEventListener('click', closeSidebar);
  $('chat-list')?.addEventListener('click', (e) => {
    const folderAction = e.target.closest('[data-folder-action]');
    if (folderAction) {
      e.preventDefault();
      e.stopPropagation();
      const fid = folderAction.dataset.folderId;
      if (folderAction.dataset.folderAction === 'settings' && fid) openFolderSettings(fid);
      return;
    }
    const toggle = e.target.closest('[data-folder-toggle]');
    if (toggle) {
      e.preventDefault();
      e.stopPropagation();
      const fid = toggle.getAttribute('data-folder-toggle');
      if (fid) toggleFolderCollapsed(fid).catch((err) => toast(err.message || 'Folder update failed'));
      return;
    }
    const activate = e.target.closest('[data-folder-activate]');
    if (activate) {
      e.preventDefault();
      e.stopPropagation();
      const fid = activate.getAttribute('data-folder-activate');
      state.activeFolderId = fid || null;
      renderChatList();
      return;
    }
    if (e.target.closest('[data-folder-activate-unfiled]')) {
      e.preventDefault();
      e.stopPropagation();
      state.activeFolderId = null;
      renderChatList();
      return;
    }
    if (e.target.closest('.thread-actions') || e.target.closest('.folder-actions')) {
      e.preventDefault();
      e.stopPropagation();
      const actionBtn = e.target.closest('[data-thread-action]');
      if (!actionBtn) return;
      const item = actionBtn.closest('[data-chat-id]');
      if (!item) return;
      const id = item.dataset.chatId;
      const action = actionBtn.dataset.threadAction;
      const run =
        action === 'pin'
          ? togglePinChat(id)
          : action === 'delete'
            ? deleteChatFromList(id)
            : action === 'move'
              ? Promise.resolve(openMoveFolderModal(id))
              : null;
      run?.catch((err) => toast(err.message || 'Action failed'));
      return;
    }
    const item = e.target.closest('[data-chat-id]');
    if (item) {
      selectChat(item.dataset.chatId);
      if (window.matchMedia('(max-width: 960px)').matches) closeSidebar();
    }
  });

  // Companion / cast
  $('companion-character-select')?.addEventListener('change', async (e) => {
    if (!state.chat) await createChat();
    await patchChat({ characterId: e.target.value || null });
    if ($('character-select')) $('character-select').value = e.target.value;
  });
  $('companion-persona-select')?.addEventListener('change', async (e) => {
    if (!state.chat) await createChat();
    await patchChat({ personaId: e.target.value || null });
    if ($('persona-select')) $('persona-select').value = e.target.value;
  });
  $('save-companion-notes')?.addEventListener('click', async () => {
    if (!state.chat) await createChat();
    await patchChat({ storyNotes: $('companion-notes').value });
    setStatus('ok', 'Notes saved');
  });
  $('cast-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-char-id]');
    if (!btn) return;
    if (!state.chat) await createChat();
    await patchChat({ characterId: btn.dataset.charId });
    if ($('character-select')) $('character-select').value = btn.dataset.charId;
  });

  // Composer
  const ta = $('message');
  ta?.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(180, ta.scrollHeight) + 'px';
  });
  ta?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('composer-form').requestSubmit();
    }
  });
  $('composer-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });
  $('stop-gen')?.addEventListener('click', async () => {
    if (!state.chat) return;
    await api(`/api/chats/${state.chat.id}/stop`, { method: 'POST', body: '{}' });
  });

  // Image gen
  $('open-image-gen')?.addEventListener('click', () => {
    $('image-gen-panel')?.classList.toggle('hidden');
    const el = imagePromptEl();
    if (el && !el.value && state.chat?.messages?.length) {
      const lastUser = [...state.chat.messages].reverse().find((m) => m.role === 'user');
      if (lastUser) el.value = lastUser.content.slice(0, 800);
    }
  });
  $('toggle-image-gen')?.addEventListener('click', () => $('image-gen-panel')?.classList.add('hidden'));
  /**
   * Pull a real image prompt from chat — not the casual "make me a pic…" request.
   * Prefer: imageGen metadata → Prompt:/Negative sections → gallery prompt → tag-like assistant text.
   */
  function extractPromptBlock(text, labelRe) {
    const raw = String(text || '');
    // Require a colon so we don't match the word "prompt" inside sentences.
    // Supports: **Prompt:** / Prompt: / > quoted body / until next labeled section
    const re = new RegExp(
      `(?:\\*\\*)?${labelRe}(?:\\*\\*)?\\s*:\\s*(?:\\n\\s*>\\s*|\\n\\s*|\\s*>\\s*|\\s*)([\\s\\S]*?)(?=\\n\\s*(?:\\*\\*)?(?:Negative(?:\\s+prompt)?|Positive(?:\\s+prompt)?|Optional|Composition|Notes?|Style(?:\\s+add-ons)?)(?:\\s*\\([^)]*\\))?(?:\\*\\*)?\\s*:|$)`,
      'i',
    );
    const m = raw.match(re);
    if (!m) return '';
    return m[1]
      .replace(/^>\s?/gm, '')
      .replace(/^```(?:\w+)?\n?|\n?```$/g, '')
      .replace(/\*\*/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function looksLikeImagePrompt(text) {
    const t = String(text || '').trim();
    if (!t || t.length < 24) return false;
    // Casual requests
    if (/^(make|send|draw|generate|create|give)\s+me\s+(a\s+)?(pic|picture|image|photo)/i.test(t)) return false;
    if (/\b(can you|please)\b.*\b(pic|picture|image|draw|generate)\b/i.test(t) && t.length < 160) return false;
    // Tag / prompt-like
    const commas = (t.match(/,/g) || []).length;
    if (commas >= 3) return true;
    if (/^(1girl|1boy|solo|masterpiece|best quality|anime|photorealistic)\b/i.test(t)) return true;
    if (t.length > 80 && !/[?]/.test(t) && commas >= 1) return true;
    return false;
  }

  function extractImagePromptFromChat(messages) {
    const msgs = [...(messages || [])].reverse();

    // 1) Last generated image message with stored prompt
    for (const m of msgs) {
      if (m.imageGen?.prompt) {
        return {
          prompt: String(m.imageGen.prompt).trim(),
          negative: String(m.imageGen.negative || '').trim(),
          source: 'last generation',
        };
      }
    }

    // 2) Assistant wrote Prompt: / Negative prompt: sections
    for (const m of msgs) {
      if (m.role !== 'assistant') continue;
      const content = String(m.content || '');
      if (content.startsWith('![')) {
        // italic caption after generated image markdown
        const italic = content.match(/\n\*([^*]+)\*/);
        if (italic && looksLikeImagePrompt(italic[1])) {
          return { prompt: italic[1].replace(/…$/, '').trim(), negative: '', source: 'image caption' };
        }
        continue;
      }
      const positive =
        extractPromptBlock(content, 'Positive(?:\\s+prompt)?(?:\\s*\\([^)]*\\))?') ||
        extractPromptBlock(content, 'Prompt(?:\\s*\\([^)]*\\))?');
      const negative = extractPromptBlock(content, 'Negative(?:\\s+prompt)?(?:\\s*\\([^)]*\\))?');
      if (positive && looksLikeImagePrompt(positive)) {
        return { prompt: positive.slice(0, 2500), negative: negative.slice(0, 2000), source: 'assistant prompt' };
      }
      // fenced code block that looks like a prompt
      const fence = content.match(/```(?:\w+)?\n([\s\S]*?)```/);
      if (fence && looksLikeImagePrompt(fence[1])) {
        return { prompt: fence[1].trim().slice(0, 2500), negative: negative.slice(0, 2000), source: 'assistant code block' };
      }
      if (looksLikeImagePrompt(content)) {
        return { prompt: content.trim().slice(0, 2500), negative: '', source: 'assistant message' };
      }
    }

    // 3) Gallery item linked from chat
    for (const m of msgs) {
      const att = (m.attachments || []).find((a) => a.kind === 'image' && a.id);
      if (!att) continue;
      const g = (state.gallery || []).find((x) => x.id === att.id || x.url === att.url);
      if (g?.prompt) {
        return {
          prompt: String(g.prompt).trim(),
          negative: String(g.negative || '').trim(),
          source: 'gallery',
        };
      }
    }

    // 4) Last user message only if it already looks like a prompt (not a casual request)
    const lastUser = msgs.find((m) => m.role === 'user');
    if (lastUser && looksLikeImagePrompt(lastUser.content)) {
      return { prompt: String(lastUser.content).trim().slice(0, 2500), negative: '', source: 'user prompt' };
    }

    return null;
  }

  async function fillStudioFromChat() {
    const statusEl = imageStatusEl();
    const extracted = extractImagePromptFromChat(state.chat?.messages || []);
    if (extracted?.prompt) {
      if ($('image-prompt')) $('image-prompt').value = extracted.prompt;
      if ($('image-prompt-inline')) $('image-prompt-inline').value = extracted.prompt;
      if (extracted.negative && $('studio-negative')) $('studio-negative').value = extracted.negative;
      if (statusEl) statusEl.textContent = `Filled from ${extracted.source}`;
      return;
    }

    // Casual request → ask the LLM to write a Comfy-ready prompt
    const lastUser = [...(state.chat?.messages || [])].reverse().find((m) => m.role === 'user');
    const idea = (lastUser?.content || '').trim();
    if (!idea) {
      if (statusEl) statusEl.textContent = 'No chat message to convert.';
      return;
    }
    if (statusEl) statusEl.textContent = 'Turning your request into an image prompt…';
    try {
      const data = await api('/api/comfy/prompt-from-chat', {
        method: 'POST',
        body: JSON.stringify({ idea, chatId: state.chat?.id }),
      });
      if ($('image-prompt')) $('image-prompt').value = data.prompt || '';
      if ($('image-prompt-inline')) $('image-prompt-inline').value = data.prompt || '';
      if ($('studio-negative') && data.negative) $('studio-negative').value = data.negative;
      if (statusEl) statusEl.textContent = 'Converted chat request → prompt';
    } catch (err) {
      // Last resort: don't dump raw "make me a pic" into positive — leave a hint
      if (statusEl) statusEl.textContent = err.message || 'Could not convert request';
    }
  }

  $('image-use-last')?.addEventListener('click', () => fillStudioFromChat().catch(() => {}));
  $('image-use-last-inline')?.addEventListener('click', () => fillStudioFromChat().catch(() => {}));
  const runGen = () => generateImage().catch(() => {});
  $('image-generate')?.addEventListener('click', runGen);
  $('image-generate-inline')?.addEventListener('click', runGen);
  $('studio-refresh-assets')?.addEventListener('click', async () => {
    if ($('image-gen-status')) $('image-gen-status').textContent = 'Refreshing ComfyUI assets…';
    const assets = await loadComfyAssets(true);
    if ($('image-gen-status')) {
      $('image-gen-status').textContent = assets
        ? `${assets.checkpoints?.length || 0} models · ${assets.loras?.length || 0} LoRAs`
        : 'Could not load assets';
    }
  });
  $('studio-quick-styles')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-style]');
    if (!btn) return;
    if ($('studio-style')) $('studio-style').value = btn.dataset.style;
    $('studio-quick-styles').querySelectorAll('.studio-style-chip').forEach((el) => {
      el.classList.toggle('active', el.dataset.style === btn.dataset.style);
    });
  });
  $('studio-style')?.addEventListener('change', () => {
    const val = $('studio-style').value;
    $('studio-quick-styles')?.querySelectorAll('.studio-style-chip').forEach((el) => {
      el.classList.toggle('active', el.dataset.style === val);
    });
  });

  // Modals
  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });
  document.querySelectorAll('.modal').forEach((modal) => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.classList.add('hidden');
    });
  });

  $('open-prefs')?.addEventListener('click', async () => {
    fillComfyPrefs(state.settings?.comfy || {});
    fillLlmPrefs(state.settings?.llm || state.llm);
    openModal('prefs-modal');
    loadComfyModelOptions().catch(() => {});
    loadLlmPresets().catch(() => {});
    refreshLlmModels(state.editingProviderId || state.llm?.activeProviderId).catch(() => {});
  });
  $('open-tip')?.addEventListener('click', () => openModal('tip-modal'));
  $('open-chat-settings')?.addEventListener('click', () => {
    if (!state.chat) return;
    $('chat-set-title').value = state.chat.title || '';
    $('chat-set-temp').value = state.chat.temperature ?? '';
    $('chat-set-top-p').value = state.chat.topP ?? '';
    $('chat-set-max-tokens').value = state.chat.maxTokens ?? '';
    $('chat-set-notes').value = state.chat.storyNotes || '';
    fillSelect($('chat-set-preset'), state.presets, 'id', 'name', 'No preset', state.chat.presetId);
    fillFolderSelect($('chat-set-folder'), state.chat.folderId || null);
    openModal('chat-modal');
  });

  $('save-prefs')?.addEventListener('click', async () => {
    // Persist currently edited provider + active selection before general prefs
    try {
      if (state.editingProviderId) {
        const form = collectProviderForm();
        const saved = await api(`/api/llm/providers/${state.editingProviderId}`, {
          method: 'PUT',
          body: JSON.stringify({
            ...form,
            makeActive: $('pref-llm-active')?.value === state.editingProviderId,
          }),
        });
        state.llm = saved.llm;
      }
      if ($('pref-llm-active')?.value && $('pref-llm-active').value !== state.llm?.activeProviderId) {
        const act = await api('/api/llm/active', {
          method: 'POST',
          body: JSON.stringify({ providerId: $('pref-llm-active').value }),
        });
        state.llm = act.llm;
      }
    } catch (err) {
      alert(err.message);
      return;
    }

    const body = {
      theme: $('pref-theme').value,
      accent: $('pref-accent').value,
      density: $('pref-density').value,
      chatWidth: $('pref-chat-width').value,
      fontScale: Number($('pref-font-scale').value),
      showTimestamps: $('pref-timestamps').checked,
      showAvatars: $('pref-avatars').checked,
      modeFollowLayout: $('pref-mode-follow')?.checked !== false,
      customCss: $('pref-custom-css').value,
      defaultModel: $('pref-llm-default-model')?.value?.trim() || state.settings?.defaultModel,
      comfy: {
        enabled: $('pref-comfy-enabled')?.checked !== false,
        baseUrl: $('pref-comfy-url')?.value || '',
        checkpoint: $('pref-comfy-checkpoint')?.value || '',
        width: Number($('pref-comfy-width')?.value || 832),
        height: Number($('pref-comfy-height')?.value || 1216),
        steps: Number($('pref-comfy-steps')?.value || 28),
        cfg: Number($('pref-comfy-cfg')?.value || 5.5),
        sampler: $('pref-comfy-sampler')?.value || 'euler_ancestral',
        scheduler: $('pref-comfy-scheduler')?.value || 'normal',
        negative: $('pref-comfy-negative')?.value || '',
      },
    };
    const next = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    applySettings(next);
    state.llm = next.llm || state.llm;
    fillLlmPrefs(state.llm);
    await refreshLlmModels(state.llm?.activeProviderId);
    renderConversation();
    refreshComfyStatus();
    closeModal('prefs-modal');
  });

  $('pref-llm-active')?.addEventListener('change', async (e) => {
    state.editingProviderId = e.target.value;
    fillLlmPrefs(state.llm);
    try {
      await api('/api/llm/active', {
        method: 'POST',
        body: JSON.stringify({ providerId: e.target.value }),
      });
      const settings = await api('/api/settings');
      applySettings(settings);
      state.llm = settings.llm;
      fillLlmPrefs(state.llm);
      await refreshLlmModels(e.target.value);
      if ($('pref-llm-test-result')) $('pref-llm-test-result').textContent = `Switched to ${e.target.selectedOptions[0]?.text || e.target.value}`;
    } catch (err) {
      if ($('pref-llm-test-result')) $('pref-llm-test-result').textContent = err.message;
    }
  });

  $('llm-presets')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    try {
      const created = await api('/api/llm/providers', {
        method: 'POST',
        body: JSON.stringify({ preset: btn.dataset.preset, makeActive: true }),
      });
      state.llm = created.llm;
      state.editingProviderId = created.provider.id;
      const settings = await api('/api/settings');
      applySettings(settings);
      state.llm = settings.llm;
      fillLlmPrefs(state.llm);
      await refreshLlmModels(created.provider.id);
      if ($('pref-llm-test-result')) {
        $('pref-llm-test-result').textContent = `Added ${created.provider.name}. ${created.provider.requiresKey ? 'Paste an API key, then Test.' : 'Click Test to check the local server.'}`;
      }
    } catch (err) {
      if ($('pref-llm-test-result')) $('pref-llm-test-result').textContent = err.message;
    }
  });

  $('pref-llm-test')?.addEventListener('click', async () => {
    const el = $('pref-llm-test-result');
    el.textContent = 'Testing…';
    try {
      const form = collectProviderForm();
      const result = await api('/api/llm/test', {
        method: 'POST',
        body: JSON.stringify({
          providerId: form.id,
          baseUrl: form.baseUrl,
          apiKey: form.apiKey === '********' ? undefined : form.apiKey,
          defaultModel: form.defaultModel,
          requiresKey: form.requiresKey,
          kind: form.kind,
          name: form.name,
        }),
      });
      if (result.ok) {
        el.textContent = `Connected · ${result.modelCount || 0} models${result.models?.[0] ? ` · e.g. ${result.models[0]}` : ''}`;
        if (result.models?.length) {
          state.models = result.models;
          syncComposerSelects();
          const list = $('pref-llm-model-list');
          if (list) list.innerHTML = result.models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
          if (!form.defaultModel && result.defaultModel && $('pref-llm-default-model')) {
            $('pref-llm-default-model').value = result.defaultModel;
          }
        }
      } else {
        el.textContent = result.error || 'Failed';
      }
    } catch (err) {
      el.textContent = err.message;
    }
  });

  $('pref-llm-save')?.addEventListener('click', async () => {
    const el = $('pref-llm-test-result');
    try {
      const form = collectProviderForm();
      if (!form.id) throw new Error('No provider selected');
      const saved = await api(`/api/llm/providers/${form.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...form, makeActive: true }),
      });
      state.llm = saved.llm;
      fillLlmPrefs(state.llm);
      const settings = await api('/api/settings');
      // also persist default model field
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ defaultModel: form.defaultModel || settings.defaultModel }),
      });
      const next = await api('/api/settings');
      applySettings(next);
      state.llm = next.llm;
      fillLlmPrefs(state.llm);
      await refreshLlmModels(form.id);
      el.textContent = 'Provider saved';
    } catch (err) {
      el.textContent = err.message;
    }
  });

  $('pref-llm-refresh-models')?.addEventListener('click', async () => {
    const el = $('pref-llm-test-result');
    el.textContent = 'Loading models…';
    const data = await refreshLlmModels(state.editingProviderId || state.llm?.activeProviderId);
    el.textContent = data ? `${(data.models || []).length} models from ${data.provider || 'provider'}` : 'Could not load models';
  });

  $('pref-llm-delete')?.addEventListener('click', async () => {
    if (!state.editingProviderId) return;
    if (!confirm('Remove this provider?')) return;
    try {
      const res = await api(`/api/llm/providers/${state.editingProviderId}`, { method: 'DELETE' });
      state.llm = res.llm;
      state.editingProviderId = res.llm.activeProviderId;
      const settings = await api('/api/settings');
      applySettings(settings);
      state.llm = settings.llm;
      fillLlmPrefs(state.llm);
      await refreshLlmModels(state.llm.activeProviderId);
      if ($('pref-llm-test-result')) $('pref-llm-test-result').textContent = 'Provider removed';
    } catch (err) {
      if ($('pref-llm-test-result')) $('pref-llm-test-result').textContent = err.message;
    }
  });

  $('pref-comfy-test')?.addEventListener('click', async () => {
    const el = $('pref-comfy-test-result');
    el.textContent = 'Testing…';
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          comfy: {
            ...(state.settings?.comfy || {}),
            baseUrl: $('pref-comfy-url').value,
            enabled: $('pref-comfy-enabled').checked,
          },
        }),
      });
      const status = await api('/api/comfy/status');
      el.textContent = status.ok
        ? `Connected · ${status.system?.os || 'ok'} · RAM free ${formatBytes(status.system?.ram_free)}`
        : `Failed: ${status.error || 'unreachable'}`;
      if (status.ok) await loadComfyModelOptions(true);
    } catch (err) {
      el.textContent = err.message;
    }
  });
  $('pref-comfy-refresh-models')?.addEventListener('click', () => loadComfyModelOptions(true));

  $('save-chat-settings')?.addEventListener('click', async () => {
    if (!state.chat) return;
    const tempRaw = $('chat-set-temp').value;
    const topPRaw = $('chat-set-top-p').value;
    const maxRaw = $('chat-set-max-tokens').value;
    await patchChat({
      title: $('chat-set-title').value,
      folderId: $('chat-set-folder').value || null,
      temperature: tempRaw === '' ? null : Number(tempRaw),
      topP: topPRaw === '' ? null : Number(topPRaw),
      maxTokens: maxRaw === '' ? null : Number(maxRaw),
      presetId: $('chat-set-preset').value || null,
      storyNotes: $('chat-set-notes').value,
    });
    closeModal('chat-modal');
  });

  $('save-folder-settings')?.addEventListener('click', async () => {
    const id = $('folder-set-id')?.value;
    if (!id) return;
    const tempRaw = $('folder-set-temp').value;
    const topPRaw = $('folder-set-top-p').value;
    const maxRaw = $('folder-set-max-tokens').value;
    try {
      const next = await api(`/api/folders/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: $('folder-set-name').value,
          color: $('folder-set-color').value || null,
          systemPrompt: $('folder-set-system').value,
          stylePrompt: $('folder-set-style').value,
          model: $('folder-set-model').value || null,
          temperature: tempRaw === '' ? null : Number(tempRaw),
          topP: topPRaw === '' ? null : Number(topPRaw),
          maxTokens: maxRaw === '' ? null : Number(maxRaw),
          presetId: $('folder-set-preset').value || null,
        }),
      });
      const idx = state.folders.findIndex((f) => f.id === id);
      if (idx >= 0) state.folders[idx] = next;
      else state.folders.push(next);
      state.folders.sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }),
      );
      renderChatList();
      closeModal('folder-modal');
      toast('Folder saved');
    } catch (err) {
      toast(err.message || 'Save failed');
    }
  });

  $('delete-folder')?.addEventListener('click', async () => {
    const id = $('folder-set-id')?.value;
    if (!id) return;
    if (!confirm('Delete this folder? Chats will be moved to Unfiled.')) return;
    try {
      await api(`/api/folders/${id}`, { method: 'DELETE' });
      state.folders = state.folders.filter((f) => f.id !== id);
      if (state.activeFolderId === id) state.activeFolderId = null;
      if (state.chat?.folderId === id) {
        state.chat.folderId = null;
        syncComposerSelects();
      }
      await loadChats();
      closeModal('folder-modal');
      toast('Folder deleted');
    } catch (err) {
      toast(err.message || 'Delete failed');
    }
  });

  $('confirm-move-folder')?.addEventListener('click', async () => {
    const chatId = $('move-chat-id')?.value;
    if (!chatId) return;
    try {
      await moveChatToFolder(chatId, $('move-folder-select').value || null);
      closeModal('move-folder-modal');
    } catch (err) {
      toast(err.message || 'Move failed');
    }
  });

  $('delete-chat')?.addEventListener('click', async () => {
    if (!state.chat || !confirm('Delete this chat?')) return;
    await api(`/api/chats/${state.chat.id}`, { method: 'DELETE' });
    state.chat = null;
    await loadChats();
    renderConversation();
    closeModal('chat-modal');
  });

  $('export-chat')?.addEventListener('click', () => {
    if (!state.chat) return;
    const lines = [`# ${state.chat.title}`, '', `Mode: ${state.chat.modeId || ''}`, `Model: ${state.chat.model}`, ''];
    for (const m of state.chat.messages || []) {
      lines.push(`## ${m.role}`, '', m.content || '', '');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(state.chat.title || 'chat').replace(/[^\w.-]+/g, '_')}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('view-prompt')?.addEventListener('click', async () => {
    if (!state.chat) {
      openModal('prompt-modal');
      $('prompt-preview').textContent = 'Select or create a chat first.';
      return;
    }
    const data = await api(`/api/chats/${state.chat.id}/prompt-preview`, {
      method: 'POST',
      body: JSON.stringify({ content: $('message').value || '(next user message)' }),
    });
    $('prompt-preview').textContent = JSON.stringify(data.messages, null, 2);
    openModal('prompt-modal');
  });

  // Characters / personas now live on /characters (full page).
  // Keep preset editing available via the old modal tabs if present.
  document.querySelectorAll('#library-modal .tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      state.libraryTab = tab.dataset.tab;
      document.querySelectorAll('#library-modal .tab').forEach((t) => t.classList.toggle('active', t === tab));
      await refreshLibraryAndSelect(libraryItems()[0]?.id);
    });
  });

  $('open-gallery')?.addEventListener('click', async () => {
    await renderGalleryModal();
    openModal('gallery-modal');
  });
  $('gallery-upload-btn')?.addEventListener('click', () => $('gallery-file-input').click());
  $('gallery-file-input')?.addEventListener('change', async (e) => {
    if (e.target.files?.length) {
      await uploadFiles(e.target.files);
      e.target.value = '';
    }
  });
  // Code workspace
  $('code-new-file')?.addEventListener('click', () => createWorkspaceFile().catch((err) => toast(err.message)));
  $('code-delete-file')?.addEventListener('click', () => deleteWorkspaceFile().catch((err) => toast(err.message)));
  $('code-save-file')?.addEventListener('click', () => saveWorkspaceFile().catch((err) => toast(err.message)));
  $('code-import-zip')?.addEventListener('click', () => $('code-zip-input')?.click());
  $('code-export-zip')?.addEventListener('click', () => exportWorkspaceZip().catch((err) => toast(err.message)));
  $('code-zip-input')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      await importWorkspaceZip(file);
    } catch (err) {
      toast(err.message || 'Import failed');
    }
  });
  const codeEditor = $('code-editor');
  codeEditor?.addEventListener('input', () => {
    state.workspace.content = codeEditor.value;
    state.workspace.dirty = codeEditor.value !== state.workspace.savedContent;
    syncCodeEditorUi();
    scheduleWorkspaceSave();
  });
  codeEditor?.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveWorkspaceFile().catch((err) => toast(err.message));
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = codeEditor.selectionStart;
      const end = codeEditor.selectionEnd;
      const v = codeEditor.value;
      codeEditor.value = `${v.slice(0, start)}  ${v.slice(end)}`;
      codeEditor.selectionStart = codeEditor.selectionEnd = start + 2;
      codeEditor.dispatchEvent(new Event('input'));
    }
  });

  $('attach-button')?.addEventListener('click', () => $('file-input').click());
  $('file-input')?.addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    if (currentMode().id === 'code') {
      const zips = files.filter((f) => /\.zip$/i.test(f.name) || f.type === 'application/zip');
      const other = files.filter((f) => !zips.includes(f));
      try {
        for (const z of zips) await importWorkspaceZip(z);
        if (other.length) {
          await uploadFiles(other);
          toast('Non-zip files went to Gallery');
        }
      } catch (err) {
        toast(err.message || 'Attach failed');
      }
      return;
    }
    await uploadFiles(files);
    openModal('gallery-modal');
  });

  $('logout')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST', body: '{}' });
    location.href = '/login.html';
  });
}

if (isLoginPage) {
  initLogin().catch((err) => {
    const el = $('login-error') || $('setup-error');
    if (el) el.textContent = err.message;
  });
} else {
  initApp().catch((err) => {
    console.error(err);
    setStatus('err', err.message || 'Failed to load');
  });
}
