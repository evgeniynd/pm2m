import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { localNodeVersions } from './node-versions.js';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { errorFiles, readErrorFiles } from './error-logs.js';

export function normalize(p) {
  const e = p.pm2_env || {};
  return { id: p.pm_id, name: p.name, pid: p.pid, status: e.status,
    cpu: p.monit?.cpu || 0, memory: p.monit?.memory || 0,
    uptime: e.status === 'online' ? Math.max(0, Date.now() - (e.pm_uptime || Date.now())) : 0,
    restarts: e.restart_time || 0, mode: e.exec_mode, script: e.pm_exec_path, cwd: e.pm_cwd,
    interpreter: e.exec_interpreter, nodeVersion: e.node_version };
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
  return {
    list: async () => (await raw()).map(normalize),
    nodeVersions: localNodeVersions,
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
  return { name: body.name, script: body.script, cwd, ...(body.interpreter ? { interpreter: body.interpreter } : {}) };
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
    nodeVersions: async () => [
      { version: 'v22.14.0', path: '/usr/bin/node', default: true },
      { version: 'v20.19.0', path: '/home/demo/.nvm/versions/node/v20.19.0/bin/node', default: false }
    ],
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
