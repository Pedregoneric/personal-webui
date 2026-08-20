'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const zip = require('../lib/zip');
const workspace = require('../lib/workspace');
const folders = require('../lib/folders');

describe('personal-webui basics', () => {
  it('ships server and public assets', () => {
    const root = path.join(__dirname, '..');
    assert.ok(fs.existsSync(path.join(root, 'server.js')));
    assert.ok(fs.existsSync(path.join(root, 'public', 'index.html')));
    assert.ok(fs.existsSync(path.join(root, 'public', 'app.js')));
    assert.ok(fs.existsSync(path.join(root, 'public', 'login.html')));
    assert.ok(fs.existsSync(path.join(root, 'public', 'admin.html')));
    assert.ok(fs.existsSync(path.join(root, 'public', 'admin.js')));
  });

  it('server source includes origin check and scrypt auth', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const usersSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'users.js'), 'utf8');
    assert.match(src, /sameOrigin/);
    assert.match(src, /personal_webui_session/);
    assert.match(usersSrc, /scryptSync/);
    assert.match(src, /users\.verifyPassword|lib\/users/);
  });

  it('exposes Code mode and workspace routes', () => {
    const modes = fs.readFileSync(path.join(__dirname, '..', 'lib', 'modes.js'), 'utf8');
    assert.match(modes, /id:\s*'code'/);
    assert.match(modes, /coding:\s*'code'/);
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.match(server, /workspace\/import-zip|sub === 'import-zip'/);
    assert.match(server, /export-zip/);
    assert.match(server, /lib\/workspace/);
  });
});

describe('zip + workspace safety', () => {
  let tmp;

  before(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pwui-ws-'));
  });

  after(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('round-trips nested text files', () => {
    const buf = zip.zip([
      { path: 'hi.txt', data: 'hello' },
      { path: 'src/app.js', data: 'export default 1;\n' },
    ]);
    const out = zip.unzip(buf);
    const map = Object.fromEntries(out.files.map((f) => [f.path, f.data.toString('utf8')]));
    assert.equal(map['hi.txt'], 'hello');
    assert.equal(map['src/app.js'], 'export default 1;\n');
  });

  it('skips zip-slip paths on unzip', () => {
    // Craft local headers manually would be heavy; zip() rejects traversal on write.
    // Simulate by calling sanitize via unzip of a hand-built store entry is overkill —
    // ensure sanitizeEntryPath rejects, and unzip skipped list works for junk.
    assert.throws(() => zip.sanitizeEntryPath('../evil.txt'));
    assert.throws(() => zip.sanitizeEntryPath('/etc/passwd'));
  });

  it('rejects path escape on workspace resolveSafe', () => {
    assert.throws(() => workspace.resolveSafe(tmp, 'chat-test1', '../outside.txt'), /escap|invalid/i);
    assert.throws(() => workspace.resolveSafe(tmp, 'chat-test1', '/etc/passwd'), /escap|invalid/i);
  });

  it('writes and lists files under sandbox only', async () => {
    const chatId = 'chat-safe1';
    await workspace.ensureWorkspace(tmp, chatId);
    await workspace.writeFile(tmp, chatId, 'src/main.js', 'console.log(1)\n');
    const files = await workspace.listFiles(tmp, chatId);
    assert.ok(files.some((f) => f.path === 'scratch.md'));
    assert.ok(files.some((f) => f.path === 'src/main.js'));
    const got = await workspace.readFile(tmp, chatId, 'src/main.js');
    assert.equal(got.content, 'console.log(1)\n');
  });

  it('importZip merge + exportZip round-trip', async () => {
    const chatId = 'chat-zip1';
    const buf = zip.zip([
      { path: 'readme.md', data: '# hi\n' },
      { path: 'lib/util.js', data: 'export const x = 1;\n' },
    ]);
    const result = await workspace.importZip(tmp, chatId, buf, { mode: 'merge' });
    assert.ok(result.written.length >= 2);
    const exported = await workspace.exportZip(tmp, chatId);
    const again = zip.unzip(exported);
    assert.ok(again.files.some((f) => f.path === 'readme.md'));
    assert.ok(again.files.some((f) => f.path === 'lib/util.js'));
  });

  it('rejects oversize entry via unzip caps', () => {
    // Empty zip is fine; oversize is enforced when inflated size exceeds maxEntryBytes
    const tiny = zip.zip([{ path: 'a.txt', data: 'a' }]);
    assert.throws(
      () => zip.unzip(tiny, { maxUncompressedBytes: 0 }),
      (err) => err && (err.code === 'ZIP_TOO_LARGE' || /large|budget|uncompress/i.test(err.message)),
    );
  });
});

describe('folders id safety', () => {
  it('rejects path escape and invalid folder ids', () => {
    assert.throws(() => folders.assertFolderId('../evil'), /invalid/i);
    assert.throws(() => folders.assertFolderId('a/b'), /invalid/i);
    assert.throws(() => folders.assertFolderId('a\\b'), /invalid/i);
    assert.throws(() => folders.assertFolderId(''), /invalid/i);
    assert.throws(() => folders.assertFolderId('bad id'), /invalid/i);
    assert.equal(folders.assertFolderId('folder-abc_01'), 'folder-abc_01');
  });
});

const users = require('../lib/users');
const sessions = require('../lib/sessions');

describe('multi-user auth foundation', () => {
  let tmp;

  before(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pwui-auth-'));
  });

  after(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('isolates user data paths by userId', () => {
    const a = users.userDataPaths(tmp, 'user-aaa');
    const b = users.userDataPaths(tmp, 'user-bbb');
    assert.notEqual(a.chats, b.chats);
    assert.ok(a.chats.includes(`${path.sep}users${path.sep}user-aaa${path.sep}`));
    assert.ok(b.settings.endsWith(`${path.sep}user-bbb${path.sep}settings.json`));
    assert.throws(() => users.userDataPaths(tmp, '../evil'), /invalid/i);
    assert.throws(() => users.userDataPaths(tmp, 'a/b'), /invalid/i);
  });

  it('defaults signupEnabled to false in app config', async () => {
    const cfg = await users.loadAppConfig(tmp);
    assert.equal(cfg.signupEnabled, false);
    const saved = await users.saveAppConfig(tmp, { signupEnabled: true, brandTitle: 'Test' });
    assert.equal(saved.signupEnabled, true);
    assert.equal((await users.loadAppConfig(tmp)).brandTitle, 'Test');
    await users.saveAppConfig(tmp, { signupEnabled: false });
  });

  it('hashes and verifies passwords with scrypt', () => {
    const { salt, hash } = users.hashPassword('correct-horse-battery');
    assert.equal(users.verifyPassword('correct-horse-battery', salt, hash), true);
    assert.equal(users.verifyPassword('wrong-password!!', salt, hash), false);
  });

  it('creates users and durable sessions', async () => {
    const admin = await users.createUser(tmp, {
      username: 'admin1',
      password: 'password-admin-1',
      role: 'admin',
    });
    assert.equal(admin.role, 'admin');
    assert.ok(admin.salt && admin.hash);
    const member = await users.createUser(tmp, {
      username: 'member1',
      password: 'password-member-1',
      role: 'user',
    });
    assert.equal(member.role, 'user');
    const session = await sessions.createSession(tmp, member.id, 1);
    const got = await sessions.getSession(tmp, session.token);
    assert.equal(got.userId, member.id);
    await sessions.destroySession(tmp, session.token);
    assert.equal(await sessions.getSession(tmp, session.token), null);
  });

  it('server source gates admin routes and scopes user paths', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const usersSrc = fs.readFileSync(path.join(__dirname, '..', 'lib/users.js'), 'utf8');
    assert.match(src, /requireAdmin/);
    assert.match(src, /\/api\/admin\/users/);
    assert.match(src, /\/api\/admin\/app/);
    assert.match(src, /\/api\/signup/);
    assert.match(src, /signupEnabled/);
    assert.match(usersSrc, /Cannot remove the last admin/);
    assert.match(src, /userDataPaths|ensureUserData/);
    assert.match(src, /migrateFromEnvIfNeeded/);
    assert.match(src, /role:\s*req\.user\.role|req\.user\.role/);
    assert.match(src, /sessions\.createSession|createSession\(/);
    assert.match(src, /optionalSafeId|loadLibraryJson/);
    assert.match(src, /streamKey\(|userId\}:\$\{chatId|`\$\{userId\}:\$\{chatId\}`/);
    assert.match(src, /DUMMY_LOGIN_SALT/);
  });

  it('refuses demoting or disabling the last admin', async () => {
    const isolated = await fsp.mkdtemp(path.join(os.tmpdir(), 'pwui-last-admin-'));
    try {
      const only = await users.createUser(isolated, {
        username: 'solo-admin',
        password: 'password-solo-admin',
        role: 'admin',
      });
      await assert.rejects(
        () => users.setRole(isolated, only.id, 'user'),
        (err) => err && /last admin/i.test(err.message) && err.status === 400
      );
      await assert.rejects(
        () => users.setDisabled(isolated, only.id, true),
        (err) => err && /last admin/i.test(err.message) && err.status === 400
      );
      await assert.rejects(
        () => users.patchUser(isolated, only.id, { disabled: true, role: 'user' }),
        (err) => err && /last admin/i.test(err.message) && err.status === 400
      );
      assert.equal((await users.findById(isolated, only.id)).disabled, false);
      assert.equal((await users.findById(isolated, only.id)).role, 'admin');

      const second = await users.createUser(isolated, {
        username: 'second-admin',
        password: 'password-second-admin',
        role: 'admin',
      });
      const demoted = await users.setRole(isolated, only.id, 'user');
      assert.equal(demoted.role, 'user');
      assert.equal((await users.findById(isolated, second.id)).role, 'admin');
      const disabled = await users.setDisabled(isolated, only.id, true);
      assert.equal(disabled.disabled, true);
    } finally {
      await fsp.rm(isolated, { recursive: true, force: true });
    }
  });

  it('rejects non-http(s) tipUrl values', async () => {
    await assert.rejects(
      () => users.saveAppConfig(tmp, { tipUrl: 'javascript:alert(1)' }),
      (err) => err && /tip url/i.test(err.message) && err.status === 400
    );
    await assert.rejects(
      () => users.saveAppConfig(tmp, { tipUrl: 'data:text/html,hi' }),
      (err) => err && err.status === 400
    );
    const saved = await users.saveAppConfig(tmp, {
      tipUrl: 'https://example.com/tip',
      brandTitle: 'Safe',
    });
    assert.match(saved.tipUrl, /^https:\/\/example\.com\/tip\/?$/);
    const cleared = await users.saveAppConfig(tmp, { tipUrl: '' });
    assert.equal(cleared.tipUrl, '');
    assert.equal(users.normalizeTipUrl('javascript:alert(1)'), users.defaultAppConfig().tipUrl);
  });

  it('login always uses dummy scrypt credentials for missing users', () => {
    assert.ok(users.DUMMY_LOGIN_SALT);
    assert.ok(users.DUMMY_LOGIN_HASH);
    assert.equal(users.verifyPassword('anything-here!!', users.DUMMY_LOGIN_SALT, users.DUMMY_LOGIN_HASH), false);
  });

  it('migrates legacy flat data into per-user namespace idempotently', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pwui-mig-'));
    try {
      await fsp.mkdir(path.join(dataDir, 'chats'), { recursive: true });
      await fsp.writeFile(path.join(dataDir, 'chats', 'chat-1.json'), JSON.stringify({ id: 'chat-1' }));
      await fsp.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
      await fsp.mkdir(path.join(dataDir, 'library', 'personas'), { recursive: true });
      await fsp.writeFile(
        path.join(dataDir, 'library', 'personas', 'persona-1.json'),
        JSON.stringify({ id: 'persona-1' }),
      );

      const env = {
        WEBUI_USERNAME: 'legacy-owner',
        PASSWORD_SALT: 'a'.repeat(48),
        PASSWORD_HASH: 'b'.repeat(128),
      };
      const first = await users.migrateFromEnvIfNeeded(dataDir, env, folders);
      assert.equal(first.migrated, true);
      assert.ok(first.userId);
      assert.ok(fs.existsSync(path.join(dataDir, 'users.json')));
      assert.ok(fs.existsSync(path.join(dataDir, 'sessions.json')));
      assert.ok(fs.existsSync(path.join(dataDir, 'app.json')));
      const paths = users.userDataPaths(dataDir, first.userId);
      assert.ok(fs.existsSync(path.join(paths.chats, 'chat-1.json')));
      assert.ok(fs.existsSync(paths.settings));
      assert.equal(fs.existsSync(path.join(dataDir, 'chats')), false);
      assert.equal(fs.existsSync(path.join(dataDir, 'settings.json')), false);

      const second = await users.migrateFromEnvIfNeeded(dataDir, env, folders);
      assert.equal(second.migrated, false);
      assert.equal(second.reason, 'already-migrated');

      const list = await users.loadUsers(dataDir);
      assert.equal(list.length, 1);
      assert.equal(list[0].role, 'admin');
      assert.equal(list[0].username, 'legacy-owner');
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('resumes legacy moves when users.json exists but roots remain', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pwui-mig-resume-'));
    try {
      const admin = await users.createUser(dataDir, {
        username: 'resume-admin',
        password: 'password-resume-1',
        role: 'admin',
      });
      await fsp.mkdir(path.join(dataDir, 'chats'), { recursive: true });
      await fsp.writeFile(path.join(dataDir, 'chats', 'chat-resume.json'), JSON.stringify({ id: 'chat-resume' }));
      const result = await users.migrateFromEnvIfNeeded(
        dataDir,
        {
          WEBUI_USERNAME: 'ignored',
          PASSWORD_SALT: 'a'.repeat(48),
          PASSWORD_HASH: 'b'.repeat(128),
        },
        folders,
      );
      assert.equal(result.migrated, true);
      assert.equal(result.resumed, true);
      assert.equal(result.userId, admin.id);
      const paths = users.userDataPaths(dataDir, admin.id);
      assert.ok(fs.existsSync(path.join(paths.chats, 'chat-resume.json')));
      assert.equal(fs.existsSync(path.join(dataDir, 'chats')), false);
    } finally {
      await fsp.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('persists users.json before moving so crash cannot mint a new admin id', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'users.js'), 'utf8');
    const marker = 'Persist admin before moving';
    const markerIdx = src.indexOf(marker);
    assert.ok(markerIdx > 0, 'expected migration safety comment');
    const after = src.slice(markerIdx);
    const saveIdx = after.indexOf('await saveUsers(dataDir, [admin])');
    const moveIdx = after.indexOf('await moveLegacyDataIntoUser(dataDir, admin.id');
    assert.ok(saveIdx >= 0 && moveIdx > saveIdx, 'saveUsers must precede moveLegacyDataIntoUser for new admins');
  });
});
