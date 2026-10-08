import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_MODEL } from './ai.js';

export async function createSettings(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const keyFile = path.join(directory, 'secret.key');
  let key;
  try { key = await readFile(keyFile); }
  catch (e) { if (e.code !== 'ENOENT') throw e; key = randomBytes(32); await writeFile(keyFile, key, { flag: 'wx', mode: 0o600 }); }
  await chmod(keyFile, 0o600);
  const file = path.join(directory, 'settings.json');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; state = { version: 1, servers: [{ id: 'local', name: 'Локальный сервер', type: 'local' }] }; }
  if (state.version !== 1 || !Array.isArray(state.servers)) throw new Error('Неподдерживаемый формат data/settings.json');
  const persist = async next => {
    const temp = `${file}.tmp`;
    await writeFile(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, file); state = next;
  };
  await persist(state);
  let queue = Promise.resolve();
  const transaction = fn => { const work = queue.then(fn); queue = work.catch(() => {}); return work; };
  const encrypt = value => {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.');
  };
  const decrypt = value => {
    if (!value) return '';
    const [iv, tag, data] = value.split('.').map(s => Buffer.from(s, 'base64'));
    const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
  };
  const publicServer = s => { const { secret, ...rest } = s; return { ...rest, appRoot: s.appRoot || '/Projects', hasSecret: Boolean(secret) }; };
  return {
    ai(privateView = false) {
      const { apiKey, enabled = false, model = DEFAULT_MODEL } = state.ai || {};
      return { enabled, model, hasKey: Boolean(apiKey), ...(privateView ? { apiKey: decrypt(apiKey) } : {}) };
    },
    saveAi: body => transaction(async () => {
      const old = state.ai || {};
      const key = String(body.apiKey || '').trim();
      const model = String(body.model || DEFAULT_MODEL).trim();
      if (key && !/^gsk_[A-Za-z0-9_-]{16,200}$/.test(key)) throw new Error('Некорректный API-ключ Groq');
      if (!/^[A-Za-z0-9][A-Za-z0-9./_-]{0,119}$/.test(model)) throw new Error('Некорректное название модели');
      const apiKey = body.clearKey ? undefined : key ? encrypt(key) : old.apiKey;
      if (body.enabled && !apiKey) throw new Error('Укажите API-ключ Groq');
      await persist({ ...state, ai: { enabled: Boolean(body.enabled), model, apiKey } });
    }),
    github(privateView = false) {
      const { token: secret } = state.github || {};
      return { hasToken: Boolean(secret), ...(privateView ? { token: decrypt(secret) } : {}) };
    },
    saveGithubToken: token => transaction(async () => {
      const value = String(token || '').trim();
      if (value && !/^(?:ghp_|gho_|ghu_|github_pat_)[A-Za-z0-9_]+$/.test(value)) throw new Error('GitHub вернул некорректный токен');
      await persist({ ...state, github: { token: value ? encrypt(value) : undefined } });
    }),
    gitPaths(serverId) {
      return { ...(state.gitPaths?.[serverId] || {}) };
    },
    saveGitPath: (serverId, processId, gitPath) => transaction(async () => {
      const server = state.servers.find(item => item.id === serverId);
      if (!server) throw new Error('Сервер не найден');
      if (!Number.isSafeInteger(processId) || processId < 0) throw new Error('Некорректный идентификатор процесса');
      const value = String(gitPath || '').trim();
      if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value)) throw new Error('Укажите HTTPS URL репозитория GitHub');
      const gitPaths = { ...(state.gitPaths || {}), [serverId]: { ...(state.gitPaths?.[serverId] || {}), [processId]: value } };
      await persist({ ...state, gitPaths });
      return value;
    }),
    telegram(privateView = false) {
      const { token: secret, offset = 0, ...config } = state.telegram || {};
      return { enabled: false, userIds: [], subscriptions: [], ...config, hasToken: Boolean(secret),
        ...(privateView ? { token: decrypt(secret), offset } : {}) };
    },
    saveTelegram: body => transaction(async () => {
      const old = state.telegram || {};
      const token = String(body.token || '').trim();
      if (token && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('Некорректный токен Telegram');
      const userIds = [...new Set((Array.isArray(body.userIds) ? body.userIds : []).map(String))];
      if (userIds.length > 20 || userIds.some(id => !/^[1-9]\d{0,15}$/.test(id))) throw new Error('Укажите числовые Telegram ID (до 20 пользователей)');
      const subscriptions = body.subscriptions;
      if (!Array.isArray(subscriptions) || subscriptions.length > 200 || subscriptions.some(s => !s ||
        !state.servers.some(server => server.id === s.serverId) || typeof s.name !== 'string' || !s.name || s.name.length > 256 ||
        typeof s.script !== 'string' || s.script.length > 4096)) throw new Error('Некорректный список уведомлений');
      const secret = body.clearToken ? undefined : token ? encrypt(token) : old.token;
      if (body.enabled && !secret) throw new Error('Для включения бота задайте токен Telegram');
      await persist({ ...state, telegram: { enabled: Boolean(body.enabled), token: secret, userIds,
        subscriptions: subscriptions.map(({ serverId, name, script }) => ({ serverId, name, script })),
        offset: token || body.clearToken ? 0 : old.offset || 0 } });
    }),
    telegramOffset: (token, offset) => transaction(async () => {
      if (state.telegram?.token && decrypt(state.telegram.token) === token)
        await persist({ ...state, telegram: { ...state.telegram, offset } });
    }),
    list: () => state.servers.map(publicServer),
    get(id) {
      const server = state.servers.find(s => s.id === id);
      if (!server) throw new Error('Сервер не найден');
      return { ...server, password: server.auth === 'password' ? decrypt(server.secret) : undefined, passphrase: server.auth === 'key' ? decrypt(server.secret) : undefined };
    },
    save: body => transaction(async () => {
      const old = body.id ? state.servers.find(s => s.id === body.id) : undefined;
      if (body.id && !old) throw new Error('Сервер не найден');
      const name = String(body.name || '').trim();
      if (!name || name.length > 80) throw new Error('Укажите имя сервера (до 80 символов)');
      if (!['local', 'ssh'].includes(body.type)) throw new Error('Выберите тип подключения');
      const appRoot = String(body.appRoot || old?.appRoot || '/Projects').trim();
      if (!appRoot || /[\x00\r\n]/.test(appRoot) || (!path.isAbsolute(appRoot) && !path.posix.isAbsolute(appRoot))) throw new Error('Укажите абсолютный путь к папке приложений');
      const next = { id: old?.id || randomUUID(), name, type: body.type, appRoot };
      if (body.type === 'ssh') {
        Object.assign(next, validateAddress(body));
        if (!['password', 'key'].includes(body.auth)) throw new Error('Выберите способ входа SSH');
        next.auth = body.auth;
        next.fingerprint = String(body.fingerprint || '').trim();
        if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(next.fingerprint)) throw new Error('Получите и проверьте отпечаток SSH-сервера');
        next.pm2Path = String(body.pm2Path || 'pm2').trim();
        next.pm2Home = String(body.pm2Home || '').trim();
        if (!/^(?:pm2|\/[\w./@+ -]+)$/.test(next.pm2Path)) throw new Error('PM2: укажите pm2 или абсолютный путь к исполняемому файлу');
        if (next.pm2Home && !path.posix.isAbsolute(next.pm2Home)) throw new Error('PM2_HOME должен быть абсолютным путём');
        if (body.auth === 'key') {
          next.keyPath = String(body.keyPath || '').trim();
          if (!path.isAbsolute(next.keyPath)) throw new Error('Укажите абсолютный путь к SSH-ключу на машине панели');
        }
        const secret = body.auth === 'password' ? body.password : body.passphrase;
        if (secret !== undefined && typeof secret !== 'string') throw new Error('Некорректный пароль');
        next.secret = secret ? encrypt(secret) : (old?.auth === next.auth ? old.secret : undefined);
        if (next.auth === 'password' && !next.secret) throw new Error('Укажите пароль SSH');
      }
      await persist({ ...state, servers: [...state.servers.filter(s => s.id !== next.id), next] });
      return publicServer(next);
    }),
    remove: id => transaction(async () => {
      if (!state.servers.some(s => s.id === id)) throw new Error('Сервер не найден');
      await persist({ ...state, servers: state.servers.filter(s => s.id !== id) });
    })
  };
}

export function validateAddress(body) {
  const host = String(body.host || '').trim();
  const username = String(body.username || '').trim();
  const port = Number(body.port || 22);
  if (!host || host.length > 253 || /[\s/\x00]/.test(host)) throw new Error('Укажите адрес SSH-сервера');
  if (!username || username.length > 64 || /[\s\x00]/.test(username)) throw new Error('Укажите пользователя SSH');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Порт должен быть от 1 до 65535');
  return { host, username, port };
}
