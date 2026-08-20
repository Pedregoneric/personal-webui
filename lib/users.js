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

/** Fixed dummy credentials so login always pays scrypt cost when user is missing/disabled. */
const DUMMY_LOGIN_SALT = '00'.repeat(24);
const DUMMY_LOGIN_HASH = crypto.scryptSync('not-a-real-password', DUMMY_LOGIN_SALT, 64).toString('hex');

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

function countEnabledAdmins(list) {
  return list.filter((u) => u.role === 'admin' && !u.disabled).length;
}

function assertKeepsEnabledAdmin(list) {
  if (countEnabledAdmins(list) < 1) {
    const err = new Error('Cannot remove the last admin');
    err.status = 400;
    throw err;
  }
}

/** Apply disabled/role/password in one load→validate→save so combined PATCH cannot partially stick. */
async function patchUser(dataDir, userId, patch = {}) {
  const list = await loadUsers(dataDir);
  const user = list.find((u) => u.id === userId);
  if (!user) {
    const err = new Error('User not found');
    err.status = 404;
    throw err;
  }

  const wasDisabled = Boolean(user.disabled);
  const nextDisabled = patch.disabled !== undefined ? Boolean(patch.disabled) : wasDisabled;
  const nextRole =
    patch.role !== undefined ? (patch.role === 'admin' ? 'admin' : 'user') : user.role === 'admin' ? 'admin' : 'user';

  let creds = null;
  if (patch.password !== undefined) {
    const pw = String(patch.password || '');
    if (pw.length < 12 || pw.length > 200) {
      const err = new Error('Password must be 12–200 characters');
      err.status = 400;
      throw err;
    }
    creds = hashPassword(pw);
  }

  const simulated = list.map((u) =>
    u.id === userId ? { ...u, disabled: nextDisabled, role: nextRole } : u
  );
  assertKeepsEnabledAdmin(simulated);

  user.disabled = nextDisabled;
  user.role = nextRole;
  if (creds) {
    user.salt = creds.salt;
    user.hash = creds.hash;
  }
  await saveUsers(dataDir, list);
  return {
    user: publicUser(user),
    passwordChanged: Boolean(creds),
    becameDisabled: nextDisabled && !wasDisabled,
  };
}

async function setDisabled(dataDir, userId, disabled) {
  const result = await patchUser(dataDir, userId, { disabled });
  return result.user;
}

async function setRole(dataDir, userId, role) {
  const result = await patchUser(dataDir, userId, { role });
  return result.user;
}

async function resetPassword(dataDir, userId, password) {
  const result = await patchUser(dataDir, userId, { password });
  return result.user;
}

function defaultAppConfig() {
  return {
    signupEnabled: false,
    tipUrl: 'https://agentmediatools.com/tip?from=personal-webui',
    brandTitle: 'Personal WebUI',
  };
}

/** Empty or http(s) only. Strict mode throws 400; otherwise falls back to default tip URL. */
function normalizeTipUrl(raw, { strict = false } = {}) {
  const s = String(raw ?? '').trim().slice(0, 500);
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return String(u.toString()).slice(0, 500);
    }
  } catch {
    /* invalid */
  }
  if (strict) {
    const err = new Error('Tip URL must be http(s) or empty');
    err.status = 400;
    throw err;
  }
  return defaultAppConfig().tipUrl;
}

async function loadAppConfig(dataDir) {
  const saved = (await readJson(appPath(dataDir), null)) || {};
  const next = { ...defaultAppConfig(), ...saved };
  next.signupEnabled = Boolean(next.signupEnabled);
  next.brandTitle = String(next.brandTitle || 'Personal WebUI').slice(0, 80);
  next.tipUrl = normalizeTipUrl(next.tipUrl, { strict: false });
  return next;
}

async function saveAppConfig(dataDir, cfg) {
  const next = { ...defaultAppConfig(), ...(cfg || {}) };
  next.signupEnabled = Boolean(next.signupEnabled);
  next.tipUrl = normalizeTipUrl(next.tipUrl, { strict: true });
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

async function moveLegacyDataIntoUser(dataDir, userId, foldersLib = null) {
  const paths = userDataPaths(dataDir, userId);
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

  let moved = false;
  for (const [src, dest] of moves) {
    if (await moveIfExists(src, dest)) moved = true;
  }
  ensureUserDirs(paths, foldersLib);
  return moved;
}

function legacyDataPresent(dataDir) {
  return [
    'chats',
    'library',
    'workspaces',
    'media',
    'uploads',
    'settings.json',
    'folders.json',
    'gallery.json',
  ].some((name) => fs.existsSync(path.join(dataDir, name)));
}

/**
 * Idempotent migration: if users.json is missing and .env credentials exist,
 * create an admin (persisted first) then move legacy flat data/ into
 * data/users/{adminId}/. If users.json exists but legacy roots remain, resume moves.
 */
async function migrateFromEnvIfNeeded(dataDir, env = process.env, foldersLib = null) {
  const existing = await loadUsers(dataDir);
  if (existing.length > 0) {
    const admin = existing.find((u) => u.role === 'admin') || existing[0];
    if (legacyDataPresent(dataDir)) {
      const moved = await moveLegacyDataIntoUser(dataDir, admin.id, foldersLib);
      if (moved) {
        return { migrated: true, resumed: true, userId: admin.id, username: admin.username };
      }
    }
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

  // Persist admin before moving so a crash cannot orphan data under an unknown id.
  await saveUsers(dataDir, [admin]);
  if (!fs.existsSync(sessionsPath(dataDir))) {
    await writeJsonAtomic(sessionsPath(dataDir), []);
  }
  if (!fs.existsSync(appPath(dataDir))) {
    await saveAppConfig(dataDir, defaultAppConfig());
  }

  await moveLegacyDataIntoUser(dataDir, admin.id, foldersLib);

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
  DUMMY_LOGIN_SALT,
  DUMMY_LOGIN_HASH,
  publicUser,
  loadUsers,
  listUsers,
  findByUsername,
  findById,
  createUser,
  patchUser,
  setDisabled,
  setRole,
  resetPassword,
  defaultAppConfig,
  normalizeTipUrl,
  loadAppConfig,
  saveAppConfig,
  userDataPaths,
  ensureUserDirs,
  moveLegacyDataIntoUser,
  migrateFromEnvIfNeeded,
  hasAnyUsers,
  assertUserId,
  assertUsername,
};
