import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from 'ssh2';
const { Server } = ssh2;
import { execute, probeHost } from '../lib/ssh.js';

test('real SSH transport: host fingerprint, password auth, output, errors, host-key rejection', { timeout: 20000 }, async t => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const connections = new Set(); let authenticated = 0;
  const server = new Server({ hostKeys: [privateKey] }, client => {
    connections.add(client);
    client.on('error', () => {}); client.on('close', () => connections.delete(client));
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'deploy' && ctx.password === 'test-password') { authenticated++; ctx.accept(); } else ctx.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (accept, reject, info) => {
        const stream = accept();
        if (info.command === 'fail') { stream.stderr.write('command failed'); stream.exit(1); }
        else { stream.write('hello over ssh'); stream.exit(0); }
        stream.end();
      });
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { for (const connection of connections) connection.end(); server.close(resolve); }));
  const base = { host: '127.0.0.1', port: server.address().port, username: 'deploy', auth: 'password', password: 'test-password' };
  const { fingerprint } = await probeHost(base); assert.match(fingerprint, /^SHA256:/); assert.equal(authenticated, 0);
  assert.equal(await execute({ ...base, fingerprint }, 'ok'), 'hello over ssh'); assert.equal(authenticated, 1);
  await assert.rejects(execute({ ...base, fingerprint }, 'fail'), /command failed/);
  const before = authenticated;
  await assert.rejects(execute({ ...base, fingerprint: 'SHA256:wrong' }, 'ok'), /Отпечаток SSH изменился/);
  assert.equal(authenticated, before);
  await assert.rejects(execute({ ...base, fingerprint, password: 'bad-password' }, 'ok'), /authentication methods failed/);
});
