import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
const hash = token => createHash('sha256').update(token).digest('hex');

export function memorySessions() {
  const tokens = new Set();
  return {
    async create() { const token = randomBytes(32).toString('hex'); tokens.add(hash(token)); return token; },
    has: token => tokens.has(hash(token)),
    async revoke(token) { tokens.delete(hash(token)); }
  };
}

export async function createSessionStore(directory, password) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'sessions.json');
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state && (state.version !== 1 || !/^[a-f0-9]{64}$/.test(state.salt) || !/^[a-f0-9]{64}$/.test(state.passwordHash) || !Array.isArray(state.tokens) || state.tokens.some(token => !/^[a-f0-9]{64}$/.test(token)))) throw new Error('Некорректный файл сессий');
  const salt = state?.salt || randomBytes(32).toString('hex');
  const passwordHash = scryptSync(password, salt, 32).toString('hex');
  if (!state || !timingSafeEqual(Buffer.from(state.passwordHash, 'hex'), Buffer.from(passwordHash, 'hex'))) state = { version: 1, salt, passwordHash, tokens: [] };
  const persist = async next => {
    await writeFile(file + '.tmp', JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    await rename(file + '.tmp', file);
    state = next;
  };
  await persist(state);
  let queue = Promise.resolve();
  const transaction = action => { const pending = queue.then(action); queue = pending.catch(() => {}); return pending; };
  return {
    create: () => transaction(async () => {
      const token = randomBytes(32).toString('hex');
      await persist({ ...state, tokens: [...state.tokens, hash(token)] });
      return token;
    }),
    has: token => state.tokens.includes(hash(token)),
    revoke: token => transaction(() => persist({ ...state, tokens: state.tokens.filter(value => value !== hash(token)) }))
  };
}
