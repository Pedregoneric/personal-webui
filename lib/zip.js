'use strict';

/**
 * Minimal ZIP reader/writer using only node:zlib (deflateRaw / inflateRaw).
 * Supports compression methods 0 (store) and 8 (deflate).
 */

const zlib = require('node:zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_UNCOMPRESSED = 100 * 1024 * 1024;
const DEFAULT_MAX_ENTRY = 25 * 1024 * 1024;
const MAX_PATH_LEN = 240;

const JUNK_SEGMENTS = new Set(['node_modules', '.git', '__pycache__', '.DS_Store']);
const JUNK_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.mp4', '.webm', '.mp3', '.wav',
  '.woff', '.woff2', '.ttf', '.otf',
  '.exe', '.dll', '.so', '.dylib', '.bin',
  '.pdf', '.zip', '.7z', '.rar', '.gz', '.bz2', '.xz',
  '.wasm', '.sqlite', '.db',
]);

// CRC-32 (ISO 3309 / ZIP) — table generated once
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function zipError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Normalize and validate a ZIP entry path. Rejects zip-slip and absolute paths.
 * Returns sanitized posix-relative path, or throws ZIP_INVALID.
 */
function sanitizeEntryPath(name) {
  if (name == null) throw zipError('empty path', 'ZIP_INVALID');
  let s = String(name).replace(/\\/g, '/');
  if (!s || s.includes('\0')) throw zipError('empty or null-byte path', 'ZIP_INVALID');

  // Strip drive letters (C:/… or C:…)
  if (/^[a-zA-Z]:/.test(s)) s = s.slice(2);
  // Strip leading ./ segments and absolute roots
  while (s.startsWith('./')) s = s.slice(2);
  if (s.startsWith('/')) throw zipError('absolute path rejected', 'ZIP_INVALID');

  const parts = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') throw zipError('path traversal rejected', 'ZIP_INVALID');
    parts.push(seg);
  }
  if (parts.length === 0) throw zipError('empty path', 'ZIP_INVALID');

  const out = parts.join('/');
  if (out.length > MAX_PATH_LEN) throw zipError('path too long', 'ZIP_INVALID');
  return out;
}

function isJunkPath(relPath) {
  const parts = relPath.split('/');
  for (const seg of parts) {
    if (JUNK_SEGMENTS.has(seg)) return true;
  }
  const base = parts[parts.length - 1] || '';
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const ext = base.slice(dot).toLowerCase();
    if (JUNK_EXTS.has(ext)) return true;
  }
  return false;
}

function isDirectoryEntry(name) {
  return typeof name === 'string' && name.endsWith('/');
}

function findEocd(buffer) {
  // EOCD is at least 22 bytes; comment can be up to 65535
  const min = 22;
  if (buffer.length < min) throw zipError('zip too short', 'ZIP_INVALID');
  const start = Math.max(0, buffer.length - (min + 65535));
  for (let i = buffer.length - min; i >= start; i--) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw zipError('EOCD not found', 'ZIP_INVALID');
}

function inflateRawSync(data, maxOut) {
  try {
    return zlib.inflateRawSync(data, { maxOutputLength: maxOut });
  } catch (e) {
    throw zipError(`deflate inflate failed: ${e.message}`, 'ZIP_INVALID');
  }
}

function deflateRawSync(data) {
  return zlib.deflateRawSync(data, { level: 9 });
}

/**
 * @param {Buffer} buffer
 * @param {object} [options]
 * @returns {{ files: Array<{path:string,data:Buffer}>, skipped: Array<{path:string,reason:string}> }}
 */
function unzip(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer)) {
    throw zipError('expected Buffer', 'ZIP_INVALID');
  }

  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxUncompressedBytes = options.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY;
  const skipJunk = options.skipJunk !== false;

  const eocdOff = findEocd(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOff + 10);
  const cdSize = buffer.readUInt32LE(eocdOff + 12);
  const cdOffset = buffer.readUInt32LE(eocdOff + 16);

  if (totalEntries > maxEntries) {
    throw zipError(`too many entries (${totalEntries})`, 'ZIP_TOO_MANY');
  }
  if (cdOffset + cdSize > buffer.length) {
    throw zipError('central directory out of bounds', 'ZIP_INVALID');
  }

  const files = [];
  const skipped = [];
  let totalUncompressed = 0;
  let offset = cdOffset;
  const cdEnd = cdOffset + cdSize;

  for (let n = 0; n < totalEntries; n++) {
    if (offset + 46 > buffer.length || offset + 46 > cdEnd) {
      throw zipError('truncated central directory', 'ZIP_INVALID');
    }
    if (buffer.readUInt32LE(offset) !== SIG_CENTRAL) {
      throw zipError('bad central directory signature', 'ZIP_INVALID');
    }

    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compSize = buffer.readUInt32LE(offset + 20);
    const uncompSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOff = buffer.readUInt32LE(offset + 42);

    if (offset + 46 + nameLen + extraLen + commentLen > buffer.length) {
      throw zipError('central directory entry overflows', 'ZIP_INVALID');
    }

    const rawName = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    offset += 46 + nameLen + extraLen + commentLen;

    if (isDirectoryEntry(rawName)) {
      skipped.push({ path: rawName, reason: 'directory' });
      continue;
    }

    let safePath;
    try {
      safePath = sanitizeEntryPath(rawName);
    } catch (e) {
      skipped.push({ path: rawName, reason: e.message || 'invalid path' });
      continue;
    }

    if (skipJunk && isJunkPath(safePath)) {
      skipped.push({ path: safePath, reason: 'junk' });
      continue;
    }

    if (uncompSize > maxEntryBytes) {
      skipped.push({ path: safePath, reason: 'entry too large' });
      continue;
    }
    if (totalUncompressed + uncompSize > maxUncompressedBytes) {
      throw zipError('uncompressed size exceeds limit', 'ZIP_TOO_LARGE');
    }

    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
      skipped.push({ path: safePath, reason: `unsupported method ${method}` });
      continue;
    }

    // Local file header
    if (localOff + 30 > buffer.length || buffer.readUInt32LE(localOff) !== SIG_LOCAL) {
      skipped.push({ path: safePath, reason: 'bad local header' });
      continue;
    }
    const localNameLen = buffer.readUInt16LE(localOff + 26);
    const localExtraLen = buffer.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buffer.length) {
      skipped.push({ path: safePath, reason: 'data out of bounds' });
      continue;
    }

    const compressed = buffer.subarray(dataStart, dataEnd);
    let data;
    try {
      if (method === METHOD_STORE) {
        data = Buffer.from(compressed);
      } else {
        data = inflateRawSync(compressed, Math.min(maxEntryBytes, uncompSize || maxEntryBytes));
      }
    } catch (e) {
      skipped.push({ path: safePath, reason: e.message || 'decompress failed' });
      continue;
    }

    if (data.length > maxEntryBytes) {
      skipped.push({ path: safePath, reason: 'entry too large' });
      continue;
    }
    // Prefer declared size when present; allow mismatch after inflate only if within caps
    if (uncompSize > 0 && data.length !== uncompSize) {
      // Some zips lie; still accept if under caps, but verify CRC when non-zero
    }
    if (crc !== 0 && crc32(data) !== crc) {
      skipped.push({ path: safePath, reason: 'crc mismatch' });
      continue;
    }

    totalUncompressed += data.length;
    if (totalUncompressed > maxUncompressedBytes) {
      throw zipError('uncompressed size exceeds limit', 'ZIP_TOO_LARGE');
    }

    files.push({ path: safePath, data });
  }

  return { files, skipped };
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0xf) << 5) |
    (date.getDate() & 0x1f);
  return { dosTime, dosDate };
}

/**
 * @param {Array<{path:string,data:Buffer|string}>} files
 * @returns {Buffer}
 */
function zip(files) {
  if (!Array.isArray(files)) throw zipError('files must be an array', 'ZIP_INVALID');
  if (files.length > DEFAULT_MAX_ENTRIES) {
    throw zipError('too many entries', 'ZIP_TOO_MANY');
  }

  const { dosTime, dosDate } = dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  let totalUncompressed = 0;

  for (const entry of files) {
    if (!entry || entry.path == null) throw zipError('entry missing path', 'ZIP_INVALID');
    const name = sanitizeEntryPath(entry.path);
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data == null ? '' : String(entry.data), 'utf8');

    if (data.length > DEFAULT_MAX_ENTRY) {
      throw zipError(`entry too large: ${name}`, 'ZIP_TOO_LARGE');
    }
    totalUncompressed += data.length;
    if (totalUncompressed > DEFAULT_MAX_UNCOMPRESSED) {
      throw zipError('archive uncompressed size exceeds limit', 'ZIP_TOO_LARGE');
    }

    const nameBuf = Buffer.from(name, 'utf8');
    const checksum = crc32(data);
    let method = METHOD_STORE;
    let compressed = data;

    if (data.length > 0) {
      try {
        const deflated = deflateRawSync(data);
        if (deflated.length < data.length) {
          compressed = deflated;
          method = METHOD_DEFLATE;
        }
      } catch {
        // fall back to store
      }
    }

    // Local file header (30) + name + data
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    const localOff = offset;
    localParts.push(local, nameBuf, compressed);
    offset += local.length + nameBuf.length + compressed.length;

    // Central directory header (46) + name
    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(localOff, 42);
    centralParts.push(central, nameBuf);
  }

  const cdOffset = offset;
  const cdBuf = Buffer.concat(centralParts);
  const cdSize = cdBuf.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

module.exports = {
  unzip,
  zip,
  sanitizeEntryPath,
  crc32,
};
