'use strict';

/**
 * Flat chat folders stored in a single JSON file (array).
 * Null model/temperature/topP/maxTokens/presetId mean "inherit from mode/settings".
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^[a-zA-Z0-9._-]{1,80}$/;
const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$|^[a-z]{1,24}$/;

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertFolderId(value) {
  const s = String(value || '');
  if (!ID_RE.test(s)) throw httpError('Invalid folder id', 400);
  if (s.includes('..') || s.includes('/') || s.includes('\\')) {
    throw httpError('Invalid folder id', 400);
  }
  return s;
}

function newId() {
  return `folder-${crypto.randomBytes(8).toString('hex')}`;
}

function emptyStore() {
  return [];
}

async function readStore(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object' && Array.isArray(data.items)) return data.items;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return Object.values(data).filter((v) => v && typeof v === 'object' && v.id);
    }
    return emptyStore();
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyStore();
    throw err;
  }
}

async function writeStore(filePath, items) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(items, null, 2), 'utf8');
  await fsp.rename(tmp, filePath);
}

function nullableString(value, max) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return String(value).slice(0, max);
}

function nullableNumber(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw httpError('Invalid number', 400);
  return n;
}

function normalizeFolder(input, { isCreate = false } = {}) {
  const now = new Date().toISOString();
  const id = isCreate ? newId() : assertFolderId(input.id);
  const name = String(input.name || (isCreate ? 'New folder' : 'Folder')).slice(0, 80) || 'Folder';
  let color = null;
  if (input.color != null && input.color !== '') {
    const c = String(input.color).slice(0, 32);
    if (!COLOR_RE.test(c)) throw httpError('Invalid color', 400);
    color = c;
  }
  return {
    id,
    name,
    systemPrompt: String(input.systemPrompt || '').slice(0, 8000),
    stylePrompt: String(input.stylePrompt || '').slice(0, 4000),
    model: input.model != null && input.model !== '' ? String(input.model).slice(0, 120) : null,
    temperature: input.temperature != null && input.temperature !== '' ? Number(input.temperature) : null,
    topP: input.topP != null && input.topP !== '' ? Number(input.topP) : null,
    maxTokens: input.maxTokens != null && input.maxTokens !== '' ? Number(input.maxTokens) : null,
    presetId: input.presetId != null && input.presetId !== '' ? assertFolderId(String(input.presetId)) : null,
    color,
    collapsed: Boolean(input.collapsed),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
}

async function list(filePath) {
  const items = await readStore(filePath);
  return items
    .filter((f) => f && typeof f === 'object' && ID_RE.test(String(f.id || '')))
    .slice()
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
}

async function get(filePath, folderId) {
  const id = assertFolderId(folderId);
  const items = await readStore(filePath);
  return items.find((f) => f && f.id === id) || null;
}

async function create(filePath, body = {}) {
  const items = await readStore(filePath);
  const folder = normalizeFolder(body, { isCreate: true });
  if (folder.temperature != null && !Number.isFinite(folder.temperature)) {
    throw httpError('Invalid temperature', 400);
  }
  if (folder.topP != null && !Number.isFinite(folder.topP)) throw httpError('Invalid topP', 400);
  if (folder.maxTokens != null && !Number.isFinite(folder.maxTokens)) {
    throw httpError('Invalid maxTokens', 400);
  }
  items.push(folder);
  await writeStore(filePath, items);
  return folder;
}

async function update(filePath, folderId, body = {}) {
  const id = assertFolderId(folderId);
  const items = await readStore(filePath);
  const idx = items.findIndex((f) => f && f.id === id);
  if (idx < 0) throw httpError('Folder not found', 404);
  const prev = items[idx];
  const next = {
    ...prev,
    name: body.name !== undefined ? String(body.name || 'Folder').slice(0, 80) || 'Folder' : prev.name,
    systemPrompt:
      body.systemPrompt !== undefined ? String(body.systemPrompt || '').slice(0, 8000) : prev.systemPrompt || '',
    stylePrompt:
      body.stylePrompt !== undefined ? String(body.stylePrompt || '').slice(0, 4000) : prev.stylePrompt || '',
    collapsed: body.collapsed !== undefined ? Boolean(body.collapsed) : Boolean(prev.collapsed),
    updatedAt: new Date().toISOString(),
  };

  if (body.model !== undefined) {
    next.model = nullableString(body.model, 120);
  }
  if (body.temperature !== undefined) {
    next.temperature = nullableNumber(body.temperature);
  }
  if (body.topP !== undefined) {
    next.topP = nullableNumber(body.topP);
  }
  if (body.maxTokens !== undefined) {
    next.maxTokens = nullableNumber(body.maxTokens);
  }
  if (body.presetId !== undefined) {
    next.presetId =
      body.presetId === null || body.presetId === '' ? null : assertFolderId(String(body.presetId));
  }
  if (body.color !== undefined) {
    if (body.color === null || body.color === '') {
      next.color = null;
    } else {
      const c = String(body.color).slice(0, 32);
      if (!COLOR_RE.test(c)) throw httpError('Invalid color', 400);
      next.color = c;
    }
  }

  items[idx] = next;
  await writeStore(filePath, items);
  return next;
}

async function remove(filePath, folderId) {
  const id = assertFolderId(folderId);
  const items = await readStore(filePath);
  const next = items.filter((f) => !(f && f.id === id));
  if (next.length === items.length) throw httpError('Folder not found', 404);
  await writeStore(filePath, next);
  return { ok: true, id };
}

/** Ensure the folders file exists (empty array). */
function ensureStore(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '[]\n', 'utf8');
  }
}

module.exports = {
  ID_RE,
  assertFolderId,
  list,
  get,
  create,
  update,
  remove,
  ensureStore,
  normalizeFolder,
};
