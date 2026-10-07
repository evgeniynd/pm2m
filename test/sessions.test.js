import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionStore, COOKIE_MAX_AGE } from '../lib/sessions.js';
import { createServer } from '../server.js';

test('cookie survives server restart; logout stays revoked after another restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pm2m-session-test-'));
  let server;
  const stop = async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); server = null; } };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const start = async (password = 'abc') => {
    const sessions = await createSessionStore(directory, password);
    server = createServer({ password, sessions, settings: { list: () => [] } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  let base = await start();
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PM2M-Request': '1' }, body: '{"password":"abc"}' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), new RegExp(`Max-Age=${COOKIE_MAX_AGE}`));
  const file = await readFile(path.join(directory, 'sessions.json'), 'utf8');
  assert.equal(file.includes(cookie.split('=')[1]), false);
  await stop(); base = await start();
  const restored = await fetch(base + '/api/servers', { headers: { Cookie: cookie } });
  assert.equal(restored.status, 200);
  assert.match(restored.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(base + '/api/servers', { headers: { Cookie: 'pm2m_session=' + 'a'.repeat(64) } })).status, 401);
  const logout = await fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-PM2M-Request': '1' }, body: '{}' });
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  await stop(); base = await start();
  assert.equal((await fetch(base + '/api/servers', { headers: { Cookie: cookie } })).status, 401);
});

test('password change revokes persisted sessions and concurrent logins are retained', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pm2m-session-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createSessionStore(directory, 'old');
  const tokens = await Promise.all([store.create(), store.create()]);
  const restored = await createSessionStore(directory, 'old');
  assert.ok(tokens.every(token => restored.has(token)));
  const changed = await createSessionStore(directory, 'new');
  assert.ok(tokens.every(token => !changed.has(token)));
});
