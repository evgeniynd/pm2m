import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalize } from './manager.js';
import { discoveryScript, parseNodeVersions } from './node-versions.js';
import { errorFiles, readErrorFiles } from './error-logs.js';

export const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const fingerprint = key => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');

export async function probeHost(config) {
  const { Client } = (await import('ssh2')).default;
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => { client.destroy(); reject(new Error('SSH: время ожидания истекло')); }, 12000);
    client.on('error', error => { clearTimeout(timer); reject(error); });
    client.on('close', () => { clearTimeout(timer); reject(new Error('SSH-соединение закрыто до получения ключа')); });
    client.connect({ host: config.host, port: config.port, username: config.username, readyTimeout: 10000,
      hostVerifier(key) { clearTimeout(timer); resolve({ fingerprint: fingerprint(key) }); return false; }
    });
  });
}

export async function execute(config, command) {
  const { Client } = (await import('ssh2')).default;
  const privateKey = config.auth === 'key' ? await readFile(config.keyPath) : undefined;
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false; let stdout = ''; let stderr = ''; let bytes = 0; let mismatch = false;
    const done = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); client.end();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => { done(new Error('SSH: команда не завершилась за 30 секунд; проверьте состояние процесса перед повтором')); client.destroy(); }, 30000);
    client.on('error', error => done(new Error(mismatch ? 'Отпечаток SSH изменился. Проверьте сервер и обновите настройки.' : `SSH: ${error.message}`)));
    client.on('close', () => { if (!settled) done(new Error('SSH-соединение закрыто')); });
    client.on('ready', () => client.exec(command, (error, stream) => {
      if (error) return done(error);
      const append = (data, isError) => {
        bytes += data.length;
        if (bytes > 4 * 1024 * 1024) { done(new Error('SSH: ответ превышает 4 МБ')); stream.close(); return; }
        if (isError) stderr += data.toString(); else stdout += data.toString();
      };
      stream.on('data', data => append(data, false));
      stream.stderr.on('data', data => append(data, true));
      stream.on('error', done);
      stream.on('close', code => done(code === 0 ? null : new Error(stderr.trim().slice(0, 1200) || `SSH: код завершения ${code}`), stdout));
    }));
    client.connect({ host: config.host, port: config.port, username: config.username, privateKey,
      password: config.password, passphrase: config.passphrase, readyTimeout: 12000,
      hostVerifier(key) { mismatch = fingerprint(key) !== config.fingerprint; return !mismatch; }
    });
  });
}

export function parseList(text) {
  // PM2 can print its startup banner before the JSON array.
  for (let index = text.indexOf('['); index !== -1; index = text.indexOf('[', index + 1)) {
    try { const value = JSON.parse(text.slice(index)); if (Array.isArray(value)) return value; } catch {}
  }
  throw new Error('PM2 вернул некорректный список. Проверьте путь к PM2 и окружение SSH.');
}

export function createSshManager(config, run = execute) {
  const executable = config.pm2Path || 'pm2';
  // Non-interactive SSH login shells often skip the nvm block in .bashrc.
  // An explicit binary path also needs its sibling node executable on PATH.
  const environment = path.posix.isAbsolute(executable)
    ? `export PATH=${quote(path.posix.dirname(executable))}:"$PATH"; `
    : 'if ! command -v pm2 >/dev/null 2>&1; then if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null; fi; fi; ';
  const check = `if ! command -v ${quote(executable)} >/dev/null 2>&1; then printf '%s\\n' 'PM2 не найден в SSH-окружении. Укажите абсолютный путь к PM2 в настройках сервера.' >&2; exit 127; fi; `;
  const prefix = `${config.pm2Home ? `PM2_HOME=${quote(config.pm2Home)} ` : ''}${quote(executable)}`;
  const pm2 = args => run(config, `bash -lc ${quote(`${environment}${check}${prefix} ${args.map(quote).join(' ')}`)}`);
  const raw = async () => parseList(await pm2(['jlist']));
  return {
    list: async () => (await raw()).map(normalize),
    async installRepository(repository, destination, branch) {
      const clone = `git clone --branch ${quote(branch)} --single-branch ${quote(repository)} ${quote(destination)}`;
      const install = `if [ -f ${quote(path.posix.join(destination, 'package-lock.json'))} ]; then cd ${quote(destination)} && npm ci; elif [ -f ${quote(path.posix.join(destination, 'package.json'))} ]; then cd ${quote(destination)} && npm install; fi`;
      await run(config, `bash -lc ${quote(`${clone} && ${install}`)}`);
    },
    async update(id) {
      const process = (await raw()).find(p => p.pm_id === id);
      if (!process) throw new Error('Процесс не найден');
      if (!process.pm2_env?.pm_cwd) throw new Error('У процесса не указана рабочая папка');
      await run(config, `bash -lc ${quote(`cd ${quote(process.pm2_env.pm_cwd)} && git pull --ff-only`)}`);
      await pm2(['restart', String(id)]);
    },
    system: async () => {
      const totalMemory = Number((await run(config, `bash -lc ${quote(environment + "awk '/^MemTotal:/ {print $2 * 1024}' /proc/meminfo")}`)).trim());
      if (!Number.isFinite(totalMemory) || totalMemory <= 0) throw new Error('Не удалось получить объём памяти сервера.');
      return { totalMemory };
    },
    async errorLogs(ids, cursors = {}) {
      const files = errorFiles(await raw(), ids);
      if (!files.length) return [];
      const script = `const result = (${readErrorFiles.toString()})(require('fs'), require('crypto'), ${JSON.stringify(files)}, ${JSON.stringify(cursors)}); console.log(Buffer.from(JSON.stringify(result)).toString('base64'));`;
      const result = await run(config, `bash -lc ${quote(environment + 'node -e ' + quote(script))}`);
      return JSON.parse(Buffer.from(result.trim(), 'base64').toString('utf8'));
    },
    nodeVersions: async () => parseNodeVersions(await run(config, `bash -lc ${quote(environment + '\n' + discoveryScript)}`)),
    async action(id, action) {
      if (!Number.isSafeInteger(id) || !['start', 'stop', 'restart', 'reload', 'delete'].includes(action)) throw new Error('Недопустимое действие');
      if (!(await raw()).some(p => p.pm_id === id)) throw new Error('Процесс не найден');
      await pm2([action === 'start' ? 'restart' : action, String(id)]);
    },
    async start(app) {
      await run(config, `if [ ! -f ${quote(app.script)} ]; then printf '%s\\n' 'Укажите путь к файлу приложения, например /Projects/pm2m/server.js, а не к папке.' >&2; exit 1; fi; if [ ! -d ${quote(app.cwd)} ]; then printf '%s\\n' 'Рабочая папка не найдена на сервере.' >&2; exit 1; fi`);
      return pm2(['start', app.script, '--name', app.name, '--cwd', app.cwd, ...(app.interpreter ? ['--interpreter', app.interpreter] : [])]);
    },
    async logs(id) {
      const p = (await raw()).find(p => p.pm_id === id);
      if (!p) throw new Error('Процесс не найден');
      const read = async file => file ? (await run(config, `if [ -f ${quote(file)} ]; then tail -c 131072 -- ${quote(file)}; fi`)).split('\n').slice(-200).join('\n') : '';
      const [stdout, stderr] = await Promise.all([read(p.pm2_env.pm_out_log_path), read(p.pm2_env.pm_err_log_path)]);
      return { stdout, stderr };
    },
    save: () => pm2(['save']), close() {}
  };
}
