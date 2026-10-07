import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { localNodeVersions, parseNodeVersions } from '../lib/node-versions.js';
import { validateStart } from '../lib/manager.js';

test('node discovery parses versions, deduplicates binaries and prefers the default', () => {
  const versions = parseNodeVersions('login banner\nv20.1.0\t/opt/node20/bin/node\t0\nv10.13.0\t/opt/node10/bin/node\t1\nv22.2.0\t/opt/node22/bin/node\t0\nv20.1.0\t/opt/node20/bin/node\t0\nnot-node\t/bin/bash\t0\n');
  assert.equal(versions.length, 3);
  assert.deepEqual(versions.map(n => n.version), ['v10.13.0', 'v22.2.0', 'v20.1.0']);
});

test('local discovery finds a runnable installed Node.js', async () => {
  const versions = await localNodeVersions();
  assert.ok(versions.some(n => n.version === process.version));
  assert.ok(versions.every(n => path.isAbsolute(n.path)));
});

test('SSH start validates POSIX interpreter paths independently of the panel OS', () => {
  const config = validateStart({ name: 'test', script: '/srv/app.js', interpreter: '/opt/node/bin/node' }, path.posix);
  assert.equal(config.cwd, '/srv'); assert.equal(config.interpreter, '/opt/node/bin/node');
  for (const interpreter of ['node', '', 'C:\\node.exe', '/opt/node\n']) {
    assert.throws(() => validateStart({ name: 'test', script: '/srv/app.js', interpreter }, path.posix), /Node.js/);
  }
});
