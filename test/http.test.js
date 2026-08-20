'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

async function startServer() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'personal-webui-http-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PERSONAL_WEBUI_ENV_FILE: path.join(dataDir, 'missing.env'),
      DATA_DIR: dataDir,
      HOST: '127.0.0.1',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${stderr}`)), 5000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Server exited during startup (${code}): ${stderr}`));
    });
    child.stdout.on('data', (chunk) => {
      const match = chunk.toString('utf8').match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(match[1]);
    });
  });

  return {
    baseUrl,
    dataDir,
    async stop() {
      if (child.exitCode === null) child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('HTTP auth and browser security smoke test', async (t) => {
  const app = await startServer();
  t.after(() => app.stop());

  const health = await fetch(`${app.baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(health.headers.get('x-frame-options'), 'DENY');
  assert.equal(health.headers.get('referrer-policy'), 'no-referrer');

  const anonymous = await fetch(`${app.baseUrl}/api/me`);
  assert.equal(anonymous.status, 401);

  const setup = await fetch(`${app.baseUrl}/api/setup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-proto': 'https',
    },
    body: JSON.stringify({ username: 'reviewer', password: 'correct horse battery staple' }),
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);

  const me = await fetch(`${app.baseUrl}/api/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).username, 'reviewer');

  const crossOrigin = await fetch(`${app.baseUrl}/api/settings`, {
    method: 'PUT',
    headers: {
      cookie,
      'content-type': 'application/json',
      origin: 'https://attacker.example',
    },
    body: JSON.stringify({ theme: 'light' }),
  });
  assert.equal(crossOrigin.status, 403);
});
