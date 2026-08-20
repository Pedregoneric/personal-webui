'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const USERNAME_RE = /^[A-Za-z0-9._@+-]{1,64}$/;
const ID_RE = /^[a-zA-Z0-9._-]{1,80}$/;

function usersPath(dataDir) {
  return path.join(dataDir, 'users.json');
}

function sessionsPath(dataDir) {
  return path.join(dataDir, 'sessions.json');
}

function appPath(dataDir) {
  return path.join(dataDir, 'app.json');
}

async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
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

function hashPassword(password, salt = crypto.randomBytes(24).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return timingSafeEqualHex(actual, hash);
}

function newUserId() {
  return `user-${crypto.randomBytes(8).toString('hex')}`;
}

function assertUsername(username) {
  const s = String(username || '').trim();
  if (!USERNAME_RE.test(s)) {
    const err = new Error('Invalid username');
    err.status = 400;
    throw err;
  }
  return s;
}

function assertUserId(userId) {
  const s = String(userId || '');
  if (!ID_RE.test(s) || s.includes('..') || s.includes('/') || s.includes('\\')) {
    const err = new Error('Invalid user id');
    err.status = 400;
    throw err;
  }
  return s;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
  };
}

async function loadUsers(dataDir) {
  const raw = await readJson(usersPath(dataDir), null);
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.users)) return raw.users;
  return [];
}

async function saveUsers(dataDir, list) {
  await writeJsonAtomic(usersPath(dataDir), list);
}

async function listUsers(dataDir) {
  return (await loadUsers(dataDir)).map(publicUser);
}

async function findByUsername(dataDir, username) {
  const want = String(username || '').trim().toLowerCase();
  const list = await loadUsers(dataDir);
  return list.find((u) => String(u.username || '').toLowerCase() === want) || null;
}

async function findById(dataDir, userId) {
  const id = String(userId || '');
  const list = await loadUsers(dataDir);
  return list.find((u) => u.id === id) || null;
}

async function createUser(dataDir, { username, password, role = 'user', salt = null, hash = null } = {}) {
  const name = assertUsername(username);
  if (await findByUsername(dataDir, name)) {
    const err = new Error('Username already taken');
    err.status = 409;
    throw err;
  }
  let creds;
  if (salt && hash) {
    creds = { salt, hash };
  } else {
    const pw = String(password || '');
    if (pw.length < 12 || pw.length > 200) {
      const err = new Error('Password must be 12–200 characters');
      err.status = 400;
      throw err;
    }
    creds = hashPassword(pw);
  }
  const roleNorm = role === 'admin' ? 'admin' : 'user';
  const user = {
    id: newUserId(),
    username: name,
    role: roleNorm,
    salt: creds.salt,
    hash: creds.hash,
    disabled: false,
    createdAt: new Date().toISOString(),
  };
  const list = await loadUsers(dataDir);
  list.push(user);
  await saveUsers(dataDir, list);
  return user;
}

async function setDisabled(dataDir, userId, disabled) {
  const list = await loadUsers(dataDir);
  const user = list.find((u) => u.id === userId);
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  user.disabled = Boolean(disabled);
  await saveUsers(dataDir, list);
  return publicUser(user);
}

async function setRole(dataDir, userId, role) {
  const list = await loadUsers(dataDir);
  const user = list.find((u) => u.id === userId);
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  user.role = role === 'admin' ? 'admin' : 'user';
  await saveUsers(dataDir, list);
  return publicUser(user);
}

async function resetPassword(dataDir, userId, password) {
  const pw = String(password || '');
  if (pw.length < 12 || pw.length > 200) {
    const err = new Error('Password must be 12–200 characters');
    err.status = 400;
    throw err;
  }
  const list = await loadUsers(dataDir);
  const user = list.find((u) => u.id === userId);
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }
  const creds = hashPassword(pw);
  user.salt = creds.salt;
  user.hash = creds.hash;
  await saveUsers(dataDir, list);
  return publicUser(user);
}

function defaultAppConfig() {
  return {
    signupEnabled: false,
    tipUrl: 'https://agentmediatools.com/tip?from=personal-webui',
    brandTitle: 'Personal WebUI',
  };
}

async function loadAppConfig(dataDir) {
  const saved = (await readJson(appPath(dataDir), null)) || {};
  return { ...defaultAppConfig(), ...saved };
}

async function saveAppConfig(dataDir, cfg) {
  const next = { ...defaultAppConfig(), ...(cfg || {}) };
  next.signupEnabled = Boolean(next.signupEnabled);
  next.tipUrl = String(next.tipUrl || defaultAppConfig().tipUrl).slice(0, 500);
  next.brandTitle = String(next.brandTitle || 'Personal WebUI').slice(0, 80);
  await writeJsonAtomic(appPath(dataDir), next);
  return next;
}

function userDataPaths(dataDir, userId) {
  const id = assertUserId(userId);
  const root = path.join(dataDir, 'users', id);
  return {
    root,
    chats: path.join(root, 'chats'),
    personas: path.join(root, 'library', 'personas'),
    characters: path.join(root, 'library', 'characters'),
    presets: path.join(root, 'library', 'presets'),
    media: path.join(root, 'media'),
    uploads: path.join(root, 'uploads'),
    workspaces: path.join(root, 'workspaces'),
    settings: path.join(root, 'settings.json'),
    galleryIndex: path.join(root, 'gallery.json'),
    folders: path.join(root, 'folders.json'),
  };
}

function ensureUserDirs(paths, foldersLib) {
  for (const dir of [
    paths.chats,
    paths.personas,
    paths.characters,
    paths.presets,
    paths.media,
    paths.uploads,
    paths.workspaces,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (foldersLib && typeof foldersLib.ensureStore === 'function') {
    foldersLib.ensureStore(paths.folders);
  }
}

async function moveIfExists(src, dest) {
  if (!fs.existsSync(src)) return false;
  if (fs.existsSync(dest)) return false;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(src, dest);
  return true;
}

/**
 * Idempotent migration: if users.json is missing and .env credentials exist,
 * create an admin and move legacy flat data/ trees into data/users/{adminId}/.
 */
async function migrateFromEnvIfNeeded(dataDir, env = process.env, foldersLib = null) {
  const uPath = usersPath(dataDir);
  if (fs.existsSync(uPath)) {
    return { migrated: false, reason: 'already-migrated' };
  }

  const username = String(env.WEBUI_USERNAME || '').trim();
  const salt = env.PASSWORD_SALT || '';
  const hash = env.PASSWORD_HASH || '';
  if (!username || !salt || !hash) {
    return { migrated: false, reason: 'no-env-credentials' };
  }

  assertUsername(username);
  const admin = {
    id: newUserId(),
    username,
    role: 'admin',
    salt,
    hash,
    disabled: false,
    createdAt: new Date().toISOString(),
  };

  const paths = userDataPaths(dataDir, admin.id);
  await fsp.mkdir(paths.root, { recursive: true });

  const moves = [
    [path.join(dataDir, 'chats'), paths.chats],
    [path.join(dataDir, 'library'), path.join(paths.root, 'library')],
    [path.join(dataDir, 'workspaces'), paths.workspaces],
    [path.join(dataDir, 'media'), paths.media],
    [path.join(dataDir, 'uploads'), paths.uploads],
    [path.join(dataDir, 'settings.json'), paths.settings],
    [path.join(dataDir, 'folders.json'), paths.folders],
    [path.join(dataDir, 'gallery.json'), paths.galleryIndex],
  ];

  for (const [src, dest] of moves) {
    await moveIfExists(src, dest);
  }

  ensureUserDirs(paths, foldersLib);
  await saveUsers(dataDir, [admin]);
  if (!fs.existsSync(sessionsPath(dataDir))) {
    await writeJsonAtomic(sessionsPath(dataDir), []);
  }
  if (!fs.existsSync(appPath(dataDir))) {
    await saveAppConfig(dataDir, defaultAppConfig());
  }

  return { migrated: true, userId: admin.id, username: admin.username };
}

async function hasAnyUsers(dataDir) {
  const list = await loadUsers(dataDir);
  return list.length > 0;
}

module.exports = {
  USERNAME_RE,
  usersPath,
  appPath,
  sessionsPath,
  writeJsonAtomic,
  hashPassword,
  verifyPassword,
  publicUser,
  loadUsers,
  listUsers,
  findByUsername,
  findById,
  createUser,
  setDisabled,
  setRole,
  resetPassword,
  defaultAppConfig,
  loadAppConfig,
  saveAppConfig,
  userDataPaths,
  ensureUserDirs,
  migrateFromEnvIfNeeded,
  hasAnyUsers,
  assertUserId,
  assertUsername,
};
