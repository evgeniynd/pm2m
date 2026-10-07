import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { readErrorFiles } from '../lib/error-logs.js';
import os from 'node:os';
import path from 'node:path';
import { createSettings } from '../lib/settings.js';
import { createDemoManager } from '../lib/manager.js';
import { createTelegram, lastLines, telegramRequest } from '../lib/telegram.js';
import { createServer } from '../server.js';

const token = '123456:' + 'x'.repeat(30);
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pm2m-telegram-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = await createSettings(directory);
  const m = createDemoManager(), calls = [];
  const request = async (token, method, body) => {
    calls.push({ method, body });
    if (method === 'getMe') return { username: 'test_bot' };
    if (method === 'getWebhookInfo') return { url: '' };
    return {};
  };
  const subscription = { serverId: 'local', name: 'api-gateway', script: '/srv/api-gateway/index.js' };
  await settings.saveTelegram({ enabled: true, token, userIds: ['123'], subscriptions: [subscription] });
  const bot = createTelegram({ settings, resolveManager: async () => m, request });
  await bot.start({ background: false }); t.after(() => bot.stop());
  const message = (user = 123, text = '/start') => bot.handle({ message: { from: { id: user }, chat: { id: user, type: 'private' }, text } });
  const click = (key, user = 123) => bot.handle({ callback_query: { id: 'q', data: key, from: { id: user }, message: { chat: { id: user, type: 'private' } } } });
  const key = label => calls.filter(c => c.method === 'sendMessage').at(-1).body.reply_markup.inline_keyboard.flat().find(b => b.text.includes(label)).callback_data;
  return { directory, settings, m, calls, bot, message, click, key, subscription };
}

test('Telegram token encrypted, preserved on empty edit, omitted publicly; offset survives restart', async t => {
  const { settings, directory, subscription } = await fixture(t);
  assert.equal(settings.telegram().token, undefined);
  assert.equal((await readFile(path.join(directory, 'settings.json'), 'utf8')).includes(token), false);
  await settings.telegramOffset(token, 24);
  await settings.saveTelegram({ enabled: true, token: '', userIds: ['123'], subscriptions: [subscription] });
  const restored = await createSettings(directory);
  assert.equal(restored.telegram(true).token, token);
  assert.equal(restored.telegram(true).offset, 24);
  await settings.saveTelegram({ enabled: true, userIds: [], subscriptions: [] });
  assert.deepEqual(settings.telegram().userIds, []);
  await assert.rejects(settings.saveTelegram({ enabled: true, userIds: ['-123'], subscriptions: [] }), /Telegram ID/);
  await settings.saveTelegram({ enabled: false, clearToken: true, userIds: [], subscriptions: [] });
  assert.equal(settings.telegram().hasToken, false);
});

test('Telegram navigation, authorization, confirmation and one-use action', async t => {
  const { m, calls, message, click, key } = await fixture(t);
  await message(999); assert.match(calls.at(-1).body.text, /Ваш Telegram ID/);
  assert.equal(calls.at(-1).body.reply_markup.inline_keyboard.length, 0);
  await message(); await click(key('Локальный')); await click(key('api-gateway'));
  const stop = key('Стоп');
  await click(stop, 999); assert.equal((await m.list())[0].status, 'online');
  await click(stop); assert.equal((await m.list())[0].status, 'online');
  const confirm = key('Подтвердить'); await click(confirm);
  assert.equal((await m.list())[0].status, 'stopped');
  await m.action(0, 'start'); await click(confirm);
  assert.equal((await m.list())[0].status, 'online');
});

test('stale process identity cannot target replacement and settings changes invalidate menus', async t => {
  const { m, message, click, key, bot, calls } = await fixture(t);
  await message(); await click(key('Локальный')); const app = key('api-gateway');
  const originalList = m.list;
  m.list = async () => (await originalList()).map(p => ({ ...p, script: '/changed.js' }));
  await click(app); assert.match(calls.at(-1).body.text, /изменилось/);
  await bot.start({ background: false }); await click(app);
  assert.match(calls.at(-1).body.text, /устарело/);
});

test('notifications baseline, selected app changes, deletions and no duplicates', async t => {
  const { m, calls, bot } = await fixture(t);
  await bot.monitor(); assert.equal(calls.filter(c => c.method === 'sendMessage').length, 0);
  await m.action(1, 'stop'); await bot.monitor();
  assert.equal(calls.filter(c => c.method === 'sendMessage').length, 0);
  await m.action(0, 'restart'); await bot.monitor();
  assert.match(calls.at(-1).body.text, /рестарты 1/);
  const count = calls.length; await bot.monitor(); assert.equal(calls.length, count);
  await m.action(0, 'delete'); await bot.monitor(); assert.match(calls.at(-1).body.text, /удалено/);
});

test('last 30 log lines and plain text response', async t => {
  const { m, calls, message, click, key } = await fixture(t);
  const lines = Array.from({ length: 50 }, (_, i) => `<entry ${i}>`).join('\n') + '\n';
  assert.equal(lastLines(lines).split('\n').length, 30);
  m.logs = async () => ({ stdout: lines, stderr: '' });
  await message(); await click(key('Локальный')); await click(key('api-gateway')); await click(key('stdout'));
  assert.equal(calls.at(-1).body.text, lastLines(lines));
  assert.equal(calls.at(-1).body.parse_mode, undefined);
});

test('Telegram network errors do not reveal token', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error(`https://api.telegram.org/bot${token}/getMe`); };
  try { await assert.rejects(telegramRequest(token, 'getMe', {}), error => !error.message.includes(token)); }
  finally { globalThis.fetch = previous; }
});

test('Telegram settings API requires login and hides token in save/read responses', async t => {
  const { settings, m } = await fixture(t);
  const server = createServer({ settings, resolveManager: async () => m, password: 'test' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/telegram')).status, 401);
  const headers = { 'Content-Type': 'application/json', 'X-PM2M-Request': '1' };
  const login = await fetch(base + '/api/login', { method: 'POST', headers, body: JSON.stringify({ password: 'test' }) });
  headers.Cookie = login.headers.get('set-cookie').split(';')[0];
  const saved = await fetch(base + '/api/telegram', { method: 'POST', headers, body: JSON.stringify({ enabled: true, userIds: ['123'], subscriptions: [] }) });
  assert.equal(saved.status, 200); assert.equal((await saved.text()).includes(token), false);
  const body = await (await fetch(base + '/api/telegram', { headers })).json();
  assert.equal(body.config.hasToken, true); assert.equal(body.config.token, undefined);
});

test('webhook is reported without silently deleting it', async t => {
  const { settings, m } = await fixture(t);
  const methods = [];
  const bot = createTelegram({ settings, resolveManager: async () => m, request: async (token, method) => {
    methods.push(method); return method === 'getMe' ? { username: 'test' } : { url: 'https://example.com/webhook' };
  } });
  await bot.start({ background: false }); t.after(() => bot.stop());
  assert.equal(bot.status().running, false); assert.match(bot.status().error, /webhook/);
  assert.deepEqual(methods, ['getMe', 'getWebhookInfo']);
});

test('server outage and recovery notifications are not repeated each poll', async t => {
  const { m, bot, calls } = await fixture(t);
  await bot.monitor(); const original = m.list;
  m.list = async () => { throw new Error('offline'); };
  await bot.monitor(); assert.match(calls.at(-1).body.text, /нет подключения/);
  const count = calls.length; await bot.monitor(); assert.equal(calls.length, count);
  m.list = original; await bot.monitor(); assert.match(calls.at(-1).body.text, /восстановлено/);
});

test('first-time setup permits /id but no server access until an administrator is assigned', async t => {
  const { settings, bot, message, calls } = await fixture(t);
  await settings.saveTelegram({ enabled: true, userIds: [], subscriptions: [] });
  await bot.start({ background: false });
  assert.equal(bot.status().running, true);
  await message(123, '/id'); assert.equal(calls.at(-1).body.reply_markup.inline_keyboard.length, 0);
  assert.match(calls.at(-1).body.text, /123/);
  const count = calls.length; await message(123, '/servers'); assert.equal(calls.length, count);
});

test('new stderr notifies while PM2 stays online; old lines and unchanged logs do not notify', async t => {
  const { m, bot, calls, directory } = await fixture(t);
  const file = path.join(directory, 'stderr.log'); await writeFile(file, 'old error\n');
  m.errorLogs = async (ids, cursors) => {
    assert.deepEqual(ids, [0]);
    return readErrorFiles(fs, crypto, [{ file, ids: [0] }], cursors);
  };
  await bot.monitor(); const before = calls.length;
  await appendFile(file, 'новая ошибка\n'); await bot.monitor();
  assert.match(calls.at(-1).body.text, /stderr.*api-gateway/s);
  assert.match(calls.at(-1).body.text, /новая ошибка/);
  assert.equal(calls.at(-1).body.text.includes('old error'), false);
  assert.equal((await m.list())[0].status, 'online');
  assert.equal(calls.length, before + 1);
  await bot.monitor(); assert.equal(calls.length, before + 1);
});

test('failed stderr delivery does not advance cursor and is retried', async t => {
  const { settings, m, directory } = await fixture(t);
  const file = path.join(directory, 'stderr.log'); await writeFile(file, '');
  m.errorLogs = async (ids, cursors) => readErrorFiles(fs, crypto, [{ file, ids: [0] }], cursors);
  let fail = true; const delivered = [];
  const bot = createTelegram({ settings, resolveManager: async () => m, request: async (_, method, body) => {
    if (method === 'getMe') return { username: 'test' };
    if (method === 'getWebhookInfo') return { url: '' };
    if (method === 'sendMessage') { if (fail) throw new Error('Delivery failed'); delivered.push(body.text); }
    return {};
  } });
  t.after(() => bot.stop()); await bot.start({ background: false }); await bot.monitor();
  await appendFile(file, 'retry me\n'); await assert.rejects(bot.monitor(), /Delivery failed/);
  fail = false; await bot.monitor(); assert.equal(delivered.length, 1); assert.match(delivered[0], /retry me/);
  await bot.monitor(); assert.equal(delivered.length, 1);
});

test('stdout is never included in notifications, even with ERROR markers', async t => {
  const { m, bot, calls, directory } = await fixture(t);
  const file = path.join(directory, 'stdout.log'); await writeFile(file, 'INFO running\n');
  m.errorLogs = async (ids, cursors) => readErrorFiles(fs, crypto, [{ file, ids: [0], stream: 'stdout' }], cursors);
  await bot.monitor(); const before = calls.length;
  await appendFile(file, 'INFO another request\n'); await bot.monitor(); assert.equal(calls.length, before);
  const error = 'ERROR IN ELSE: delallmess : Error: ETELEGRAM: 400 Bad Request: message to delete not found\n';
  for (let i = 1; i <= 2; i++) {
    await appendFile(file, error); await bot.monitor();
    assert.equal(calls.length, before);
  }
});
