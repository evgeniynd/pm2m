import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { createManager, createDemoManager, validateStart } from './lib/manager.js';
import { createSettings, validateAddress } from './lib/settings.js';
import { createSshManager, probeHost } from './lib/ssh.js';
import { createSessionStore, memorySessions, COOKIE_MAX_AGE } from './lib/sessions.js';
import { createTelegram } from './lib/telegram.js';
import { analyzeGroq, redact } from './lib/ai.js';

const digest = value => createHash('sha256').update(value).digest();
async function githubJson(url, options = {}) {
  let response;
  try { response = await fetch(url, { ...options, headers: { Accept: 'application/json', ...(options.headers || {}) }, signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error('GitHub недоступен. Проверьте соединение панели.'); }
  let result = {}; try { result = await response.json(); } catch {}
  if (!response.ok) throw new Error('GitHub отклонил запрос авторизации. Проверьте Client ID и настройки Device Flow.');
  return result;
}
export function createServer({ resolveManager, settings, password, telegram, demo = false, secure = false, sessions = memorySessions() }) {
  const attempts = new Map();
  const cookie = (value, age) => `pm2m_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const maintenance = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
  }, 60000).unref();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) {
        const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
        const asset = files[url.pathname];
        if (req.method !== 'GET' || !asset) return send(404, { error: 'Не найдено' });
        const content = await readFile(new URL(`./public/${asset[0]}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` }); return res.end(content);
      }
      let body = {};
      if (req.method === 'POST') {
        if (req.headers['content-type'] !== 'application/json' || req.headers['x-pm2m-request'] !== '1') return send(403, { error: 'Недопустимый запрос' });
        let bytes = 0; const chunks = [];
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 16384) return send(413, { error: 'Слишком большой запрос' }); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return send(400, { error: 'Некорректный JSON' }); }
        if (!body || Array.isArray(body) || typeof body !== 'object') return send(400, { error: 'Некорректный запрос' });
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const ip = req.socket.remoteAddress;
        let rate = attempts.get(ip);
        if (!rate || rate.until < Date.now()) { rate = { count: 0, until: Date.now() + 15 * 60000 }; attempts.set(ip, rate); }
        if (rate.count >= 10) return send(429, { error: 'Слишком много попыток. Повторите через 15 минут.' });
        rate.count++;
        if (typeof body.password !== 'string' || !timingSafeEqual(digest(body.password), digest(password))) return send(401, { error: 'Неверный пароль' });
        attempts.delete(ip);
        const token = await sessions.create();
        res.setHeader('Set-Cookie', cookie(token, COOKIE_MAX_AGE)); return send(200, { ok: true });
      }
      const token = /(?:^|;\s*)pm2m_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      if (!token || !sessions.has(token)) return send(401, { error: 'Войдите в панель' });
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        await sessions.revoke(token); res.setHeader('Set-Cookie', cookie('', 0)); return send(200, { ok: true });
      }
      res.setHeader('Set-Cookie', cookie(token, COOKIE_MAX_AGE));
      if (req.method === 'GET' && url.pathname === '/api/github') return send(200, { config: { hasToken: settings.github().hasToken } });
      if (req.method === 'POST' && url.pathname === '/api/github/token') {
        const githubToken = String(body.token || '').trim();
        if (!/^(?:ghp_|gho_|ghu_|github_pat_)[A-Za-z0-9_]+$/.test(githubToken)) throw new Error('Укажите GitHub Personal Access Token.');
        const profile = await githubJson('https://api.github.com/user', { headers: { Authorization: `Bearer ${githubToken}`, 'User-Agent': 'PM2M' } });
        if (!profile.login) throw new Error('GitHub не подтвердил токен или токен не имеет доступа к API.');
        await settings.saveGithubToken(githubToken);
        return send(200, { connected: true, login: profile.login });
      }
      if (req.method === 'POST' && url.pathname === '/api/github/disconnect') { await settings.saveGithubToken(''); return send(200, { connected: false }); }
      if (req.method === 'GET' && url.pathname === '/api/ai') return send(200, { config: settings.ai() });
      if (req.method === 'POST' && url.pathname === '/api/ai') {
        await settings.saveAi(body);
        void telegram?.start();
        return send(200, { config: settings.ai() });
      }
      if (req.method === 'GET' && url.pathname === '/api/telegram') return send(200, { config: settings.telegram(), status: telegram?.status() });
      if (req.method === 'POST' && url.pathname === '/api/telegram') {
        await settings.saveTelegram(body);
        void telegram?.start();
        return send(200, { config: settings.telegram(), status: telegram?.status() });
      }
      if (req.method === 'GET' && url.pathname === '/api/servers') return send(200, { servers: settings.list() });
      if (req.method === 'POST' && url.pathname === '/api/servers') return send(200, { server: await settings.save(body) });
      if (req.method === 'POST' && url.pathname === '/api/ssh/probe') return send(200, await probeHost(validateAddress(body)));
      const serverAction = /^\/api\/servers\/([a-zA-Z0-9-]+)\/(delete|test)$/.exec(url.pathname);
      if (serverAction && req.method === 'POST') {
        if (serverAction[2] === 'delete') await settings.remove(serverAction[1]);
        else { const m = await resolveManager(settings.get(serverAction[1])); await m.list(); }
        return send(200, { ok: true });
      }
      const target = settings.get(url.searchParams.get('server') || 'local');
      const manager = await resolveManager(target);
      if (req.method === 'POST' && url.pathname === '/api/ai/analyze') {
        const processId = Number(body.processId);
        if (!Number.isSafeInteger(processId) || processId < 0) throw new Error('Некорректный идентификатор процесса.');
        const config = settings.ai(true);
        const logs = await manager.logs(processId);
        const stderr = String(logs.stderr || '');
        if (!stderr.trim()) throw new Error('В stderr нет записей для анализа.');
        const processes = await manager.list();
        const process = processes.find(item => item.id === processId);
        const secrets = [config.apiKey, target.password, target.passphrase];
        const context = redact(JSON.stringify({
          server: target.name || target.host || 'Локальный сервер', capturedAt: new Date().toISOString(),
          process: process && { name: process.name, id: process.id, status: process.status, restarts: process.restarts },
          stderr: stderr.split('\n').slice(-100).join('\n')
        }), secrets).slice(-12000);
        const answer = await analyzeGroq(config, context);
        return send(200, { answer: redact(answer, secrets) });
      }
      if (req.method === 'GET' && url.pathname === '/api/processes') return send(200, {
        processes: await manager.list(), host: target.type === 'ssh' ? target.host : os.hostname(), platform: target.type === 'ssh' ? 'linux' : os.platform(), demo: demo && target.type === 'local',
        system: target.type === 'local'
          ? { cpus: os.cpus().length, totalMemory: os.totalmem(), usedMemory: os.totalmem() - os.freemem(), load: os.loadavg()[0] }
          : (typeof manager.system === 'function' ? await manager.system() : null)
      });
      if (req.method === 'GET' && url.pathname === '/api/node-versions') return send(200, { versions: await manager.nodeVersions() });
      if (req.method === 'GET' && url.pathname === '/api/processes/git-updates') return send(200, { updates: typeof manager.gitUpdates === 'function' ? await manager.gitUpdates({ token: settings.github(true).token }) : {} });
      if (req.method === 'POST' && url.pathname === '/api/processes') {
        const config = validateStart(body, target.type === 'ssh' ? path.posix : path);
        if (config.interpreter && !(await manager.nodeVersions()).some(node => node.path === config.interpreter)) throw new Error('Выбранная версия Node.js больше недоступна. Обновите список версий.');
        if (config.repository) await manager.installRepository(config.repository, config.destination, config.branch, { token: settings.github(true).token });
        const { repository, destination, branch, ...startConfig } = config;
        await manager.start(startConfig); return send(201, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/save') { await manager.save(); return send(200, { ok: true }); }
      const match = /^\/api\/processes\/(\d+)\/(start|stop|restart|reload|delete|update|logs)$/.exec(url.pathname);
      if (match && Number.isSafeInteger(Number(match[1]))) {
        if (req.method === 'GET' && match[2] === 'logs') return send(200, await manager.logs(Number(match[1])));
        if (req.method === 'POST' && match[2] !== 'logs') {
          if (match[2] === 'update') await manager.update(Number(match[1]), { token: settings.github(true).token });
          else await manager.action(Number(match[1]), match[2]);
          return send(200, { ok: true });
        }
      }
      send(404, { error: 'Не найдено' });
    } catch (error) { send(400, { error: error.message || 'Не удалось выполнить операцию' }); }
  });
  server.on('close', () => clearInterval(maintenance));
  return server;
}

const entryPath = process.env.pm_exec_path || process.argv[1];
if (entryPath && fileURLToPath(import.meta.url) === path.resolve(entryPath)) {
  try { loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url))); }
  catch (error) { if (error.code !== 'ENOENT') { console.error(`Не удалось загрузить .env: ${error.message}`); process.exit(1); } }
  const demo = process.argv.includes('--demo');
  const password = process.env.ADMIN_PASSWORD || (demo ? 'demo' : '');
  if (!password || (!demo && password === 'replace-with-a-long-random-password')) {
    console.error('Задайте свой непустой ADMIN_PASSWORD в .env'); process.exit(1);
  }
  try {
    const settings = await createSettings(fileURLToPath(new URL(demo ? './data/demo/' : './data/', import.meta.url)));
    const sessions = await createSessionStore(fileURLToPath(new URL(demo ? './data/demo/' : './data/', import.meta.url)), password);
    let localPromise;
    const resolveManager = async target => {
      if (target.type === 'ssh') return createSshManager(target);
      if (!localPromise) localPromise = (demo ? Promise.resolve(createDemoManager()) : createManager()).catch(error => { localPromise = undefined; throw error; });
      return localPromise;
    };
    const telegram = createTelegram({ settings, resolveManager });
    const close = async () => { telegram.stop(); if (localPromise) (await localPromise).close(); };
    const server = createServer({ resolveManager, settings, password, telegram, demo, sessions, secure: process.env.COOKIE_SECURE === 'true' });
    const host = process.env.HOST || '127.0.0.1';
    const port = Number(process.env.PORT || 3100);
    server.on('error', async error => { console.error(error.message); await close(); process.exit(1); });
    server.listen(port, host, () => { console.log(`PM2M: http://${host}:${server.address().port}${demo ? ' (DEMO)' : ''}`); void telegram.start(); });
    const shutdown = () => { server.close(async () => { await close(); process.exit(0); }); setTimeout(() => process.exit(1), 5000).unref(); };
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  } catch (error) { console.error(`PM2: ${error.message}`); process.exit(1); }
}
