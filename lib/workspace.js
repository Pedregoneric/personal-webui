'use strict';

/**
 * Per-chat sandboxed file workspace under {base}/{chatId}/.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { zip, unzip, sanitizeEntryPath } = require('./zip');

const CHAT_ID_RE = /^[a-zA-Z0-9._-]{1,80}$/;
const MAX_REL_PATH = 240;
const MAX_TEXT_CHARS = 2_000_000;
const SCRATCH_NAME = 'scratch.md';
const SCRATCH_TEMPLATE = `# Scratch

Notes and scratch code for this chat.

- Import a zip or create files here
- Open a file to include it in the model context
- Ask the assistant to write path-tagged fences, then Apply them
`;

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertChatId(chatId) {
  if (typeof chatId !== 'string' || !CHAT_ID_RE.test(chatId)) {
    throw httpError('invalid chatId', 400);
  }
}

/** Absolute workspace root for a chat. */
function workspaceRoot(base, chatId) {
  assertChatId(chatId);
  if (!base || typeof base !== 'string') throw httpError('invalid workspace base', 400);
  return path.resolve(base, chatId);
}

/**
 * Sanitize a relative path and return an absolute path under the chat workspace.
 * Throws status:400 on escape / invalid paths.
 */
function resolveSafe(base, chatId, relPath) {
  const root = workspaceRoot(base, chatId);
  if (relPath == null || typeof relPath !== 'string') {
    throw httpError('invalid path', 400);
  }
  if (relPath.includes('\0')) throw httpError('invalid path', 400);

  let normalized;
  try {
    normalized = sanitizeEntryPath(relPath);
  } catch {
    throw httpError('invalid path', 400);
  }
  if (normalized.length > MAX_REL_PATH) throw httpError('path too long', 400);

  const abs = path.resolve(root, ...normalized.split('/'));
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw httpError('path escapes workspace', 400);
  }
  return abs;
}

async function ensureWorkspace(base, chatId) {
  const root = workspaceRoot(base, chatId);
  await fs.mkdir(root, { recursive: true });
  const scratch = path.join(root, SCRATCH_NAME);
  try {
    await fs.access(scratch);
  } catch {
    await fs.writeFile(scratch, SCRATCH_TEMPLATE, 'utf8');
  }
  return root;
}

async function walkFiles(dir, root, out) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      await walkFiles(abs, root, out);
    } else if (ent.isFile()) {
      const st = await fs.stat(abs);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      out.push({ path: rel, size: st.size, updatedAt: st.mtime.toISOString() });
    }
  }
}

async function listFiles(base, chatId) {
  const root = await ensureWorkspace(base, chatId);
  const out = [];
  await walkFiles(root, root, out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

async function readFile(base, chatId, relPath) {
  const abs = resolveSafe(base, chatId, relPath);
  let st;
  try {
    st = await fs.stat(abs);
  } catch (e) {
    if (e.code === 'ENOENT') throw httpError('file not found', 404);
    throw e;
  }
  if (!st.isFile()) throw httpError('not a file', 400);
  if (st.size > MAX_TEXT_CHARS) throw httpError('file too large', 400);

  const buf = await fs.readFile(abs);
  if (looksBinary(buf)) throw httpError('binary files are not readable as text', 400);

  const content = buf.toString('utf8');
  if (content.length > MAX_TEXT_CHARS) throw httpError('file too large', 400);

  const root = workspaceRoot(base, chatId);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  return {
    path: rel,
    content,
    size: st.size,
    updatedAt: st.mtime.toISOString(),
  };
}

async function writeFile(base, chatId, relPath, content) {
  await ensureWorkspace(base, chatId);
  const abs = resolveSafe(base, chatId, relPath);
  const text = content == null ? '' : String(content);
  if (text.length > MAX_TEXT_CHARS) throw httpError('content too large', 400);

  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, text, 'utf8');
  const st = await fs.stat(abs);
  const root = workspaceRoot(base, chatId);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  return { path: rel, size: st.size, updatedAt: st.mtime.toISOString() };
}

async function deleteFile(base, chatId, relPath) {
  const abs = resolveSafe(base, chatId, relPath);
  try {
    await fs.unlink(abs);
  } catch (e) {
    if (e.code === 'ENOENT') throw httpError('file not found', 404);
    throw e;
  }
  // Best-effort: remove empty parent dirs up to workspace root (not the root itself)
  const root = workspaceRoot(base, chatId);
  let dir = path.dirname(abs);
  while (dir.startsWith(root) && dir !== root) {
    try {
      await fs.rmdir(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

async function clearWorkspace(base, chatId) {
  const root = workspaceRoot(base, chatId);
  await fs.mkdir(root, { recursive: true });
  const entries = await fs.readdir(root);
  await Promise.all(
    entries.map((name) => fs.rm(path.join(root, name), { recursive: true, force: true })),
  );
  await ensureWorkspace(base, chatId);
}

async function removeWorkspace(base, chatId) {
  const root = workspaceRoot(base, chatId);
  await fs.rm(root, { recursive: true, force: true });
}

async function importZip(base, chatId, zipBuffer, { mode = 'merge' } = {}) {
  await ensureWorkspace(base, chatId);
  if (mode === 'replace') {
    await clearWorkspace(base, chatId);
  } else if (mode !== 'merge') {
    throw httpError('mode must be merge or replace', 400);
  }

  const { files, skipped } = unzip(zipBuffer);
  const written = [];
  for (const f of files) {
    // Text-oriented workspace: decode as utf8 (binary already filtered by zip junk rules mostly)
    const content = f.data.toString('utf8');
    if (content.length > MAX_TEXT_CHARS) {
      skipped.push({ path: f.path, reason: 'content too large' });
      continue;
    }
    if (looksBinary(f.data)) {
      skipped.push({ path: f.path, reason: 'binary' });
      continue;
    }
    const meta = await writeFile(base, chatId, f.path, content);
    written.push(meta);
  }
  return { written, skipped };
}

async function exportZip(base, chatId) {
  const listed = await listFiles(base, chatId);
  const files = [];
  for (const item of listed) {
    const abs = resolveSafe(base, chatId, item.path);
    const data = await fs.readFile(abs);
    files.push({ path: item.path, data });
  }
  return zip(files);
}

function fenceLang(filePath) {
  const ext = path.posix.extname(filePath).toLowerCase();
  const map = {
    '.js': 'js',
    '.mjs': 'js',
    '.cjs': 'js',
    '.ts': 'ts',
    '.tsx': 'tsx',
    '.jsx': 'jsx',
    '.json': 'json',
    '.md': 'md',
    '.py': 'py',
    '.html': 'html',
    '.css': 'css',
    '.sh': 'bash',
    '.yml': 'yaml',
    '.yaml': 'yaml',
    '.toml': 'toml',
    '.rs': 'rust',
    '.go': 'go',
  };
  return map[ext] || '';
}

/**
 * Build a markdown context blob: file tree + open file + other small text files until budget.
 */
async function buildContext(base, chatId, { openPath, budgetChars = 50000 } = {}) {
  const listed = await listFiles(base, chatId);
  const lines = ['# Workspace files'];
  for (const f of listed) {
    lines.push(`- ${f.path} (${f.size} B)`);
  }
  lines.push('');

  let used = lines.join('\n').length;
  const parts = [lines.join('\n')];

  async function tryAppend(title, filePath) {
    let file;
    try {
      file = await readFile(base, chatId, filePath);
    } catch {
      return false;
    }
    const lang = fenceLang(file.path);
    const block = `# ${title}: ${file.path}\n\`\`\`${lang}\n${file.content}\n\`\`\`\n`;
    if (used + block.length > budgetChars) return false;
    parts.push(block);
    used += block.length;
    return true;
  }

  const openNorm = openPath
    ? (() => {
        try {
          return sanitizeEntryPath(openPath);
        } catch {
          return null;
        }
      })()
    : null;

  if (openNorm) {
    await tryAppend('Open file', openNorm);
  }

  // Other files: small text first, skip the already-open path
  const others = listed
    .filter((f) => f.path !== openNorm)
    .slice()
    .sort((a, b) => a.size - b.size || a.path.localeCompare(b.path));

  let otherHeader = false;
  for (const f of others) {
    if (f.size > 200_000) continue; // skip large candidates early
    let file;
    try {
      file = await readFile(base, chatId, f.path);
    } catch {
      continue;
    }
    const lang = fenceLang(file.path);
    const body = `## ${file.path}\n\`\`\`${lang}\n${file.content}\n\`\`\`\n`;
    const header = otherHeader ? '' : '# Other files (budget permitting)\n';
    const block = header + body;
    if (used + block.length > budgetChars) continue;
    parts.push(block);
    used += block.length;
    otherHeader = true;
  }

  return parts.join('\n').trimEnd() + '\n';
}

function createWorkspaceApi(workspacesRoot) {
  return {
    workspaceRoot: (chatId) => workspaceRoot(workspacesRoot, chatId),
    ensureWorkspace: (chatId) => ensureWorkspace(workspacesRoot, chatId),
    listFiles: (chatId) => listFiles(workspacesRoot, chatId),
    readFile: (chatId, relPath) => readFile(workspacesRoot, chatId, relPath),
    writeFile: (chatId, relPath, content) => writeFile(workspacesRoot, chatId, relPath, content),
    deleteFile: (chatId, relPath) => deleteFile(workspacesRoot, chatId, relPath),
    resolveSafe: (chatId, relPath) => resolveSafe(workspacesRoot, chatId, relPath),
    clearWorkspace: (chatId) => clearWorkspace(workspacesRoot, chatId),
    importZip: (chatId, zipBuffer, opts) => importZip(workspacesRoot, chatId, zipBuffer, opts),
    exportZip: (chatId) => exportZip(workspacesRoot, chatId),
    buildContext: (chatId, opts) => buildContext(workspacesRoot, chatId, opts),
    removeWorkspace: (chatId) => removeWorkspace(workspacesRoot, chatId),
  };
}

module.exports = {
  workspaceRoot,
  ensureWorkspace,
  listFiles,
  readFile,
  writeFile,
  deleteFile,
  resolveSafe,
  clearWorkspace,
  importZip,
  exportZip,
  buildContext,
  removeWorkspace,
  createWorkspaceApi,
};
