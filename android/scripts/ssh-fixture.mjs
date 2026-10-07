// Disposable loopback SSH fixture. Requires the parent project's npm dependencies.
import { generateKeyPairSync } from 'node:crypto';
import ssh2 from '../../node_modules/ssh2/lib/index.js';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
  client.on('error', () => {});
  client.on('authentication', ctx => {
    if (ctx.method === 'password' && ctx.username === 'demo' && ctx.password === 'fixture-only') ctx.accept(); else ctx.reject(['password']);
  });
  client.on('ready', () => client.on('session', accept => {
    accept().on('exec', (accept, reject, info) => {
      const stream = accept();
      if (info.command === 'fixture-hello') stream.write('SSH работает\n');
      else if (info.command.includes('jlist')) stream.write(JSON.stringify([{ pm_id: 1, name: 'api', pm2_env: { status: 'online', pm_exec_path: '/srv/api.js' } }]));
      else { stream.stderr.write('Unknown fixture command'); stream.exit(1); stream.end(); return; }
      stream.exit(0); stream.end();
    });
  }));
});
server.listen(0, '127.0.0.1', () => console.log('PM2M_SSH_TEST_PORT=' + server.address().port));
