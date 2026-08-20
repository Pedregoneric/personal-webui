'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function sessionsFile(dataDir) {
  return path.join(dataDir, 'sessions.json');
}

async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

async function readSessions(dataDir) {
  try {
    const raw = JSON.parse(await fsp.readFile(sessionsFile(dataDir), 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    return [];
  }
}

async function writeSessions(dataDir, list) {
  await writeJsonAtomic(sessionsFile(dataDir), list);
}

async function createSession(dataDir, userId, ttlHours) {
  const hours = Math.min(168, Math.max(1, Number(ttlHours) || 24));
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + hours * 3600000;
  const list = await readSessions(dataDir);
  list.push({ token, userId, expiresAt });
  await writeSessions(dataDir, list);
  return { token, userId, expiresAt, maxAgeSec: hours * 3600 };
}

async function getSession(dataDir, token) {
  if (!token) return null;
  const list = await readSessions(dataDir);
  const now = Date.now();
  const session = list.find((s) => s.token === token);
  if (!session) return null;
  if (now > Number(session.expiresAt)) {
    await destroySession(dataDir, token);
    return null;
  }
  return session;
}

async function destroySession(dataDir, token) {
  if (!token) return;
  const list = await readSessions(dataDir);
  const next = list.filter((s) => s.token !== token);
  if (next.length !== list.length) await writeSessions(dataDir, next);
}

async function purgeExpired(dataDir) {
  const list = await readSessions(dataDir);
  const now = Date.now();
  const next = list.filter((s) => Number(s.expiresAt) > now);
  if (next.length !== list.length) await writeSessions(dataDir, next);
  return list.length - next.length;
}

async function destroySessionsForUser(dataDir, userId) {
  const list = await readSessions(dataDir);
  const next = list.filter((s) => s.userId !== userId);
  if (next.length !== list.length) await writeSessions(dataDir, next);
}

function ensureStore(dataDir) {
  const file = sessionsFile(dataDir);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[]\n', 'utf8');
  }
}

module.exports = {
  sessionsFile,
  createSession,
  getSession,
  destroySession,
  purgeExpired,
  destroySessionsForUser,
  ensureStore,
};
