import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const directory = await mkdtemp(path.join(os.tmpdir(), 'pm2m-daemon-test-'));
process.env.PM2_HOME = path.join(directory, '.pm2');
const { default: pm2 } = await import('pm2');
let exitCode = 0;
try {
  const { createManager } = await import('../lib/manager.js');
  const manager = await createManager();
  const script = path.join(directory, 'worker.cjs');
  await writeFile(script, "console.log('pm2m test ready', process.execPath); setInterval(() => {}, 1000);\n");
  const versions = await manager.nodeVersions();
  const interpreter = versions.find(n => n.version === process.version).path;
  await manager.start({ name: 'pm2m-test-worker', script, cwd: directory, interpreter });
  const [p] = await manager.list(); assert.equal(p.name, 'pm2m-test-worker'); assert.equal(p.status, 'online');
  assert.equal(p.interpreter, interpreter);
  let logs;
  for (let i = 0; i < 40; i++) { logs = await manager.logs(p.id); if (logs.stdout.includes('pm2m test ready')) break; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.match(logs.stdout, /pm2m test ready/);
  assert.ok(logs.stdout.includes(interpreter));
  await manager.action(p.id, 'stop'); assert.equal((await manager.list())[0].status, 'stopped');
  await manager.action(p.id, 'start'); assert.equal((await manager.list())[0].status, 'online');
  await manager.action(p.id, 'restart');
  await manager.save(); assert.match(await readFile(path.join(directory, '.pm2', 'dump.pm2'), 'utf8'), /pm2m-test-worker/);
  await manager.action(p.id, 'delete'); assert.equal((await manager.list()).length, 0);
  // Exercise the real entrypoint through PM2's container using a disposable copy.
  const panelDirectory = path.join(directory, 'panel');
  await mkdir(panelDirectory);
  await cp(new URL('../server.js', import.meta.url), path.join(panelDirectory, 'server.js'));
  await cp(new URL('../lib/', import.meta.url), path.join(panelDirectory, 'lib'), { recursive: true });
  await writeFile(path.join(panelDirectory, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(panelDirectory, '.env'), 'ADMIN_PASSWORD=abc\nHOST=127.0.0.1\nPORT=0\n');
  await manager.start({ name: 'pm2m-panel-entry-test', script: path.join(panelDirectory, 'server.js'), cwd: directory, interpreter });
  const panel = (await manager.list()).find(item => item.name === 'pm2m-panel-entry-test');
  let address;
  for (let i = 0; i < 60; i++) {
    const output = await manager.logs(panel.id);
    address = output.stdout.match(/PM2M: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (address) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(address, 'PM2 entrypoint must actually start the HTTP listener');
  const response = await fetch(address + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PM2M-Request': '1' }, body: '{"password":"abc"}' });
  assert.equal(response.status, 200, 'The project .env must be loaded when PM2 starts server.js');
  await manager.action(panel.id, 'delete');
  console.log('PM2 verification passed');
} catch (error) { console.error(error); exitCode = 1; }
finally {
  await new Promise(resolve => pm2.killDaemon(() => resolve()));
  await new Promise(resolve => pm2.disconnect(() => resolve()));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
process.exit(exitCode);
