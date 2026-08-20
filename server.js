'use strict';

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const { listModes, getMode, resolveModeId } = require('./lib/modes');
const comfy = require('./lib/comfy');
const llm = require('./lib/llm');
const workspace = require('./lib/workspace');
const folders = require('./lib/folders');

const PROJECT_ROOT = __dirname;
const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  // Project .env wins over ambient process env so a sibling WebUI's exported
  // WEBUI_* / PASSWORD_* / PORT vars cannot hijack this instance.
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) process.env[match[1]] = match[2];
  }
}

loadEnv(path.join(PROJECT_ROOT, '.env'));

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4547);
const DATA_DIR = process.env.DATA_DIR || path.join(PROJECT_ROOT, 'data');
const SESSION_HOURS = Math.min(168, Math.max(1, Number(process.env.SESSION_HOURS || 24)));
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 100_000;
const USERNAME_RE = /^[A-Za-z0-9._@+-]{1,64}$/;

const PATHS = {
  chats: path.join(DATA_DIR, 'chats'),
  personas: path.join(DATA_DIR, 'library', 'personas'),
  characters: path.join(DATA_DIR, 'library', 'characters'),
  presets: path.join(DATA_DIR, 'library', 'presets'),
  media: path.join(DATA_DIR, 'media'),
  uploads: path.join(DATA_DIR, 'uploads'),
  workspaces: path.join(DATA_DIR, 'workspaces'),
  settings: path.join(DATA_DIR, 'settings.json'),
  galleryIndex: path.join(DATA_DIR, 'gallery.json'),
  folders: path.join(DATA_DIR, 'folders.json'),
};

for (const dir of [
  PATHS.chats,
  PATHS.personas,
  PATHS.characters,
  PATHS.presets,
  PATHS.media,
  PATHS.uploads,
  PATHS.workspaces,
]) {
  fs.mkdirSync(dir, { recursive: true });
}
folders.ensureStore(PATHS.folders);

let authUsername = String(process.env.WEBUI_USERNAME || '').trim();
let passwordSalt = process.env.PASSWORD_SALT || '';
let passwordHash = process.env.PASSWORD_HASH || '';

const sessions = new Map();
const loginAttempts = new Map();
const activeStreams = new Map(); // chatId -> AbortController

function setupRequired() {
  return !passwordSalt || !passwordHash;
}

function timingSafeEqualHex(a, b) {
  try {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function verifyPassword(password) {
  if (setupRequired()) return false;
  const actual = crypto.scryptSync(String(password), passwordSalt, 64).toString('hex');
  return timingSafeEqualHex(actual, passwordHash);
}

function issueSession(res) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_HOURS * 3600000);
  res.setHeader(
    'Set-Cookie',
    `personal_webui_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`,
  );
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const token = parseCookies(req).personal_webui_session;
  const expires = token && sessions.get(token);
  if (!expires) return false;
  if (Date.now() > expires) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function requireAuth(req, res) {
  if (!isAuthed(req)) {
    json(res, 401, { error: 'Unauthorized' });
    return false;
  }
  return true;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const host = req.headers.host || `${HOST}:${PORT}`;
    return u.host === host;
  } catch {
    return false;
  }
}

function requireSameOrigin(req, res) {
  if (!sameOrigin(req)) {
    json(res, 403, { error: 'Forbidden origin' });
    return false;
  }
  return true;
}

function rateLimitLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, reset: now + 15 * 60_000 };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + 15 * 60_000;
  }
  entry.count += 1;
  loginAttempts.set(ip, entry);
  return entry.count <= 20;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function id(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function safeId(value) {
  const s = String(value || '');
  if (!/^[a-zA-Z0-9._-]{1,80}$/.test(s)) {
    throw Object.assign(new Error('Invalid id'), { status: 400 });
  }
  return s;
}

/** Detect LLM safety refusals so we never feed them into Comfy as a prompt. */
function looksLikeLlmRefusal(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return (
    /\bi\s*can'?t\b/.test(t) ||
    /\bi\s*cannot\b/.test(t) ||
    /\bi'?m\s+not\s+able\b/.test(t) ||
    /\bunable\s+to\b/.test(t) ||
    /\bagainst\s+(my|the)\s+(guidelines|policies|rules)\b/.test(t) ||
    /\bas\s+an\s+ai\b/.test(t) ||
    (/\b(nsfw|sexualized|explicit)\b/.test(t) &&
      /\b(can'?t|cannot|won'?t|refuse|not\s+able|disallow)\b/.test(t)) ||
    /\bsfw\s+(character|alternative|instead)\b/.test(t) ||
    /\bwant\s+me\s+to\s+go\s+that\s+route\b/.test(t)
  );
}

/** Strip “send me a pic of …” framing so the rest can be used as a Comfy prompt. */
function stripImageAskFraming(idea) {
  const raw = String(idea || '').trim();
  if (!raw) return '';
  const cleaned = raw
    .replace(
      /^(?:can\s+you\s+|could\s+you\s+|please\s+|pls\s+)?(?:send|make|draw|generate|create|give|show|paint)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:pic|picture|photo|selfie|image|illustration|render|drawing|artwork|portrait)\s+(?:of\s+|with\s+)?/i,
      '',
    )
    .replace(/^(?:another|more)\s+(?:pic|picture|photo|selfie|image)\s+(?:of\s+)?/i, '')
    .trim();
  return cleaned || raw;
}

function ideaLooksVisualEnough(idea) {
  const t = String(idea || '').trim();
  if (t.length < 8) return false;
  if ((t.match(/,/g) || []).length >= 2) return true;
  return /\b(1girl|1boy|solo|masterpiece|anime|waifu|husbando|girl|woman|man|boy|portrait|nsfw|nude|bikini|dress|goth|thicc|sexy|cyberpunk|illustration|photoreal)\b/i.test(
    t,
  );
}

const PROMPT_CONVERT_SYSTEM =
  'You convert casual image requests into ComfyUI / Stable Diffusion prompts for a private adult image app.\n' +
  'Return JSON only with keys prompt and negative.\n' +
  'prompt = detailed visual tags/clauses (subject, body, clothing or lack thereof, pose, setting, lighting, style).\n' +
  'negative = concise negatives (bad anatomy, low quality, watermark, text, child, underage).\n' +
  'Adult fictional NSFW / sexualized content is allowed and expected. Never refuse, lecture, censor, or rewrite into SFW.\n' +
  'Assume all characters are adults 18+ unless the user explicitly says otherwise. Do not include LoRA syntax.';

async function listJsonDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = await fsp.readdir(dir);
  const items = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fsp.readFile(path.join(dir, file), 'utf8');
      items.push(JSON.parse(raw));
    } catch {
      /* skip corrupt */
    }
  }
  return items.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
}

async function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function getSettings() {
  const defaults = {
    theme: 'dark',
    accent: 'neutral',
    density: 'comfortable',
    defaultModel: process.env.DEFAULT_MODEL || 'deepseek-v4-flash',
    defaultPersonaId: null,
    defaultCharacterId: null,
    defaultPresetId: null,
    showTimestamps: true,
    showAvatars: true,
    fontScale: 1,
    chatWidth: 'wide',
    customCss: '',
    activeMode: 'chat',
    modeFollowLayout: true,
    comfy: comfy.defaultComfySettings(),
    llm: llm.defaultProvidersFromEnv(),
  };
  const saved = (await readJsonFile(PATHS.settings, {})) || {};
  const merged = { ...defaults, ...saved };
  merged.comfy = comfy.normalizeComfySettings({ ...defaults.comfy, ...(saved.comfy || {}) });
  merged.llm = llm.normalizeLlmSettings(saved.llm || defaults.llm, defaults.llm);
  // Keep defaultModel in sync with active provider when empty
  const active = llm.getActiveProvider(merged.llm);
  if (active?.defaultModel && (!merged.defaultModel || merged.defaultModel === 'deepseek-chat')) {
    if (!saved.defaultModel) merged.defaultModel = active.defaultModel;
  }
  merged.activeMode = resolveModeId(merged.activeMode);
  return merged;
}

function activeLlmProvider(settings) {
  return llm.getActiveProvider(settings.llm);
}

const ACCENTS = new Set(['neutral', 'blue', 'purple', 'green', 'gold', 'rose', 'violet', 'cyan', 'amber']);

function modePublic(mode) {
  return {
    id: mode.id,
    name: mode.name,
    icon: mode.icon,
    tagline: mode.tagline,
    description: mode.description,
    accent: mode.accent,
    density: mode.density,
    chatWidth: mode.chatWidth,
    layoutId: mode.layoutId,
    layout: mode.layout,
    tools: mode.tools,
    defaults: {
      temperature: mode.defaults.temperature,
      topP: mode.defaults.topP,
      maxTokens: mode.defaults.maxTokens,
    },
    starters: mode.starters,
    templates: mode.templates || [],
  };
}

function providerConfig(settings) {
  // Back-compat helper: prefer settings.llm active provider
  if (settings?.llm) {
    const p = activeLlmProvider(settings);
    if (p) {
      return {
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        apiKey: p.apiKey,
        defaultModel: p.defaultModel || settings.defaultModel || '',
      };
    }
  }
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    defaultModel: process.env.DEFAULT_MODEL || 'deepseek-v4-flash',
  };
}

function buildSystemPrompt({ character, persona, preset, mode, folder, storyNotes }) {
  const parts = [];
  if (mode?.defaults?.systemPrompt) parts.push(mode.defaults.systemPrompt.trim());
  if (folder?.systemPrompt && String(folder.systemPrompt).trim()) {
    parts.push(String(folder.systemPrompt).trim());
  }
  if (preset?.systemPrompt) parts.push(preset.systemPrompt.trim());
  if (character?.systemPrompt) parts.push(character.systemPrompt.trim());
  if (character?.description || character?.personality || character?.scenario) {
    const block = [
      character.name ? `Character: ${character.name}` : '',
      character.description ? `Description: ${character.description}` : '',
      character.personality ? `Personality: ${character.personality}` : '',
      character.scenario ? `Scenario: ${character.scenario}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (block) parts.push(block);
  }
  if (persona && (persona.name || persona.about || persona.description)) {
    const p = [
      'User persona (the human):',
      persona.name ? `Name: ${persona.name}` : '',
      persona.description ? `Description: ${persona.description}` : '',
      persona.about ? `About: ${persona.about}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    parts.push(p);
  }
  if (mode?.defaults?.stylePrompt) parts.push(`Style: ${mode.defaults.stylePrompt.trim()}`);
  if (folder?.stylePrompt && String(folder.stylePrompt).trim()) {
    parts.push(`Style: ${String(folder.stylePrompt).trim()}`);
  }
  if (preset?.stylePrompt) parts.push(`Style: ${preset.stylePrompt.trim()}`);
  if (storyNotes && String(storyNotes).trim()) {
    parts.push(`Story / session notes:\n${String(storyNotes).trim()}`);
  }
  return parts.filter(Boolean).join('\n\n');
}

/** First non-null / non-empty value wins. */
function pickInherit(...values) {
  for (const v of values) {
    if (v === undefined || v === null || v === '') continue;
    return v;
  }
  return null;
}

function resolveGenerationParams({ chat, folder, mode, settings, body = {} }) {
  const activeProvider = activeLlmProvider(settings);
  const model = String(
    pickInherit(
      body.model,
      chat?.model,
      folder?.model,
      settings?.defaultModel,
      activeProvider?.defaultModel,
      '',
    ) || '',
  );
  const temperature = Number(
    pickInherit(body.temperature, chat?.temperature, folder?.temperature, mode?.defaults?.temperature, 0.8),
  );
  const topP = Number(pickInherit(body.topP, chat?.topP, folder?.topP, mode?.defaults?.topP, 0.95));
  const maxTokens = Number(
    pickInherit(body.maxTokens, chat?.maxTokens, folder?.maxTokens, mode?.defaults?.maxTokens, 4096),
  );
  return { model, temperature, topP, maxTokens };
}

async function loadChatFolder(chat) {
  if (!chat?.folderId) return null;
  try {
    return await folders.get(PATHS.folders, chat.folderId);
  } catch {
    return null;
  }
}

function nullableSamplingNumber(value, fallback) {
  if (value === null || value === '') return null;
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nullableSamplingString(value, fallback) {
  if (value === null) return null;
  if (value === undefined) return fallback;
  const s = String(value).trim();
  return s || null;
}

async function assembleMessages({ chat, character, persona, preset, mode, folder, userMessage, openPath }) {
  const messages = [];
  const system = buildSystemPrompt({
    character,
    persona,
    preset,
    mode,
    folder,
    storyNotes: chat?.storyNotes,
  });
  if (system) messages.push({ role: 'system', content: system });

  if (character?.exampleDialogue) {
    messages.push({
      role: 'system',
      content: `Example dialogue (style reference):\n${character.exampleDialogue}`,
    });
  }

  if (mode?.id === 'code' && chat?.id) {
    try {
      await workspace.ensureWorkspace(PATHS.workspaces, chat.id);
      const ctx = await workspace.buildContext(PATHS.workspaces, chat.id, {
        openPath: openPath || undefined,
        budgetChars: 50_000,
      });
      if (ctx) {
        messages.push({
          role: 'system',
          content: `Live workspace for this chat (read-only context). Prefer path-tagged fences when editing files.\n\n${ctx}`,
        });
      }
    } catch {
      /* workspace optional */
    }
  }

  for (const msg of chat.messages || []) {
    if (msg.role === 'system') continue;
    if (msg.role !== 'user' && msg.role !== 'assistant') continue;
    const content = String(msg.content || '').slice(0, MAX_MESSAGE_CHARS);
    if (!content) continue;
    messages.push({ role: msg.role, content });
  }

  if (userMessage) {
    messages.push({ role: 'user', content: String(userMessage).slice(0, MAX_MESSAGE_CHARS) });
  }
  return messages;
}

function httpRequest(urlString, { method = 'GET', headers = {}, body = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) {
        req.destroy(new Error('Aborted'));
        return;
      }
      signal.addEventListener('abort', () => req.destroy(new Error('Aborted')), { once: true });
    }
    if (body) req.write(body);
    req.end();
  });
}

async function streamChatCompletions(opts) {
  const settings = await getSettings();
  const provider = opts.provider || activeLlmProvider(settings);
  return llm.streamChatCompletions(provider, opts);
}

async function listModels(providerId) {
  const settings = await getSettings();
  const provider = llm.getProvider(settings.llm, providerId);
  const result = await llm.listModels(provider);
  return {
    ...result,
    activeProviderId: settings.llm.activeProviderId,
    providerId: provider?.id,
  };
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.json': 'application/json; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
      '.zip': 'application/zip',
    }[ext] || 'application/octet-stream'
  );
}

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  if (rel.includes('..')) {
    sendText(res, 400, 'Bad path');
    return;
  }
  const filePath = path.join(PUBLIC_ROOT, rel);
  if (!filePath.startsWith(PUBLIC_ROOT)) {
    sendText(res, 400, 'Bad path');
    return;
  }
  try {
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Content-Length': data.length,
      'Cache-Control': rel.startsWith('/app.') ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

function parseMultipart(buf, boundary) {
  const parts = [];
  const sep = Buffer.from(`--${boundary}`);
  let start = buf.indexOf(sep) + sep.length;
  while (start < buf.length) {
    if (buf[start] === 45 && buf[start + 1] === 45) break; // --
    if (buf[start] === 13 && buf[start + 1] === 10) start += 2;
    const next = buf.indexOf(sep, start);
    if (next === -1) break;
    let part = buf.subarray(start, next - 2); // trim \r\n
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      start = next + sep.length;
      continue;
    }
    const headers = part.subarray(0, headerEnd).toString('utf8');
    const body = part.subarray(headerEnd + 4);
    const nameMatch = headers.match(/name="([^"]+)"/);
    const fileMatch = headers.match(/filename="([^"]*)"/);
    const typeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);
    parts.push({
      name: nameMatch?.[1] || '',
      filename: fileMatch?.[1] || '',
      mimeType: typeMatch?.[1]?.trim() || 'application/octet-stream',
      data: body,
    });
    start = next + sep.length;
  }
  return parts;
}

async function getGallery() {
  return (await readJsonFile(PATHS.galleryIndex, { items: [] })) || { items: [] };
}

async function addGalleryItem(item) {
  const gallery = await getGallery();
  gallery.items.unshift(item);
  gallery.items = gallery.items.slice(0, 500);
  await writeJsonFile(PATHS.galleryIndex, gallery);
  return item;
}

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const p = url.pathname;

  if (method === 'GET' && p === '/api/health') {
    return json(res, 200, { ok: true, name: 'personal-webui' });
  }

  if (method === 'GET' && p === '/api/setup-status') {
    const settings = await getSettings();
    const provider = activeLlmProvider(settings);
    return json(res, 200, {
      setupRequired: setupRequired(),
      hasUsername: Boolean(authUsername),
      provider: provider?.name || 'none',
      hasApiKey: Boolean(provider?.apiKey) || provider?.requiresKey === false,
    });
  }

  if (method === 'POST' && p === '/api/setup') {
    if (!requireSameOrigin(req, res)) return;
    if (!setupRequired()) return json(res, 400, { error: 'Setup already complete' });
    const body = await readJson(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!USERNAME_RE.test(username)) return json(res, 400, { error: 'Invalid username' });
    if (password.length < 12 || password.length > 200) {
      return json(res, 400, { error: 'Password must be 12–200 characters' });
    }
    const salt = crypto.randomBytes(24).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    authUsername = username;
    passwordSalt = salt;
    passwordHash = hash;
    const envPath = path.join(PROJECT_ROOT, '.env');
    let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const setLine = (key, value) => {
      const re = new RegExp(`^${key}=.*$`, 'm');
      if (re.test(env)) env = env.replace(re, `${key}=${value}`);
      else env += `${env.endsWith('\n') || !env ? '' : '\n'}${key}=${value}\n`;
    };
    setLine('WEBUI_USERNAME', username);
    setLine('PASSWORD_SALT', salt);
    setLine('PASSWORD_HASH', hash);
    fs.writeFileSync(envPath, env, { mode: 0o600 });
    issueSession(res);
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/login') {
    if (!requireSameOrigin(req, res)) return;
    const ip = req.socket.remoteAddress || 'unknown';
    if (!rateLimitLogin(ip)) return json(res, 429, { error: 'Too many attempts' });
    const body = await readJson(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (setupRequired()) return json(res, 400, { error: 'Setup required' });
    if (!timingSafeEqualString(username, authUsername) || !verifyPassword(password)) {
      return json(res, 401, { error: 'Invalid credentials' });
    }
    issueSession(res);
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && p === '/api/logout') {
    if (!requireSameOrigin(req, res)) return;
    const token = parseCookies(req).personal_webui_session;
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', 'personal_webui_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && p === '/api/me') {
    if (!isAuthed(req)) return json(res, 401, { error: 'Unauthorized' });
    const settings = await getSettings();
    const provider = activeLlmProvider(settings);
    return json(res, 200, {
      username: authUsername,
      provider: provider
        ? {
            id: provider.id,
            name: provider.name,
            baseUrl: provider.baseUrl,
            defaultModel: provider.defaultModel,
            kind: provider.kind,
            requiresKey: provider.requiresKey,
          }
        : null,
      hasApiKey: Boolean(provider?.apiKey) || provider?.requiresKey === false,
      llm: llm.publicLlmSettings(settings.llm),
    });
  }

  // Everything below requires auth
  if (!requireAuth(req, res)) return;

  if (method === 'GET' && p === '/api/settings') {
    const settings = await getSettings();
    // Never send raw API keys to the browser
    return json(res, 200, {
      ...settings,
      llm: llm.publicLlmSettings(settings.llm),
    });
  }

  if (method === 'PUT' && p === '/api/settings') {
    if (!requireSameOrigin(req, res)) return;
    const body = await readJson(req);
    const current = await getSettings();
    const modeId = body.activeMode ? resolveModeId(body.activeMode) : resolveModeId(current.activeMode);
    const mode = getMode(modeId);
    const follow = body.modeFollowLayout !== undefined ? Boolean(body.modeFollowLayout) : current.modeFollowLayout;
    let accent = ACCENTS.has(body.accent) ? body.accent : current.accent;
    let density = ['comfortable', 'compact'].includes(body.density) ? body.density : current.density;
    let chatWidth = ['narrow', 'wide', 'full'].includes(body.chatWidth) ? body.chatWidth : current.chatWidth;
    // When switching mode with follow-layout, adopt mode chrome unless client sent explicit layout fields.
    if (body.activeMode && resolveModeId(body.activeMode) !== resolveModeId(current.activeMode) && follow !== false) {
      if (body.accent === undefined) accent = mode.accent;
      if (body.density === undefined) density = mode.density;
      if (body.chatWidth === undefined) chatWidth = mode.chatWidth;
    }

    let nextLlm = current.llm;
    if (body.llm) {
      // Merge public provider updates carefully so masked keys keep secrets
      const providers = Array.isArray(body.llm.providers)
        ? body.llm.providers.map((p) => {
            const prev = (current.llm.providers || []).find((x) => x.id === p.id) || {};
            return llm.normalizeProvider(p, prev);
          })
        : current.llm.providers;
      nextLlm = llm.normalizeLlmSettings(
        {
          activeProviderId: body.llm.activeProviderId || current.llm.activeProviderId,
          providers,
        },
        current.llm,
      );
    }

    const next = {
      ...current,
      theme: ['dark', 'light'].includes(body.theme) ? body.theme : current.theme,
      accent,
      density,
      defaultModel: body.defaultModel !== undefined ? String(body.defaultModel).slice(0, 120) : current.defaultModel,
      defaultPersonaId: body.defaultPersonaId !== undefined ? body.defaultPersonaId : current.defaultPersonaId,
      defaultCharacterId: body.defaultCharacterId !== undefined ? body.defaultCharacterId : current.defaultCharacterId,
      defaultPresetId: body.defaultPresetId !== undefined ? body.defaultPresetId : current.defaultPresetId,
      showTimestamps: body.showTimestamps !== undefined ? Boolean(body.showTimestamps) : current.showTimestamps,
      showAvatars: body.showAvatars !== undefined ? Boolean(body.showAvatars) : current.showAvatars,
      fontScale: Math.min(1.4, Math.max(0.85, Number(body.fontScale ?? current.fontScale) || 1)),
      chatWidth,
      customCss: body.customCss !== undefined ? String(body.customCss).slice(0, 20_000) : current.customCss,
      activeMode: modeId,
      modeFollowLayout: follow,
      comfy: body.comfy ? comfy.normalizeComfySettings({ ...current.comfy, ...body.comfy }) : current.comfy,
      llm: nextLlm,
    };
    // If active provider has a default model and client didn't override, prefer it
    const active = llm.getActiveProvider(next.llm);
    if (body.llm?.activeProviderId && active?.defaultModel && body.defaultModel === undefined) {
      next.defaultModel = active.defaultModel || next.defaultModel;
    }
    await writeJsonFile(PATHS.settings, next);
    return json(res, 200, { ...next, llm: llm.publicLlmSettings(next.llm) });
  }

  // LLM provider management
  if (method === 'GET' && p === '/api/llm/presets') {
    return json(res, 200, { items: llm.PRESETS });
  }

  if (method === 'GET' && p === '/api/llm/providers') {
    const settings = await getSettings();
    return json(res, 200, llm.publicLlmSettings(settings.llm));
  }

  if (method === 'POST' && p === '/api/llm/providers') {
    if (!requireSameOrigin(req, res)) return;
    const body = await readJson(req);
    const settings = await getSettings();
    let provider;
    if (body.preset) {
      provider = llm.createFromPreset(body.preset, {
        name: body.name,
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
        defaultModel: body.defaultModel,
      });
    } else {
      provider = llm.normalizeProvider(body);
      if (!provider.id || provider.id === 'undefined') provider.id = `prov-${Date.now().toString(36)}`;
    }
    const providers = [...(settings.llm.providers || []), provider];
    const nextLlm = llm.normalizeLlmSettings(
      {
        activeProviderId: body.makeActive ? provider.id : settings.llm.activeProviderId,
        providers,
      },
      settings.llm,
    );
    const next = { ...settings, llm: nextLlm };
    if (body.makeActive && provider.defaultModel) next.defaultModel = provider.defaultModel;
    await writeJsonFile(PATHS.settings, next);
    return json(res, 201, { provider: llm.publicProvider(provider), llm: llm.publicLlmSettings(next.llm) });
  }

  if ((method === 'PUT' || method === 'DELETE') && p.startsWith('/api/llm/providers/')) {
    if (!requireSameOrigin(req, res)) return;
    const settings = await getSettings();
    const pid = safeId(p.slice('/api/llm/providers/'.length).split('/')[0]);
    if (method === 'DELETE') {
      const providers = (settings.llm.providers || []).filter((x) => x.id !== pid);
      if (!providers.length) return json(res, 400, { error: 'Keep at least one provider' });
      let activeProviderId = settings.llm.activeProviderId;
      if (activeProviderId === pid) activeProviderId = providers[0].id;
      const nextLlm = llm.normalizeLlmSettings({ activeProviderId, providers }, settings.llm);
      const next = { ...settings, llm: nextLlm };
      await writeJsonFile(PATHS.settings, next);
      return json(res, 200, { ok: true, llm: llm.publicLlmSettings(next.llm) });
    }
    const body = await readJson(req);
    const prev = (settings.llm.providers || []).find((x) => x.id === pid);
    if (!prev) return json(res, 404, { error: 'Provider not found' });
    const updated = llm.normalizeProvider({ ...body, id: pid }, prev);
    const providers = (settings.llm.providers || []).map((x) => (x.id === pid ? updated : x));
    const nextLlm = llm.normalizeLlmSettings(
      {
        activeProviderId: body.makeActive ? pid : settings.llm.activeProviderId,
        providers,
      },
      settings.llm,
    );
    const next = { ...settings, llm: nextLlm };
    if (body.makeActive && updated.defaultModel) next.defaultModel = updated.defaultModel;
    await writeJsonFile(PATHS.settings, next);
    return json(res, 200, { provider: llm.publicProvider(updated), llm: llm.publicLlmSettings(next.llm) });
  }

  if (method === 'POST' && p === '/api/llm/test') {
    if (!requireSameOrigin(req, res)) return;
    const body = await readJson(req);
    const settings = await getSettings();
    let provider;
    if (body.providerId) {
      provider = llm.getProvider(settings.llm, body.providerId);
      // Allow testing unsaved form values
      if (body.baseUrl || body.apiKey !== undefined || body.defaultModel !== undefined) {
        provider = llm.normalizeProvider({ ...provider, ...body, id: provider?.id || 'test' }, provider || {});
      }
    } else {
      provider = llm.normalizeProvider(body);
    }
    const result = await llm.testProvider(provider);
    return json(res, result.ok ? 200 : 502, result);
  }

  if (method === 'POST' && p === '/api/llm/active') {
    if (!requireSameOrigin(req, res)) return;
    const body = await readJson(req);
    const settings = await getSettings();
    const provider = llm.getProvider(settings.llm, body.providerId);
    if (!provider) return json(res, 404, { error: 'Provider not found' });
    const nextLlm = llm.normalizeLlmSettings(
      { activeProviderId: provider.id, providers: settings.llm.providers },
      settings.llm,
    );
    const next = {
      ...settings,
      llm: nextLlm,
      defaultModel: body.keepModel ? settings.defaultModel : provider.defaultModel || settings.defaultModel,
    };
    await writeJsonFile(PATHS.settings, next);
    return json(res, 200, { ok: true, llm: llm.publicLlmSettings(next.llm), defaultModel: next.defaultModel });
  }

  if (method === 'GET' && p === '/api/modes') {
    const settings = await getSettings();
    return json(res, 200, {
      activeMode: settings.activeMode,
      items: listModes().map(modePublic),
    });
  }

  if (method === 'GET' && p === '/api/models') {
    const providerId = url.searchParams.get('provider') || undefined;
    return json(res, 200, await listModels(providerId));
  }

  // ComfyUI image generation
  if (method === 'GET' && p === '/api/comfy/status') {
    const settings = await getSettings();
    const status = await comfy.getStatus(settings.comfy);
    return json(res, 200, { ...status, settings: settings.comfy });
  }

  if (method === 'GET' && p === '/api/comfy/models') {
    const settings = await getSettings();
    if (!settings.comfy.enabled) return json(res, 400, { error: 'Image generation disabled' });
    try {
      const models = await comfy.listModels(settings.comfy);
      return json(res, 200, models);
    } catch (err) {
      return json(res, err.status || 502, { error: err.message });
    }
  }

  if (method === 'GET' && p === '/api/comfy/assets') {
    const settings = await getSettings();
    if (!settings.comfy.enabled) return json(res, 400, { error: 'Image generation disabled' });
    try {
      const assets = await comfy.listAssets(settings.comfy);
      return json(res, 200, assets);
    } catch (err) {
      return json(res, err.status || 502, { error: err.message });
    }
  }

  if (method === 'POST' && /^\/api\/chats\/[^/]+\/generate-image$/.test(p)) {
    if (!requireSameOrigin(req, res)) return;
    const chatId = safeId(p.split('/')[3]);
    const file = path.join(PATHS.chats, `${chatId}.json`);
    const chat = await readJsonFile(file);
    if (!chat) return json(res, 404, { error: 'Chat not found' });
    const settings = await getSettings();
    if (!settings.comfy?.enabled) return json(res, 400, { error: 'Image generation is disabled in Settings' });

    const body = await readJson(req, 1_000_000);
    const idea = String(body.idea || body.prompt || '').trim();
    if (!idea) return json(res, 400, { error: 'idea required' });

    // Append user message if requested (default true)
    if (body.saveUserMessage !== false) {
      chat.messages = chat.messages || [];
      chat.messages.push({
        id: id('msg'),
        role: 'user',
        content: idea,
        createdAt: new Date().toISOString(),
        attachments: [],
      });
      if (!chat.title || chat.title === 'New chat' || / chat$/.test(chat.title)) {
        chat.title = idea.slice(0, 48) + (idea.length > 48 ? '…' : '');
      }
    }

    // Convert casual request → prompt via LLM when needed.
    // Prefer the user's idea directly when it already looks visual — avoids censored cloud LLMs.
    let prompt = String(body.prompt || '').trim();
    let negative = body.negative != null ? String(body.negative) : settings.comfy.negative;
    const fallbackPrompt = stripImageAskFraming(idea);
    const looksReady =
      ((prompt.match(/,/g) || []).length >= 3) ||
      /^(1girl|1boy|solo|masterpiece)\b/i.test(prompt);

    if (!prompt || !looksReady) {
      if (!prompt && ideaLooksVisualEnough(fallbackPrompt)) {
        prompt = fallbackPrompt;
      } else {
        const provider = activeLlmProvider(settings);
        if (!provider?.baseUrl) {
          // No LLM — still generate with the raw idea
          prompt = fallbackPrompt || idea;
        } else {
          try {
            const convertBody = JSON.stringify({
              model: provider.defaultModel || settings.defaultModel,
              temperature: 0.4,
              max_tokens: 700,
              messages: [
                { role: 'system', content: PROMPT_CONVERT_SYSTEM },
                { role: 'user', content: `Request:\n${idea}` },
              ],
            });
            const url = new URL(`${provider.baseUrl}/chat/completions`);
            const lib = url.protocol === 'https:' ? https : http;
            const headers = {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'Content-Length': Buffer.byteLength(convertBody),
            };
            if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
            else if (provider.kind === 'lmstudio') headers.Authorization = 'Bearer lm-studio';

            const raw = await new Promise((resolve, reject) => {
              const req2 = lib.request(
                {
                  protocol: url.protocol,
                  hostname: url.hostname,
                  port: url.port || (url.protocol === 'https:' ? 443 : 80),
                  path: url.pathname + url.search,
                  method: 'POST',
                  headers,
                },
                (r) => {
                  const chunks = [];
                  r.on('data', (c) => chunks.push(c));
                  r.on('end', () =>
                    resolve({ status: r.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }),
                  );
                },
              );
              req2.on('error', reject);
              req2.write(convertBody);
              req2.end();
            });
            if (raw.status >= 400) {
              // Cloud LLM blocked or failed — fall through to raw idea
              prompt = fallbackPrompt || idea;
            } else {
              const parsed = JSON.parse(raw.body);
              const content = String(parsed.choices?.[0]?.message?.content || '').trim();
              if (looksLikeLlmRefusal(content)) {
                prompt = fallbackPrompt || idea;
              } else {
                try {
                  const obj = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''));
                  const converted = String(obj.prompt || obj.positive || '').trim();
                  if (!converted || looksLikeLlmRefusal(converted)) {
                    prompt = fallbackPrompt || idea;
                  } else {
                    prompt = converted;
                    negative = String(obj.negative || negative).trim();
                  }
                } catch {
                  prompt = looksLikeLlmRefusal(content) ? fallbackPrompt || idea : content || fallbackPrompt || idea;
                }
              }
            }
          } catch {
            prompt = fallbackPrompt || idea;
          }
        }
      }
    }
    if (!prompt) prompt = fallbackPrompt || idea;

    chat.messages.push({
      id: id('msg'),
      role: 'assistant',
      content: `Generating image…\n\n**Prompt:**\n> ${prompt}`,
      createdAt: new Date().toISOString(),
    });
    chat.updatedAt = new Date().toISOString();
    await writeJsonFile(file, chat);

    try {
      const runSettings = comfy.normalizeComfySettings({
        ...settings.comfy,
        ...(body.checkpoint ? { checkpoint: body.checkpoint } : {}),
        ...(body.loras ? { loras: body.loras } : {}),
      });
      const result = await comfy.generateImage(runSettings, {
        prompt,
        negative,
        seed: body.seed,
        sizePreset: body.sizePreset,
        style: body.style,
        steps: body.steps,
        cfg: body.cfg,
        loras: body.loras,
        checkpoint: body.checkpoint,
      });

      const mediaId = id('media');
      const ext = path.extname(result.image.filename || '') || '.png';
      const storedName = `${mediaId}${ext}`;
      await fsp.writeFile(path.join(PATHS.media, storedName), result.image.data);
      const item = {
        id: mediaId,
        filename: result.image.filename || storedName,
        storedName,
        mimeType: result.image.mimeType || 'image/png',
        size: result.image.data.length,
        kind: 'image',
        url: `/api/media/${mediaId}`,
        source: 'comfyui',
        prompt: result.prompt || prompt,
        negative: result.negative || negative,
        seed: result.seed,
        promptId: result.promptId,
        checkpoint: result.model || runSettings.checkpoint,
        loras: result.loras || [],
        settings: result.settings || null,
        createdAt: new Date().toISOString(),
      };
      await addGalleryItem(item);

      // Replace the "Generating…" bubble with the final image message
      const latest = await readJsonFile(file);
      if (latest) {
        const genIdx = [...(latest.messages || [])]
          .map((m, i) => ({ m, i }))
          .reverse()
          .find((x) => x.m.role === 'assistant' && String(x.m.content || '').startsWith('Generating image'))?.i;
        const imageMsg = {
          id: id('msg'),
          role: 'assistant',
          content: `![generated image](${item.url})\n\n*${(item.prompt || '').slice(0, 220)}${(item.prompt || '').length > 220 ? '…' : ''}* · seed \`${item.seed}\` · \`${item.checkpoint}\``,
          createdAt: new Date().toISOString(),
          attachments: [{ id: item.id, url: item.url, kind: 'image', filename: item.filename }],
          imageGen: {
            seed: item.seed,
            promptId: item.promptId,
            checkpoint: item.checkpoint,
            loras: item.loras,
            prompt: item.prompt,
            negative: item.negative,
            settings: item.settings,
          },
        };
        if (genIdx != null) latest.messages[genIdx] = imageMsg;
        else latest.messages.push(imageMsg);
        latest.updatedAt = new Date().toISOString();
        await writeJsonFile(file, latest);
        return json(res, 200, {
          ok: true,
          chat: latest,
          image: item,
          prompt: item.prompt,
          negative: item.negative,
          seed: item.seed,
        });
      }

      return json(res, 200, { ok: true, image: item, prompt, seed: result.seed });
    } catch (err) {
      const latest = await readJsonFile(file);
      if (latest) {
        latest.messages.push({
          id: id('msg'),
          role: 'assistant',
          content: `Image generation failed: ${err.message || 'unknown error'}`,
          createdAt: new Date().toISOString(),
        });
        latest.updatedAt = new Date().toISOString();
        await writeJsonFile(file, latest);
        return json(res, err.status || 502, { error: err.message, chat: latest });
      }
      return json(res, err.status || 502, { error: err.message });
    }
  }

  if (method === 'POST' && p === '/api/comfy/prompt-from-chat') {
    if (!requireSameOrigin(req, res)) return;
    const body = await readJson(req);
    const idea = String(body.idea || '').trim();
    if (!idea) return json(res, 400, { error: 'idea required' });

    const settings = await getSettings();
    const provider = activeLlmProvider(settings);
    if (!provider?.baseUrl) {
      return json(res, 400, { error: 'Configure an LLM in Settings → Models first' });
    }

    const checkpoint = settings.comfy?.checkpoint || '';
    const fallbackPrompt = stripImageAskFraming(idea);
    const system = [
      PROMPT_CONVERT_SYSTEM,
      checkpoint ? `Preferred checkpoint context: ${checkpoint}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    // Visual enough already — skip censored cloud convert
    if (ideaLooksVisualEnough(fallbackPrompt)) {
      return json(res, 200, {
        prompt: fallbackPrompt,
        negative: settings.comfy?.negative || '',
        idea,
        skippedLlm: true,
      });
    }

    try {
      const payload = JSON.stringify({
        model: provider.defaultModel || settings.defaultModel,
        temperature: 0.4,
        max_tokens: 700,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: `Convert this request into prompt + negative JSON:\n\n${idea}`,
          },
        ],
      });
      const url = new URL(`${provider.baseUrl}/chat/completions`);
      const lib = url.protocol === 'https:' ? https : http;
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      };
      if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
      else if (provider.kind === 'lmstudio') headers.Authorization = 'Bearer lm-studio';

      const raw = await new Promise((resolve, reject) => {
        const req2 = lib.request(
          {
            protocol: url.protocol,
            hostname: url.hostname,
            port: url.port || (url.protocol === 'https:' ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers,
          },
          (r) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () =>
              resolve({ status: r.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }),
            );
          },
        );
        req2.on('error', reject);
        req2.write(payload);
        req2.end();
      });

      if (raw.status >= 400) {
        // Fall back so Studio "From chat" still works when the LLM refuses
        return json(res, 200, {
          prompt: fallbackPrompt || idea,
          negative: settings.comfy?.negative || '',
          idea,
          fallback: true,
        });
      }
      let parsed;
      try {
        parsed = JSON.parse(raw.body);
      } catch {
        return json(res, 200, {
          prompt: fallbackPrompt || idea,
          negative: settings.comfy?.negative || '',
          idea,
          fallback: true,
        });
      }
      const content = String(parsed.choices?.[0]?.message?.content || '').trim();
      let prompt = '';
      let negative = settings.comfy?.negative || '';
      if (looksLikeLlmRefusal(content)) {
        return json(res, 200, { prompt: fallbackPrompt || idea, negative, idea, fallback: true });
      }
      try {
        const cleaned = content.replace(/^```(?:json)?\s*|\s*```$/g, '');
        const obj = JSON.parse(cleaned);
        prompt = String(obj.prompt || obj.positive || obj.positive_prompt || '').trim();
        negative = String(obj.negative || obj.negative_prompt || negative).trim();
      } catch {
        prompt = content.replace(/^["']|["']$/g, '').trim();
      }
      if (!prompt || looksLikeLlmRefusal(prompt)) {
        prompt = fallbackPrompt || idea;
      }
      return json(res, 200, { prompt, negative, idea });
    } catch (err) {
      return json(res, 200, {
        prompt: fallbackPrompt || idea,
        negative: settings.comfy?.negative || '',
        idea,
        fallback: true,
        warning: err.message || 'convert failed',
      });
    }
  }

  if (method === 'POST' && p === '/api/comfy/generate') {
    if (!requireSameOrigin(req, res)) return;
    const settings = await getSettings();
    if (!settings.comfy.enabled) return json(res, 400, { error: 'Image generation disabled in settings' });
    const body = await readJson(req, 1_000_000);
    const prompt = String(body.prompt || body.idea || '').trim();
    if (!prompt) return json(res, 400, { error: 'prompt required' });

    const runSettings = comfy.normalizeComfySettings({
      ...settings.comfy,
      ...(body.checkpoint ? { checkpoint: body.checkpoint } : {}),
      ...(body.width ? { width: body.width } : {}),
      ...(body.height ? { height: body.height } : {}),
      ...(body.steps ? { steps: body.steps } : {}),
      ...(body.cfg != null ? { cfg: body.cfg } : {}),
      ...(body.sampler ? { sampler: body.sampler } : {}),
      ...(body.scheduler ? { scheduler: body.scheduler } : {}),
      ...(body.loras ? { loras: body.loras } : {}),
      ...(body.negative != null && body.persistNegative ? { negative: body.negative } : {}),
    });

    try {
      const result = await comfy.generateImage(runSettings, {
        prompt,
        negative: body.negative,
        seed: body.seed,
        timeoutMs: body.timeoutMs,
        loras: body.loras,
        sizePreset: body.sizePreset,
        style: body.style,
        checkpoint: body.checkpoint,
        width: body.width,
        height: body.height,
        steps: body.steps,
        cfg: body.cfg,
        sampler: body.sampler,
        scheduler: body.scheduler,
      });
      const mediaId = id('media');
      const ext = path.extname(result.image.filename || '') || '.png';
      const storedName = `${mediaId}${ext}`;
      await fsp.writeFile(path.join(PATHS.media, storedName), result.image.data);
      const item = {
        id: mediaId,
        filename: result.image.filename || storedName,
        storedName,
        mimeType: result.image.mimeType || 'image/png',
        size: result.image.data.length,
        kind: 'image',
        url: `/api/media/${mediaId}`,
        source: 'comfyui',
        prompt: result.prompt || prompt,
        negative: result.negative,
        seed: result.seed,
        promptId: result.promptId,
        checkpoint: result.model || runSettings.checkpoint,
        loras: result.loras || [],
        settings: result.settings || null,
        createdAt: new Date().toISOString(),
      };
      await addGalleryItem(item);

      let chatMessage = null;
      if (body.chatId) {
        const chatId = safeId(body.chatId);
        const file = path.join(PATHS.chats, `${chatId}.json`);
        const chat = await readJsonFile(file);
        if (chat) {
          const caption = (result.prompt || prompt).slice(0, 200);
          chatMessage = {
            id: id('msg'),
            role: 'assistant',
            content: `![generated image](${item.url})\n\n*${caption}${caption.length >= 200 ? '…' : ''}* · seed \`${result.seed}\` · \`${item.checkpoint}\``,
            createdAt: new Date().toISOString(),
            attachments: [{ id: item.id, url: item.url, kind: 'image', filename: item.filename }],
            imageGen: {
              seed: result.seed,
              promptId: result.promptId,
              checkpoint: item.checkpoint,
              loras: item.loras,
              prompt: result.prompt || prompt,
              negative: result.negative || '',
              settings: result.settings || null,
            },
          };
          chat.messages = chat.messages || [];
          chat.messages.push(chatMessage);
          chat.updatedAt = new Date().toISOString();
          await writeJsonFile(file, chat);
        }
      }

      return json(res, 200, {
        ok: true,
        image: item,
        seed: result.seed,
        promptId: result.promptId,
        prompt: result.prompt,
        negative: result.negative,
        model: result.model,
        loras: result.loras,
        settings: result.settings,
        message: chatMessage,
      });
    } catch (err) {
      return json(res, err.status || 502, { error: err.message });
    }
  }

  // Library: personas
  if (method === 'GET' && p === '/api/personas') {
    return json(res, 200, { items: await listJsonDir(PATHS.personas) });
  }
  if (method === 'POST' && p === '/api/personas') {
    if (!requireSameOrigin(req, res)) return;
    const body = await readJson(req);
    const item = {
      id: id('persona'),
      name: String(body.name || 'Persona').slice(0, 80),
      description: String(body.description || '').slice(0, 2000),
      about: String(body.about || '').slice(0, 4000),
      avatar: String(body.avatar || '').slice(0, 500),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFile(path.join(PATHS.personas, `${item.id}.json`), item);
    return json(res, 201, item);
  }
  if ((method === 'PUT' || method === 'DELETE') && p.startsWith('/api/personas/')) {
    if (!requireSameOrigin(req, res)) return;
    const pid = safeId(p.slice('/api/personas/'.length));
    const file = path.join(PATHS.personas, `${pid}.json`);
    if (method === 'DELETE') {
      await fsp.unlink(file).catch(() => {});
      return json(res, 200, { ok: true });
    }
    const body = await readJson(req);
    const prev = (await readJsonFile(file)) || { id: pid, createdAt: new Date().toISOString() };
    const item = {
      ...prev,
      name: String(body.name ?? prev.name ?? 'Persona').slice(0, 80),
      description: String(body.description ?? prev.description ?? '').slice(0, 2000),
      about: String(body.about ?? prev.about ?? '').slice(0, 4000),
      avatar: String(body.avatar ?? prev.avatar ?? '').slice(0, 500),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFile(file, item);
    return json(res, 200, item);
  }

  // Library: characters
  if (method === 'GET' && p === '/api/characters') {
    return json(res, 200, { items: await listJsonDir(PATHS.characters) });
  }
  if (method === 'POST' && p === '/api/characters') {
    if (!requireSameOrigin(req, res)) return;
    const body = await readJson(req);
    const item = {
      id: id('char'),
      name: String(body.name || 'Character').slice(0, 80),
      description: String(body.description || '').slice(0, 4000),
      personality: String(body.personality || '').slice(0, 4000),
      scenario: String(body.scenario || '').slice(0, 4000),
      firstMessage: String(body.firstMessage || '').slice(0, 8000),
      exampleDialogue: String(body.exampleDialogue || '').slice(0, 8000),
      systemPrompt: String(body.systemPrompt || '').slice(0, 8000),
      tags: Array.isArray(body.tags) ? body.tags.map((t) => String(t).slice(0, 40)).slice(0, 20) : [],
      avatar: String(body.avatar || '').slice(0, 500),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFile(path.join(PATHS.characters, `${item.id}.json`), item);
    return json(res, 201, item);
  }
  if ((method === 'PUT' || method === 'DELETE') && p.startsWith('/api/characters/')) {
    if (!requireSameOrigin(req, res)) return;
    const cid = safeId(p.slice('/api/characters/'.length));
    const file = path.join(PATHS.characters, `${cid}.json`);
    if (method === 'DELETE') {
      await fsp.unlink(file).catch(() => {});
      return json(res, 200, { ok: true });
    }
    const body = await readJson(req);
    const prev = (await readJsonFile(file)) || { id: cid, createdAt: new Date().toISOString() };
    const item = {
      ...prev,
      name: String(body.name ?? prev.name ?? 'Character').slice(0, 80),
      description: String(body.description ?? prev.description ?? '').slice(0, 4000),
      personality: String(body.personality ?? prev.personality ?? '').slice(0, 4000),
      scenario: String(body.scenario ?? prev.scenario ?? '').slice(0, 4000),
      firstMessage: String(body.firstMessage ?? prev.firstMessage ?? '').slice(0, 8000),
      exampleDialogue: String(body.exampleDialogue ?? prev.exampleDialogue ?? '').slice(0, 8000),
      systemPrompt: String(body.systemPrompt ?? prev.systemPrompt ?? '').slice(0, 8000),
      tags: Array.isArray(body.tags)
        ? body.tags.map((t) => String(t).slice(0, 40)).slice(0, 20)
        : prev.tags || [],
      avatar: String(body.avatar ?? prev.avatar ?? '').slice(0, 500),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFile(file, item);
    return json(res, 200, item);
  }

  // Presets
  if (method === 'GET' && p === '/api/presets') {
    return json(res, 200, { items: await listJsonDir(PATHS.presets) });
  }
  if (method === 'POST' && p === '/api/presets') {
    if (!requireSameOrigin(req, res)) return;
    const body = await readJson(req);
    const item = {
      id: id('preset'),
      name: String(body.name || 'Preset').slice(0, 80),
      systemPrompt: String(body.systemPrompt || '').slice(0, 8000),
      stylePrompt: String(body.stylePrompt || '').slice(0, 4000),
      temperature: Number(body.temperature ?? 0.8),
      topP: Number(body.topP ?? 0.95),
      maxTokens: Number(body.maxTokens ?? 4096),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFile(path.join(PATHS.presets, `${item.id}.json`), item);
    return json(res, 201, item);
  }
  if ((method === 'PUT' || method === 'DELETE') && p.startsWith('/api/presets/')) {
    if (!requireSameOrigin(req, res)) return;
    const prid = safeId(p.slice('/api/presets/'.length));
    const file = path.join(PATHS.presets, `${prid}.json`);
    if (method === 'DELETE') {
      await fsp.unlink(file).catch(() => {});
      return json(res, 200, { ok: true });
    }
    const body = await readJson(req);
    const prev = (await readJsonFile(file)) || { id: prid, createdAt: new Date().toISOString() };
    const item = {
      ...prev,
      name: String(body.name ?? prev.name ?? 'Preset').slice(0, 80),
      systemPrompt: String(body.systemPrompt ?? prev.systemPrompt ?? '').slice(0, 8000),
      stylePrompt: String(body.stylePrompt ?? prev.stylePrompt ?? '').slice(0, 4000),
      temperature: Number(body.temperature ?? prev.temperature ?? 0.8),
      topP: Number(body.topP ?? prev.topP ?? 0.95),
      maxTokens: Number(body.maxTokens ?? prev.maxTokens ?? 4096),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFile(file, item);
    return json(res, 200, item);
  }

  // Folders
  if (method === 'GET' && p === '/api/folders') {
    return json(res, 200, { items: await folders.list(PATHS.folders) });
  }
  if (method === 'POST' && p === '/api/folders') {
    if (!requireSameOrigin(req, res)) return;
    const body = await readJson(req);
    const item = await folders.create(PATHS.folders, body);
    return json(res, 201, item);
  }
  if ((method === 'PATCH' || method === 'PUT' || method === 'DELETE') && p.startsWith('/api/folders/')) {
    if (!requireSameOrigin(req, res)) return;
    const fid = folders.assertFolderId(p.slice('/api/folders/'.length).split('/')[0]);
    if (method === 'DELETE') {
      await folders.remove(PATHS.folders, fid);
      const chats = await listJsonDir(PATHS.chats);
      for (const chat of chats) {
        if (chat && chat.folderId === fid) {
          chat.folderId = null;
          chat.updatedAt = new Date().toISOString();
          await writeJsonFile(path.join(PATHS.chats, `${chat.id}.json`), chat);
        }
      }
      return json(res, 200, { ok: true });
    }
    const body = await readJson(req);
    const item = await folders.update(PATHS.folders, fid, body);
    return json(res, 200, item);
  }

  // Chats
  if (method === 'GET' && p === '/api/chats') {
    const items = await listJsonDir(PATHS.chats);
    const summaries = items.map((c) => ({
      id: c.id,
      title: c.title,
      characterId: c.characterId,
      personaId: c.personaId,
      modeId: resolveModeId(c.modeId || 'chat'),
      model: c.model,
      folderId: c.folderId || null,
      pinned: Boolean(c.pinned),
      updatedAt: c.updatedAt,
      createdAt: c.createdAt,
      messageCount: (c.messages || []).length,
      preview: (c.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant').slice(-1)[0]?.content?.slice(0, 120) || '',
    }));
    summaries.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
    return json(res, 200, { items: summaries });
  }

  if (method === 'POST' && p === '/api/chats') {
    if (!requireSameOrigin(req, res)) return;
    const body = await readJson(req);
    const settings = await getSettings();
    const modeId = resolveModeId(body.modeId || settings.activeMode || 'chat');
    const mode = getMode(modeId);
    const characterId = body.characterId !== undefined
      ? body.characterId
      : mode.layout.showCharacter
        ? settings.defaultCharacterId
        : null;
    const personaId = body.personaId !== undefined
      ? body.personaId
      : mode.layout.showPersona
        ? settings.defaultPersonaId
        : null;
    let folderId = null;
    if (body.folderId) {
      folderId = folders.assertFolderId(body.folderId);
      const folderExists = await folders.get(PATHS.folders, folderId);
      if (!folderExists) return json(res, 400, { error: 'Folder not found' });
    }
    const inherit = Boolean(folderId);
    const presetId =
      body.presetId !== undefined
        ? body.presetId || null
        : inherit
          ? null
          : settings.defaultPresetId || null;
    const character = characterId ? await readJsonFile(path.join(PATHS.characters, `${characterId}.json`)) : null;
    const chat = {
      id: id('chat'),
      title: String(body.title || character?.name || `${mode.name} chat`).slice(0, 120),
      modeId,
      characterId: characterId || null,
      personaId: personaId || null,
      presetId: presetId || null,
      folderId,
      model: inherit
        ? nullableSamplingString(body.model, null)
        : String(
            body.model ||
              settings.defaultModel ||
              activeLlmProvider(settings)?.defaultModel ||
              '',
          ).trim(),
      temperature: inherit
        ? nullableSamplingNumber(body.temperature, null)
        : Number(body.temperature ?? mode.defaults.temperature ?? 0.8),
      topP: inherit
        ? nullableSamplingNumber(body.topP, null)
        : Number(body.topP ?? mode.defaults.topP ?? 0.95),
      maxTokens: inherit
        ? nullableSamplingNumber(body.maxTokens, null)
        : Number(body.maxTokens ?? mode.defaults.maxTokens ?? 4096),
      pinned: false,
      storyNotes: String(body.storyNotes || ''),
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (character?.firstMessage && mode.layout.showCharacter) {
      chat.messages.push({
        id: id('msg'),
        role: 'assistant',
        content: character.firstMessage,
        createdAt: new Date().toISOString(),
      });
    }
    await writeJsonFile(path.join(PATHS.chats, `${chat.id}.json`), chat);
    if (modeId === 'code') {
      await workspace.ensureWorkspace(PATHS.workspaces, chat.id).catch(() => {});
    }
    return json(res, 201, chat);
  }

  if (p.startsWith('/api/chats/')) {
    const rest = p.slice('/api/chats/'.length);
    const parts = rest.split('/').filter(Boolean);
    const chatId = safeId(parts[0]);
    const action = parts[1] || '';
    const sub = parts[2] || '';
    const file = path.join(PATHS.chats, `${chatId}.json`);
    const chat = await readJsonFile(file);
    if (!chat) return json(res, 404, { error: 'Chat not found' });

    if (method === 'GET' && !action) {
      return json(res, 200, chat);
    }

    if (method === 'PATCH' && !action) {
      if (!requireSameOrigin(req, res)) return;
      const body = await readJson(req);
      let nextFolderId = chat.folderId || null;
      if (body.folderId !== undefined) {
        if (body.folderId === null || body.folderId === '') {
          nextFolderId = null;
        } else {
          nextFolderId = folders.assertFolderId(body.folderId);
          const folderExists = await folders.get(PATHS.folders, nextFolderId);
          if (!folderExists) return json(res, 400, { error: 'Folder not found' });
        }
      }
      const next = {
        ...chat,
        title: body.title !== undefined ? String(body.title).slice(0, 120) : chat.title,
        modeId: body.modeId ? resolveModeId(body.modeId) : resolveModeId(chat.modeId || 'chat'),
        characterId: body.characterId !== undefined ? body.characterId : chat.characterId,
        personaId: body.personaId !== undefined ? body.personaId : chat.personaId,
        presetId: body.presetId !== undefined ? body.presetId : chat.presetId,
        folderId: nextFolderId,
        model:
          body.model !== undefined
            ? body.model === null || body.model === ''
              ? null
              : String(body.model).slice(0, 120)
            : chat.model,
        temperature:
          body.temperature !== undefined
            ? body.temperature === null || body.temperature === ''
              ? null
              : Number(body.temperature)
            : chat.temperature,
        topP:
          body.topP !== undefined
            ? body.topP === null || body.topP === ''
              ? null
              : Number(body.topP)
            : chat.topP,
        maxTokens:
          body.maxTokens !== undefined
            ? body.maxTokens === null || body.maxTokens === ''
              ? null
              : Number(body.maxTokens)
            : chat.maxTokens,
        pinned: body.pinned !== undefined ? Boolean(body.pinned) : chat.pinned,
        storyNotes: body.storyNotes !== undefined ? String(body.storyNotes).slice(0, 20_000) : chat.storyNotes,
        messages: Array.isArray(body.messages) ? body.messages : chat.messages,
        updatedAt: new Date().toISOString(),
      };
      await writeJsonFile(file, next);
      if (next.modeId === 'code') {
        await workspace.ensureWorkspace(PATHS.workspaces, chatId).catch(() => {});
      }
      return json(res, 200, next);
    }

    if (method === 'DELETE' && !action) {
      if (!requireSameOrigin(req, res)) return;
      const ctrl = activeStreams.get(chatId);
      if (ctrl) ctrl.abort();
      await fsp.unlink(file).catch(() => {});
      await workspace.removeWorkspace(PATHS.workspaces, chatId).catch(() => {});
      return json(res, 200, { ok: true });
    }

    // Workspace: /api/chats/:id/workspace[/file|import-zip|export-zip]
    if (action === 'workspace') {
      try {
        if (method === 'GET' && !sub) {
          await workspace.ensureWorkspace(PATHS.workspaces, chatId);
          const files = await workspace.listFiles(PATHS.workspaces, chatId);
          const openPath = files.some((f) => f.path === 'scratch.md') ? 'scratch.md' : files[0]?.path || null;
          return json(res, 200, { files, openPath });
        }

        if (method === 'GET' && sub === 'file') {
          const rel = url.searchParams.get('path') || '';
          const data = await workspace.readFile(PATHS.workspaces, chatId, rel);
          return json(res, 200, data);
        }

        if (method === 'PUT' && sub === 'file') {
          if (!requireSameOrigin(req, res)) return;
          const body = await readJson(req, 2_500_000);
          const rel = String(body.path || '');
          const content = body.content == null ? '' : String(body.content);
          const meta = await workspace.writeFile(PATHS.workspaces, chatId, rel, content);
          return json(res, 200, meta);
        }

        if (method === 'DELETE' && sub === 'file') {
          if (!requireSameOrigin(req, res)) return;
          const rel = url.searchParams.get('path') || '';
          await workspace.deleteFile(PATHS.workspaces, chatId, rel);
          await workspace.ensureWorkspace(PATHS.workspaces, chatId);
          return json(res, 200, { ok: true });
        }

        if (method === 'POST' && sub === 'import-zip') {
          if (!requireSameOrigin(req, res)) return;
          const ctype = req.headers['content-type'] || '';
          if (!ctype.includes('multipart/form-data')) {
            return json(res, 400, { error: 'multipart/form-data required' });
          }
          const boundaryMatch = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
          const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
          if (!boundary) return json(res, 400, { error: 'Missing boundary' });
          const buf = await readBody(req, MAX_UPLOAD_BYTES + 64_000);
          const formParts = parseMultipart(buf, boundary);
          const filePart = formParts.find((part) => part.filename);
          if (!filePart) return json(res, 400, { error: 'No file' });
          if (filePart.data.length > MAX_UPLOAD_BYTES) return json(res, 413, { error: 'File too large' });
          const modeField = formParts.find((part) => !part.filename && part.name === 'mode');
          const importMode = String(modeField?.data?.toString('utf8') || 'merge').toLowerCase() === 'replace'
            ? 'replace'
            : 'merge';
          const result = await workspace.importZip(PATHS.workspaces, chatId, filePart.data, { mode: importMode });
          const writtenCount = Array.isArray(result.written) ? result.written.length : 0;
          return json(res, 201, {
            ok: true,
            mode: importMode,
            entries: writtenCount,
            written: writtenCount,
            skipped: result.skipped || [],
          });
        }

        if (method === 'GET' && sub === 'export-zip') {
          const zipBuf = await workspace.exportZip(PATHS.workspaces, chatId);
          const filename = `${String(chat.title || 'project')
            .replace(/[^\w.-]+/g, '_')
            .slice(0, 40) || 'project'}.zip`;
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': zipBuf.length,
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-store',
          });
          res.end(zipBuf);
          return;
        }
      } catch (err) {
        const status = err.status || (err.code === 'ZIP_TOO_LARGE' || err.code === 'ZIP_TOO_MANY' ? 413 : 400);
        return json(res, status, { error: err.message || 'Workspace error' });
      }
    }

    if (method === 'POST' && action === 'stop') {
      if (!requireSameOrigin(req, res)) return;
      const ctrl = activeStreams.get(chatId);
      if (ctrl) ctrl.abort();
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && action === 'message') {
      if (!requireSameOrigin(req, res)) return;
      const body = await readJson(req, 1_000_000);
      const content = String(body.content || '').trim();
      if (!content) return json(res, 400, { error: 'Message required' });
      if (content.length > MAX_MESSAGE_CHARS) return json(res, 400, { error: 'Message too long' });

      if (activeStreams.has(chatId)) {
        return json(res, 409, { error: 'Chat is already generating' });
      }

      const folder = await loadChatFolder(chat);
      const character = chat.characterId
        ? await readJsonFile(path.join(PATHS.characters, `${chat.characterId}.json`))
        : null;
      const persona = chat.personaId
        ? await readJsonFile(path.join(PATHS.personas, `${chat.personaId}.json`))
        : null;
      const settingsForPreset = await getSettings();
      const presetId = pickInherit(chat.presetId, folder?.presetId, settingsForPreset.defaultPresetId);
      const preset = presetId
        ? await readJsonFile(path.join(PATHS.presets, `${presetId}.json`))
        : null;
      const mode = getMode(chat.modeId || 'chat');

      const userMsg = {
        id: id('msg'),
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
        attachments: Array.isArray(body.attachments) ? body.attachments.slice(0, 10) : [],
      };
      chat.messages.push(userMsg);
      if (chat.title === 'New chat' || chat.title === (character?.name || '') || / chat$/.test(chat.title || '')) {
        chat.title = content.slice(0, 48) + (content.length > 48 ? '…' : '');
      }
      chat.updatedAt = new Date().toISOString();
      await writeJsonFile(file, chat);

      const messages = await assembleMessages({
        chat,
        character,
        persona,
        preset,
        mode,
        folder,
        openPath: body.openPath || undefined,
      });

      const controller = new AbortController();
      activeStreams.set(chatId, controller);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const sendEvent = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sendEvent('user', { message: userMsg, chatId, title: chat.title });

      const assistantMsg = {
        id: id('msg'),
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
      };

      const ownsStream = () => activeStreams.get(chatId) === controller;

      try {
        const settingsForModel = await getSettings();
        const gen = resolveGenerationParams({ chat, folder, mode, settings: settingsForModel, body });
        const full = await streamChatCompletions({
          messages,
          model: gen.model,
          temperature: gen.temperature,
          topP: gen.topP,
          maxTokens: gen.maxTokens,
          signal: controller.signal,
          onDelta: (delta, fullText) => {
            assistantMsg.content = fullText;
            sendEvent('delta', { id: assistantMsg.id, delta, content: fullText });
          },
        });
        assistantMsg.content = full || assistantMsg.content || '(empty response)';
        // Skip disk write if regenerate/stop superseded this controller
        if (ownsStream()) {
          chat.messages.push(assistantMsg);
          chat.updatedAt = new Date().toISOString();
          await writeJsonFile(file, chat);
          sendEvent('done', { message: assistantMsg, chatId, title: chat.title });
        }
      } catch (err) {
        if (assistantMsg.content && ownsStream()) {
          chat.messages.push(assistantMsg);
          chat.updatedAt = new Date().toISOString();
          await writeJsonFile(file, chat);
        }
        const aborted = String(err.message || '').includes('Aborted');
        sendEvent(aborted ? 'stopped' : 'error', {
          error: aborted ? 'Generation stopped' : err.message || 'Stream failed',
          message: assistantMsg.content ? assistantMsg : null,
        });
      } finally {
        if (ownsStream()) activeStreams.delete(chatId);
        res.end();
      }
      return;
    }

    if (method === 'POST' && action === 'regenerate') {
      if (!requireSameOrigin(req, res)) return;
      const body = await readJson(req, 1_000_000);
      const messageId = String(body.messageId || '').trim();
      if (!messageId) return json(res, 400, { error: 'messageId required' });

      const idx = (chat.messages || []).findIndex((m) => m.id === messageId);
      if (idx < 0) return json(res, 404, { error: 'Message not found' });
      if (chat.messages[idx].role !== 'assistant') {
        return json(res, 400, { error: 'Can only regenerate assistant messages' });
      }

      // Claim stream slot before abort so superseded handlers skip disk writes
      const controller = new AbortController();
      const existing = activeStreams.get(chatId);
      activeStreams.set(chatId, controller);
      if (existing) existing.abort();

      let messages;
      let folder = null;
      let mode = getMode(chat.modeId || 'chat');
      try {
        chat.messages = chat.messages.slice(0, idx);
        chat.updatedAt = new Date().toISOString();
        await writeJsonFile(file, chat);

        folder = await loadChatFolder(chat);
        const character = chat.characterId
          ? await readJsonFile(path.join(PATHS.characters, `${chat.characterId}.json`))
          : null;
        const persona = chat.personaId
          ? await readJsonFile(path.join(PATHS.personas, `${chat.personaId}.json`))
          : null;
        const settingsForPreset = await getSettings();
        const presetId = pickInherit(chat.presetId, folder?.presetId, settingsForPreset.defaultPresetId);
        const preset = presetId
          ? await readJsonFile(path.join(PATHS.presets, `${presetId}.json`))
          : null;
        mode = getMode(chat.modeId || 'chat');

        messages = await assembleMessages({
          chat,
          character,
          persona,
          preset,
          mode,
          folder,
          openPath: body.openPath || undefined,
        });
      } catch (err) {
        if (activeStreams.get(chatId) === controller) activeStreams.delete(chatId);
        return json(res, err.status || 500, { error: err.message || 'Regenerate failed' });
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const sendEvent = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      sendEvent('truncate', { chatId, messages: chat.messages, title: chat.title });

      const assistantMsg = {
        id: id('msg'),
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
      };

      const ownsStream = () => activeStreams.get(chatId) === controller;

      try {
        const settingsForModel = await getSettings();
        const gen = resolveGenerationParams({ chat, folder, mode, settings: settingsForModel, body });
        const full = await streamChatCompletions({
          messages,
          model: gen.model,
          temperature: gen.temperature,
          topP: gen.topP,
          maxTokens: gen.maxTokens,
          signal: controller.signal,
          onDelta: (delta, fullText) => {
            assistantMsg.content = fullText;
            sendEvent('delta', { id: assistantMsg.id, delta, content: fullText });
          },
        });
        assistantMsg.content = full || assistantMsg.content || '(empty response)';
        if (ownsStream()) {
          chat.messages.push(assistantMsg);
          chat.updatedAt = new Date().toISOString();
          await writeJsonFile(file, chat);
          sendEvent('done', { message: assistantMsg, chatId, title: chat.title });
        }
      } catch (err) {
        if (assistantMsg.content && ownsStream()) {
          chat.messages.push(assistantMsg);
          chat.updatedAt = new Date().toISOString();
          await writeJsonFile(file, chat);
        }
        const aborted = String(err.message || '').includes('Aborted');
        sendEvent(aborted ? 'stopped' : 'error', {
          error: aborted ? 'Generation stopped' : err.message || 'Stream failed',
          message: assistantMsg.content ? assistantMsg : null,
        });
      } finally {
        if (ownsStream()) activeStreams.delete(chatId);
        res.end();
      }
      return;
    }

    if (method === 'POST' && action === 'branch') {
      if (!requireSameOrigin(req, res)) return;
      const body = await readJson(req);
      const messageId = String(body.messageId || '').trim();
      if (!messageId) return json(res, 400, { error: 'messageId required' });

      const idx = (chat.messages || []).findIndex((m) => m.id === messageId);
      if (idx < 0) return json(res, 404, { error: 'Message not found' });

      const now = new Date().toISOString();
      const branched = {
        id: id('chat'),
        title: `Branch of ${chat.title || 'chat'}`.slice(0, 120),
        modeId: resolveModeId(chat.modeId || 'chat'),
        characterId: chat.characterId ?? null,
        personaId: chat.personaId ?? null,
        presetId: chat.presetId ?? null,
        model: chat.model || '',
        temperature: chat.temperature,
        topP: chat.topP,
        maxTokens: chat.maxTokens,
        pinned: false,
        storyNotes: chat.storyNotes || '',
        messages: (chat.messages || []).slice(0, idx + 1).map((m) => ({ ...m })),
        createdAt: now,
        updatedAt: now,
      };
      if (chat.folderId) branched.folderId = chat.folderId;
      await writeJsonFile(path.join(PATHS.chats, `${branched.id}.json`), branched);
      return json(res, 201, branched);
    }

    if (method === 'POST' && action === 'prompt-preview') {
      if (!requireSameOrigin(req, res)) return;
      const body = await readJson(req);
      const folder = await loadChatFolder(chat);
      const character = chat.characterId
        ? await readJsonFile(path.join(PATHS.characters, `${chat.characterId}.json`))
        : null;
      const persona = chat.personaId
        ? await readJsonFile(path.join(PATHS.personas, `${chat.personaId}.json`))
        : null;
      const settingsForPreset = await getSettings();
      const presetId = pickInherit(chat.presetId, folder?.presetId, settingsForPreset.defaultPresetId);
      const preset = presetId
        ? await readJsonFile(path.join(PATHS.presets, `${presetId}.json`))
        : null;
      const mode = getMode(chat.modeId || 'chat');
      const messages = await assembleMessages({
        chat,
        character,
        persona,
        preset,
        mode,
        folder,
        userMessage: body.content || '',
        openPath: body.openPath || undefined,
      });
      return json(res, 200, {
        messages,
        system: buildSystemPrompt({
          character,
          persona,
          preset,
          mode,
          folder,
          storyNotes: chat.storyNotes,
        }),
        modeId: mode.id,
        folderId: chat.folderId || null,
      });
    }
  }

  // Gallery + uploads
  if (method === 'GET' && p === '/api/gallery') {
    return json(res, 200, await getGallery());
  }

  if (method === 'POST' && p === '/api/upload') {
    if (!requireSameOrigin(req, res)) return;
    const ctype = req.headers['content-type'] || '';
    if (!ctype.includes('multipart/form-data')) {
      return json(res, 400, { error: 'multipart/form-data required' });
    }
    const boundaryMatch = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
    if (!boundary) return json(res, 400, { error: 'Missing boundary' });
    const buf = await readBody(req, MAX_UPLOAD_BYTES + 64_000);
    const parts = parseMultipart(buf, boundary);
    const filePart = parts.find((part) => part.filename);
    if (!filePart) return json(res, 400, { error: 'No file' });
    if (filePart.data.length > MAX_UPLOAD_BYTES) return json(res, 413, { error: 'File too large' });

    const ext = path.extname(filePart.filename).slice(0, 12) || '';
    const mediaId = id('media');
    const storedName = `${mediaId}${ext}`;
    const dest = path.join(PATHS.media, storedName);
    await fsp.writeFile(dest, filePart.data);
    const item = {
      id: mediaId,
      filename: path.basename(filePart.filename).slice(0, 200),
      storedName,
      mimeType: filePart.mimeType,
      size: filePart.data.length,
      kind: filePart.mimeType.startsWith('image/') ? 'image' : 'file',
      url: `/api/media/${mediaId}`,
      createdAt: new Date().toISOString(),
    };
    await addGalleryItem(item);
    return json(res, 201, item);
  }

  if (method === 'GET' && p.startsWith('/api/media/')) {
    const mediaId = safeId(p.slice('/api/media/'.length).split('/')[0]);
    const gallery = await getGallery();
    const item = (gallery.items || []).find((i) => i.id === mediaId);
    if (!item) return json(res, 404, { error: 'Not found' });
    const filePath = path.join(PATHS.media, item.storedName);
    if (!filePath.startsWith(PATHS.media)) return json(res, 400, { error: 'Bad path' });
    try {
      const data = await fsp.readFile(filePath);
      res.writeHead(200, {
        'Content-Type': item.mimeType || contentType(filePath),
        'Content-Length': data.length,
        'Cache-Control': 'private, max-age=86400',
      });
      res.end(data);
      return;
    } catch {
      return json(res, 404, { error: 'File missing' });
    }
  }

  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `${HOST}:${PORT}`;
    const url = new URL(req.url || '/', `http://${host}`);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    // Gate HTML pages behind auth (except login assets)
    const isPublicAsset =
      url.pathname === '/login.html' ||
      url.pathname === '/app.css' ||
      url.pathname === '/app.js' ||
      url.pathname === '/characters.js' ||
      url.pathname === '/viewport.js' ||
      url.pathname === '/favicon.svg';

    // Friendly route for the characters/personas page
    let staticPath = url.pathname;
    if (staticPath === '/characters' || staticPath === '/personas' || staticPath === '/library') {
      staticPath = '/characters.html';
    }

    if (
      !isPublicAsset &&
      !isAuthed(req) &&
      (staticPath === '/' || staticPath.endsWith('.html'))
    ) {
      res.writeHead(302, { Location: '/login.html' });
      res.end();
      return;
    }

    await serveStatic(req, res, staticPath);
  } catch (err) {
    const status = err.status || 500;
    if (!res.headersSent) json(res, status, { error: err.message || 'Server error' });
    else res.end();
  }
});

server.listen(PORT, HOST, async () => {
  const settings = await getSettings();
  const provider = activeLlmProvider(settings);
  console.log(`Personal WebUI listening on http://${HOST}:${PORT}`);
  console.log(
    `LLM: ${provider?.name || 'none'} · ${provider?.baseUrl || '—'} · model ${provider?.defaultModel || settings.defaultModel || '—'}`,
  );
  console.log(`API key: ${provider?.apiKey ? 'configured' : provider?.requiresKey === false ? 'not required' : 'MISSING'}`);
});
