import { open, stat, rename as renameFile } from 'node:fs/promises';
import path from 'node:path';
import { localNodeVersions } from './node-versions.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { errorFiles, readErrorFiles } from './error-logs.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function normalize(p) {
  const e = p.pm2_env || {};
  let rawArgs = e.args;
  if ((!rawArgs || (Array.isArray(rawArgs) && rawArgs.length === 0)) && typeof e.command === 'string' && e.command) {
    const command = e.command.trim(); const script = String(e.pm_exec_path || '').trim();
    rawArgs = script && command.startsWith(script) ? command.slice(script.length).trim() : command;
  }
  let args = Array.isArray(rawArgs) ? rawArgs : [];
  if (typeof rawArgs === 'string') { try { const parsed = JSON.parse(rawArgs.replace(/'/g, '"')); args = Array.isArray(parsed) ? parsed : parseArgs(rawArgs); } catch { args = parseArgs(rawArgs); } }
  return { id: p.pm_id, name: p.name, pid: p.pid, status: e.status,
    cpu: p.monit?.cpu || 0, memory: p.monit?.memory || 0,
    uptime: e.status === 'online' ? Math.max(0, Date.now() - (e.pm_uptime || Date.now())) : 0,
    restarts: e.restart_time || 0, mode: e.exec_mode, script: e.pm_exec_path, cwd: e.pm_cwd, args,
    interpreter: e.exec_interpreter, nodeVersion: e.node_version };
}
export function parseArgs(value) {
  const input = String(value || ''); const result = []; let current = ''; let quoteChar = ''; let escaped = false;
  for (const char of input) { if (escaped) { current += char; escaped = false; } else if (char === '\\' && quoteChar !== "'") escaped = true; else if (quoteChar) { if (char === quoteChar) quoteChar = ''; else current += char; } else if (char === '"' || char === "'") quoteChar = char; else if (/\s/.test(char)) { if (current) { result.push(current); current = ''; } } else current += char; }
  if (escaped) current += '\\'; if (quoteChar) throw new Error('Аргументы содержат незакрытые кавычки'); if (current) result.push(current); return result;
}

export async function tail(file, lines = 200) {
  if (!file) return '';
  let handle;
  try {
    handle = await open(file, 'r');
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Лог не является обычным файлом');
    const size = Math.min(info.size, 128 * 1024);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, info.size - size);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (info.size > size) text = text.slice(text.indexOf('\n') + 1);
    return text.split('\n').slice(-lines).join('\n');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  } finally { await handle?.close(); }
}

export async function createManager() {
  const { default: pm2 } = await import('pm2');
  const call = (method, ...args) => new Promise((resolve, reject) => {
    pm2[method](...args, (error, result) => error ? reject(error) : resolve(result));
  });
  await call('connect');
  const raw = () => call('list');
  const gitInfo = async (cwd, env) => {
    const git = process.platform === 'win32' ? 'git.exe' : 'git';
    const options = { env: { ...process.env, ...env }, maxBuffer: 1024 * 1024, timeout: 15000 };
    const run = args => execFileAsync(git, args, options);
    try {
      await run(['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 128) return { available: false };
      return { available: false };
    }
    try {
      const branch = (await run(['-C', cwd, 'branch', '--show-current'])).stdout.trim();
      const current = (await run(['-C', cwd, 'rev-parse', 'HEAD'])).stdout.trim();
      await run(['-C', cwd, 'remote', 'get-url', 'origin']);
      const remoteRef = branch ? `refs/heads/${branch}` : 'HEAD';
      let latest = (await run(['-C', cwd, 'ls-remote', 'origin', remoteRef])).stdout.trim().split(/\s+/)[0] || '';
      if (!latest) latest = (await run(['-C', cwd, 'ls-remote', 'origin', 'HEAD'])).stdout.trim().split(/\s+/)[0] || '';
      return { available: true, updateAvailable: Boolean(latest) && latest !== current, branch, current: current.slice(0, 7), latest: latest.slice(0, 7) };
    } catch (error) {
      return { available: true, updateAvailable: null, error: 'Не удалось проверить GitHub' };
    }
  };
  const repoPath = async (process, env = {}) => {
    const git = process.platform === 'win32' ? 'git.exe' : 'git';
    const options = { env: { ...process.env, ...env }, maxBuffer: 1024 * 1024, timeout: 15000 };
    const candidates = [process.pm2_env?.pm_cwd, process.pm2_env?.pm_exec_path && path.dirname(process.pm2_env.pm_exec_path)].filter(Boolean).filter((item, index, all) => all.indexOf(item) === index);
    for (const cwd of candidates) { try { await execFileAsync(git, ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], options); return cwd; } catch {} }
    throw new Error(`Папки «${candidates.join('» и «')}» не являются Git-репозиторием. Сначала клонируйте репозиторий или добавьте приложение через «Новое приложение».`);
  };
  const gitChanges = async (cwd, env) => {
    const git = process.platform === 'win32' ? 'git.exe' : 'git';
    const options = { env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 * 2, timeout: 30000 };
    const run = args => execFileAsync(git, args, options);
    try { await run(['-C', cwd, 'rev-parse', '--is-inside-work-tree']); } catch { return { available: false, commits: [] }; }
    const clearRemoteRefs = async () => {
      const refs = (await run(['-C', cwd, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin'])).stdout.split(/\r?\n/).filter(Boolean);
      for (const ref of refs) await run(['-C', cwd, 'update-ref', '-d', ref]);
    };
    try {
      await clearRemoteRefs();
      const branch = (await run(['-C', cwd, 'branch', '--show-current'])).stdout.trim();
      if (!branch) return { available: true, commits: [] };
      let fetched = false; let fetchError;
      for (const candidate of [branch, 'main', 'master'].filter((item, index, all) => item && all.indexOf(item) === index)) {
        try { await run(['-C', cwd, 'fetch', '--quiet', 'origin', candidate]); fetched = true; break; } catch (error) { fetchError = error; }
      }
      if (!fetched) {
        try { await run(['-C', cwd, 'fetch', '--quiet', 'origin']); fetched = true; } catch (error) { fetchError = error; }
      }
      if (!fetched) throw fetchError || new Error('GitHub fetch failed');
      let output;
      try { output = (await run(['-C', cwd, 'log', '--format=%H%x1f%an%x1f%aI%x1f%s%x1e', '--max-count=20', 'HEAD..FETCH_HEAD'])).stdout; }
      catch { output = (await run(['-C', cwd, 'log', '--format=%H%x1f%an%x1f%aI%x1f%s%x1e', '--max-count=20', 'FETCH_HEAD'])).stdout; }
      const commits = output.split('\x1e').map(item => item.trim()).filter(Boolean).map(item => {
        const [hash, author, date, subject] = item.split('\x1f');
        return { hash: hash?.slice(0, 7), author, date, subject };
      });
      return { available: true, commits };
    } catch (error) { const detail = String(error?.message || '').split('\n').filter(Boolean).slice(-2).join(' ').replace(/https?:\/\/\S+/g, 'GitHub').slice(0, 240); return { available: true, commits: [], error: `Не удалось получить список изменений${detail ? `: ${detail}` : ''}` }; }
  };
  return {
    list: async () => (await raw()).map(normalize),
    async attachRepository(id, repository, { token } = {}) {
      const process = (await raw()).find(item => item.pm_id === id);
      if (!process?.pm2_env?.pm_cwd) throw new Error('Рабочая папка процесса не найдена');
      if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repository)) throw new Error('Укажите HTTPS URL репозитория GitHub');
      const authHeader = token ? Buffer.from(`x-access-token:${token}`).toString('base64') : '';
      const gitEnv = token ? { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${authHeader}` } : { GIT_TERMINAL_PROMPT: '0' };
      const options = { env: { ...process.env, ...gitEnv }, maxBuffer: 1024 * 1024 * 2 };
      const git = process.platform === 'win32' ? 'git.exe' : 'git';
      let cwd;
      try { cwd = await repoPath(process, gitEnv); }
      catch {
        cwd = process.pm2_env.pm_exec_path ? path.dirname(process.pm2_env.pm_exec_path) : process.pm2_env.pm_cwd;
        await execFileAsync(git, ['-C', cwd, 'init', '-b', 'main'], options);
        await execFileAsync(git, ['-C', cwd, 'remote', 'add', 'origin', repository], options);
        await execFileAsync(git, ['-C', cwd, '-c', 'user.name=PM2M', '-c', 'user.email=pm2m@localhost', 'commit', '--allow-empty', '-m', 'PM2M baseline'], options);
      }
      try { await execFileAsync(git, ['-C', cwd, 'fsck', '--no-progress'], options); }
      catch {
        await renameFile(path.join(cwd, '.git'), path.join(cwd, `.git.pm2m-corrupt-${Date.now()}`));
        await execFileAsync(git, ['-C', cwd, 'init', '-b', 'main'], options);
        await execFileAsync(git, ['-C', cwd, 'remote', 'add', 'origin', repository], options);
        await execFileAsync(git, ['-C', cwd, '-c', 'user.name=PM2M', '-c', 'user.email=pm2m@localhost', 'commit', '--allow-empty', '-m', 'PM2M baseline'], options);
      }
      if (cwd && await (async () => { try { await execFileAsync(git, ['-C', cwd, 'remote', 'get-url', 'origin'], options); return true; } catch { return false; } })()) {
        try { await execFileAsync(git, ['-C', cwd, 'remote', 'set-url', 'origin', repository], options); } catch {}
      }
      try { await execFileAsync(git, ['-C', cwd, 'remote', 'set-url', 'origin', repository], options); }
      catch { await execFileAsync(git, ['-C', cwd, 'remote', 'add', 'origin', repository], options); }
    },
    async gitUpdates({ token, paths = {} } = {}) {
      const authHeader = token ? Buffer.from(`x-access-token:${token}`).toString('base64') : '';
      const gitEnv = token ? { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${authHeader}` } : { GIT_TERMINAL_PROMPT: '0' };
      const result = {};
      for (const process of await raw()) if (process.pm2_env?.pm_cwd) { const cwd = paths[process.pm_id] || process.pm2_env.pm_cwd; const info = await gitInfo(cwd, gitEnv); result[process.pm_id] = info.available || !process.pm2_env.pm_exec_path ? info : await gitInfo(path.dirname(process.pm2_env.pm_exec_path), gitEnv); }
      return result;
    },
    async gitChanges(id, { token, gitPath } = {}) {
      const process = (await raw()).find(item => item.pm_id === id);
      if (!process?.pm2_env?.pm_cwd) throw new Error('Рабочая папка процесса не найдена');
      const authHeader = token ? Buffer.from(`x-access-token:${token}`).toString('base64') : '';
      const gitEnv = token ? { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${authHeader}` } : { GIT_TERMINAL_PROMPT: '0' };
      return gitChanges(gitPath || await repoPath(process, gitEnv), gitEnv);
    },
    nodeVersions: localNodeVersions,
    async installRepository(repository, destination, branch, { token } = {}) {
      const authHeader = token ? Buffer.from(`x-access-token:${token}`).toString('base64') : '';
      const gitEnv = token ? { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${authHeader}` } : { GIT_TERMINAL_PROMPT: '0' };
      const git = process.platform === 'win32' ? 'git.exe' : 'git';
      try {
        await stat(path.join(destination, '.git'));
        await execFileAsync(git, ['-C', destination, 'pull', '--ff-only', 'origin', branch], { env: { ...process.env, ...gitEnv }, maxBuffer: 1024 * 1024 * 4 });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await execFileAsync(git, ['clone', '--branch', branch, '--single-branch', repository, destination], { env: { ...process.env, ...gitEnv }, maxBuffer: 1024 * 1024 * 4 });
      }
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      try {
        await stat(path.join(destination, 'package-lock.json'));
        try { await execFileAsync(npm, ['ci'], { cwd: destination, maxBuffer: 1024 * 1024 * 8 }); }
        catch { await execFileAsync(npm, ['install'], { cwd: destination, maxBuffer: 1024 * 1024 * 8 }); }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { await stat(path.join(destination, 'package.json')); await execFileAsync(npm, ['install'], { cwd: destination, maxBuffer: 1024 * 1024 * 8 }); }
        catch (packageError) { if (packageError.code !== 'ENOENT') throw packageError; }
      }
    },
    async update(id, { token } = {}) {
      const process = (await raw()).find(p => p.pm_id === id);
      if (!process) throw new Error('Процесс не найден');
      const wasOnline = process.pm2_env?.status === 'online';
      if (process.pid === globalThis.process.pid) throw new Error('Обновляйте саму панель через терминал');
      if (!process.pm2_env?.pm_cwd) throw new Error('У процесса не указана рабочая папка');
      const authHeader = token ? Buffer.from(`x-access-token:${token}`).toString('base64') : '';
      const gitEnv = token ? { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${authHeader}` } : { GIT_TERMINAL_PROMPT: '0' };
      const cwd = await repoPath(process, gitEnv);
      const git = process.platform === 'win32' ? 'git.exe' : 'git';
      const options = { env: { ...process.env, ...gitEnv }, maxBuffer: 1024 * 1024 * 4 };
      const branch = (await execFileAsync(git, ['-C', cwd, 'branch', '--show-current'], options)).stdout.trim();
      const refs = (await execFileAsync(git, ['-C', cwd, 'for-each-ref', '--format=%(refname)', 'refs/remotes/origin'], options)).stdout.split(/\r?\n/).filter(Boolean);
      for (const ref of refs) await execFileAsync(git, ['-C', cwd, 'update-ref', '-d', ref], options);
      let fetched = false; let fetchError;
      for (const candidate of [branch, 'main', 'master'].filter((item, index, all) => item && all.indexOf(item) === index)) {
        try { await execFileAsync(git, ['-C', cwd, 'fetch', '--quiet', 'origin', candidate], options); fetched = true; break; } catch (error) { fetchError = error; }
      }
      if (!fetched) {
        try { await execFileAsync(git, ['-C', cwd, 'fetch', '--quiet', 'origin'], options); fetched = true; } catch (error) { fetchError = error; }
      }
      if (!fetched) throw fetchError || new Error('Не удалось получить обновление из GitHub');
      try { await execFileAsync(git, ['-C', cwd, 'merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD'], options); await execFileAsync(git, ['-C', cwd, 'merge', '--ff-only', 'FETCH_HEAD'], options); }
      catch { await execFileAsync(git, ['-C', cwd, 'reset', '--hard', 'FETCH_HEAD'], options); }
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      try { await stat(path.join(cwd, 'package-lock.json')); try { await execFileAsync(npm, ['ci'], { cwd, maxBuffer: 1024 * 1024 * 8 }); } catch { await execFileAsync(npm, ['install'], { cwd, maxBuffer: 1024 * 1024 * 8 }); } } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (wasOnline) await call('restart', id);
    },
    async errorLogs(ids, cursors = {}) { return readErrorFiles(fs, crypto, errorFiles(await raw(), ids), cursors); },
    async action(id, action) {
      const process = (await raw()).find(p => p.pm_id === id);
      if (!process) throw new Error('Процесс не найден');
      if (process.pid === globalThis.process.pid) throw new Error('Управляйте самой панелью через терминал');
      await call(action === 'start' ? 'restart' : action, id);
    },
    async start(config) {
      if (!(await stat(config.script)).isFile()) throw new Error('Скрипт не является файлом');
      if (!(await stat(config.cwd)).isDirectory()) throw new Error('Рабочая папка не найдена');
      await call('start', { ...config, exec_mode: 'fork', autorestart: true });
    },
    async edit(id, config) {
      const process = (await raw()).find(p => p.pm_id === id);
      if (!process) throw new Error('Процесс не найден');
      const wasOnline = process.pm2_env?.status === 'online';
      await call('delete', id); await call('start', { ...config, exec_mode: 'fork', autorestart: true });
      if (!wasOnline) { const replacement = (await raw()).find(p => p.name === config.name); if (replacement) await call('stop', replacement.pm_id); }
    },
    async logs(id) {
      const p = (await raw()).find(p => p.pm_id === id);
      if (!p) throw new Error('Процесс не найден');
      const [stdout, stderr] = await Promise.all([tail(p.pm2_env.pm_out_log_path), tail(p.pm2_env.pm_err_log_path)]);
      return { stdout, stderr };
    },
    save: () => call('dump'),
    close: () => pm2.disconnect()
  };
}

export function validateStart(body, paths = path) {
  if (typeof body.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.name)) throw new Error('Имя: 1–64 символа, латиница, цифры, _ или -');
  if (typeof body.script !== 'string' || !paths.isAbsolute(body.script)) throw new Error('Укажите абсолютный путь к скрипту');
  const cwd = body.cwd || paths.dirname(body.script);
  if (typeof cwd !== 'string' || !paths.isAbsolute(cwd)) throw new Error('Укажите абсолютный путь к рабочей папке');
  if (body.interpreter !== undefined && (typeof body.interpreter !== 'string' || !paths.isAbsolute(body.interpreter) || /[\x00\r\n]/.test(body.interpreter))) throw new Error('Выберите установленную версию Node.js');
  const repository = String(body.repository || '').trim();
  if (repository && !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repository)) throw new Error('GitHub: укажите HTTPS URL публичного репозитория github.com/owner/repository');
  const destination = body.destination || cwd;
  if (typeof destination !== 'string' || !paths.isAbsolute(destination) || /[\x00\r\n]/.test(destination)) throw new Error('Укажите абсолютную папку установки');
  const branch = String(body.branch || '').trim();
  if (repository && (!branch || !/^[A-Za-z0-9._/-]{1,120}$/.test(branch) || branch.startsWith('/') || branch.endsWith('/'))) throw new Error('Ветка GitHub содержит недопустимые символы');
  const args = parseArgs(body.args);
  return { name: body.name, script: body.script, cwd, ...(body.interpreter ? { interpreter: body.interpreter } : {}), ...(args.length ? { args } : {}), ...(repository ? { repository, destination, branch } : {}) };
}

export function createDemoManager() {
  let processes = ['api-gateway', 'web-frontend', 'queue-worker', 'scheduler'].map((name, id) => ({
    id, name, pid: 24010 + id, status: id === 3 ? 'stopped' : 'online', cpu: [1.8, 0.4, 3.2, 0][id],
    memory: [82, 126, 64, 0][id] * 1024 ** 2, uptime: 7340000, restarts: id === 2 ? 2 : 0,
    mode: 'fork_mode', script: `/srv/${name}/index.js`, cwd: `/srv/${name}`
  }));
  let nextId = processes.length;
  return {
    list: async () => structuredClone(processes),
    errorLogs: async () => [],
    gitUpdates: async () => ({}),
    nodeVersions: async () => [
      { version: 'v22.14.0', path: '/usr/bin/node', default: true },
      { version: 'v20.19.0', path: '/home/demo/.nvm/versions/node/v20.19.0/bin/node', default: false }
    ],
    installRepository: async () => {},
    update: async id => {
      const p = processes.find(p => p.id === id);
      if (!p) throw new Error('Процесс не найден');
      if (p.pid === globalThis.process.pid) throw new Error('Обновляйте саму панель через терминал');
      p.restarts++; p.uptime = 0;
    },
    async action(id, action) {
      const p = processes.find(p => p.id === id);
      if (!p) throw new Error('Процесс не найден');
      if (action === 'delete') processes = processes.filter(p => p.id !== id);
      else { p.status = action === 'stop' ? 'stopped' : 'online'; p.uptime = 0; p.restarts += action === 'restart' || action === 'reload' ? 1 : 0; }
    },
    async start(config) { processes.push({ ...config, id: nextId++, status: 'online', cpu: 0, memory: 0, uptime: 0, restarts: 0, mode: 'fork_mode' }); },
    async logs(id) {
      if (!processes.some(p => p.id === id)) throw new Error('Процесс не найден');
      return { stdout: '[demo] Application started\n[demo] Ready to accept connections\n[demo] Health check passed', stderr: '' };
    },
    save: async () => {}, close() {}
  };
}
