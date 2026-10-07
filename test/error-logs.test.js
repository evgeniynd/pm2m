import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readErrorFiles, errorFiles } from '../lib/error-logs.js';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pm2m-errorlog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'stderr.log');
  const read = cursor => readErrorFiles(fs, crypto, [{ file, ids: [1] }], cursor ? { [file]: cursor } : {})[0];
  return { file, read };
}
test('stderr baseline skips history; appending identical UTF-8 errors sends each new occurrence', async t => {
  const { file, read } = await fixture(t);
  await writeFile(file, 'Старая ошибка\n');
  let result = read(); assert.equal(result.text, '');
  for (let i = 0; i < 2; i++) {
    await appendFile(file, 'Ошибка подключения\n'); result = read(result.cursor);
    assert.equal(result.text, 'Ошибка подключения\n');
    assert.equal(read(result.cursor).text, '');
  }
});
test('stderr rotation, truncation and truncate/regrow are detected', async t => {
  const { file, read } = await fixture(t);
  await writeFile(file, 'old data\n'); let result = read();
  await rename(file, file + '.old'); await writeFile(file, 'rotated\n');
  result = read(result.cursor); assert.equal(result.text, 'rotated\n');
  await writeFile(file, 'x\n'); result = read(result.cursor); assert.equal(result.text, 'x\n');
  await writeFile(file, 'new long error after truncation\n'); result = read(result.cursor);
  assert.equal(result.text, 'new long error after truncation\n');
});
test('newly created logs are read and bursts are bounded', async t => {
  const { file, read } = await fixture(t);
  let result = read(); assert.equal(result.text, '');
  await writeFile(file, 'first error\n'); result = read(result.cursor); assert.equal(result.text, 'first error\n');
  await appendFile(file, 'error line\n'.repeat(10000)); result = read(result.cursor);
  assert.equal(result.truncated, true); assert.ok(result.text.length <= 65536);
  assert.equal(read(result.cursor).text, '');
});
test('shared cluster error files are read once and unselected files are excluded', () => {
  const raw = [1, 2, 3].map(id => ({ pm_id: id, pm2_env: { pm_err_log_path: id === 3 ? '/other' : '/shared', pm_out_log_path: '/stdout' } }));
  assert.deepEqual(errorFiles(raw, [1, 2]), [{ file: '/shared', ids: [1, 2], stream: 'stderr' }]);
});
