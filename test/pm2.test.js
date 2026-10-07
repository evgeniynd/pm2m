import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('isolated real PM2 daemon: create, stop, restart, logs, save, delete', { timeout: 35000 }, async () => {
  // PM2's Windows client retains a reconnect handle after killDaemon; isolate it
  // so its teardown cannot keep the test runner alive or affect another daemon.
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/verify-pm2.js', import.meta.url))], { timeout: 30000, windowsHide: true });
  assert.match(stdout, /PM2 verification passed/);
});
