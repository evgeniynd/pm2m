import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { createSettings } from '../lib/settings.js';
import { createDemoManager, tail, validateStart } from '../lib/manager.js';
import { createSshManager, parseList, quote } from '../lib/ssh.js';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pm2m-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = await createSettings(directory);
  return { directory, settings };
}
const sshConfig = { name: 'Test SSH', type: 'ssh', host: '127.0.0.1', port: 22, username: 'deploy', auth: 'password', password: 'secret-ssh-password', fingerprint: 'SHA256:' + 'a'.repeat(43) };

test('settings persist, encrypt credentials and never return secrets to the UI', async t => {
  const { directory, settings } = await fixture(t);
  const saved = await settings.save(sshConfig);
  assert.equal(saved.hasSecret, true); assert.equal(saved.password, undefined); assert.equal(saved.secret, undefined);
  const file = await readFile(path.join(directory, 'settings.json'), 'utf8');
  assert.equal(file.includes(sshConfig.password), false);
  const restored = await createSettings(directory);
  assert.equal(restored.get(saved.id).password, sshConfig.password);
  await restored.save({ ...saved, name: 'Updated', password: '' });
  assert.equal(restored.get(saved.id).password, sshConfig.password);
  await restored.remove(saved.id);
  assert.throws(() => restored.get(saved.id), /не найден/);
});

test('settings serialize concurrent writes and validate SSH inputs', async t => {
  const { settings, directory } = await fixture(t);
  await Promise.all([settings.save({ name: 'A', type: 'local' }), settings.save({ name: 'B', type: 'local' })]);
  assert.equal((await createSettings(directory)).list().length, 3);
  await assert.rejects(settings.save({ ...sshConfig, port: 70000 }), /Порт/);
  await assert.rejects(settings.save({ ...sshConfig, fingerprint: '' }), /отпечаток/);
  await assert.rejects(settings.save({ ...sshConfig, pm2Path: 'pm2; touch /tmp/oops' }), /PM2:/);
});

test('HTTP auth, CSRF protection, server routing, lifecycle, logs and persistence', async t => {
  const { settings } = await fixture(t);
  const remote = await settings.save(sshConfig);
  const localManager = createDemoManager(), remoteManager = createDemoManager();
  const server = createServer({ password: 'test-admin-password', settings, resolveManager: async target => target.id === remote.id ? remoteManager : localManager });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const get = url => fetch(base + url, { headers: { Cookie: cookie } });
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-PM2M-Request': '1' }, body: JSON.stringify(body) });
  assert.equal((await get('/api/processes')).status, 401);
  assert.equal((await post('/api/login', { password: 'wrong' })).status, 401);
  const login = await post('/api/login', { password: 'test-admin-password' }); assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0]; assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await fetch(base + '/api/save', { method: 'POST', headers: { Cookie: cookie } })).status, 403);
  const secretList = await (await get('/api/servers')).text(); assert.equal(secretList.includes(sshConfig.password), false);
  assert.equal((await post(`/api/processes/0/stop?server=${remote.id}`, {})).status, 200);
  assert.equal((await remoteManager.list())[0].status, 'stopped'); assert.equal((await localManager.list())[0].status, 'online');
  const remoteResponse = await (await get(`/api/processes?server=${remote.id}`)).json();
  assert.equal(remoteResponse.system, null); assert.equal(remoteResponse.host, sshConfig.host);
  const { versions } = await (await get(`/api/node-versions?server=${remote.id}`)).json();
  assert.equal(versions.length, 2);
  const interpreter = versions[1].path;
  assert.equal((await post(`/api/processes?server=${remote.id}`, { name: 'chosen-node', script: '/srv/app.js', interpreter })).status, 201);
  assert.equal((await remoteManager.list()).find(p => p.name === 'chosen-node').interpreter, interpreter);
  assert.equal((await localManager.list()).some(p => p.name === 'chosen-node'), false);
  assert.equal((await post(`/api/processes?server=${remote.id}`, { name: 'bad-node', script: '/srv/app.js', interpreter: '/not-installed/node' })).status, 400);
  assert.equal((await post('/api/processes/0/restart', {})).status, 200);
  const logs = await (await get('/api/processes/0/logs')).json(); assert.match(logs.stdout, /Application started/);
  assert.equal((await post('/api/processes', { name: 'x', script: 'relative.js' })).status, 400);
  assert.equal((await post('/api/processes', { name: 'new-app', script: '/srv/app/index.js' })).status, 201);
  assert.equal((await post('/api/processes/4/delete', {})).status, 200);
  assert.equal((await post('/api/save', {})).status, 200);
  assert.equal((await get('/api/processes?server=unknown')).status, 400);
  await post('/api/logout', {}); assert.equal((await get('/api/servers')).status, 401);
});

test('login throttles repeated failures', async t => {
  const { settings } = await fixture(t);
  const server = createServer({ password: 'test', settings, resolveManager: async () => createDemoManager() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  for (let i = 0; i < 11; i++) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PM2M-Request': '1' }, body: '{"password":"wrong"}' });
    assert.equal(response.status, i === 10 ? 429 : 401);
  }
});

test('SSH manager scopes actions to a numeric ID and quotes shell arguments', async () => {
  const calls = [];
  const manager = createSshManager({ pm2Path: '/opt/node/bin/pm2', pm2Home: '/home/deploy/.pm2' }, async (config, command) => {
    calls.push(command);
    return 'banner\n' + JSON.stringify([{ pm_id: 7, name: 'api', pm2_env: { status: 'online' } }]);
  });
  assert.equal((await manager.list())[0].id, 7);
  assert.match(calls[0], /export PATH=/);
  assert.match(calls[0], /\/opt\/node\/bin/);
  await manager.action(7, 'stop'); assert.match(calls.at(-1), /stop/);
  await manager.start({ name: 'selected-node', script: '/srv/app.js', cwd: '/srv', interpreter: '/opt/node 20/bin/node' });
  assert.match(calls.at(-1), /--interpreter/);
  assert.ok(calls.at(-1).includes(quote(quote('/opt/node 20/bin/node')).slice(1, -1)));
  await assert.rejects(manager.action(8, 'stop'), /не найден/);
  await assert.rejects(manager.action('all', 'stop'), /Недопустимое/);
  await assert.rejects(manager.action(7, 'kill'), /Недопустимое/);
  assert.equal(quote("a'b;$(whoami)"), "'a'\\''b;$(whoami)'");
  assert.deepEqual(parseList('[PM2] banner\n[]\n'), []);
  assert.throws(() => parseList('not json'), /некорректный/);
});

test('SSH loads nvm when PM2 is not in the login shell PATH', async () => {
  let command;
  const manager = createSshManager({ pm2Path: 'pm2' }, async (_config, value) => { command = value; return '[]'; });
  await manager.list();
  assert.match(command, /if ! command -v pm2/);
  assert.match(command, /NVM_DIR/);
  assert.match(command, /nvm\.sh/);
});

test('SSH refuses to start PM2 when the script path points to a directory', async () => {
  const calls = [];
  const manager = createSshManager({ pm2Path: 'pm2' }, async (_config, command) => {
    calls.push(command);
    if (command.startsWith('if [ ! -f ')) throw new Error('Укажите путь к файлу приложения');
    throw new Error('PM2 must not be called');
  });
  await assert.rejects(manager.start({ name: 'PM2M', script: '/Projects/pm2m', cwd: '/Projects' }), /путь к файлу/);
  assert.equal(calls.length, 1);
});

test('logs are bounded and missing log files return empty text', async t => {
  const { directory } = await fixture(t); const file = path.join(directory, 'app.log');
  await writeFile(file, Array.from({ length: 10000 }, (_, i) => `line ${i} ${'x'.repeat(100)}`).join('\n'));
  const text = await tail(file, 20); assert.equal(text.split('\n').length, 20); assert.match(text, /line 9999/);
  assert.equal(await tail(path.join(directory, 'missing.log')), '');
  assert.throws(() => validateStart({ name: 'bad name', script: '/srv/app.js' }), /Имя/);
});
