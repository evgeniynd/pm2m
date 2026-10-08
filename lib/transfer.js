import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { execute, quote } from './ssh.js';

const openSftp = async config => {
  const privateKey = config.auth === 'key' ? await readFile(config.keyPath) : undefined;
  const client = new ssh2.Client();
  await new Promise((resolve, reject) => client.once('ready', resolve).once('error', reject).connect({ ...config, privateKey, hostVerifier: key => !config.fingerprint || ('SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '') === config.fingerprint) }));
  const sftp = await new Promise((resolve, reject) => client.sftp((error, value) => error ? reject(error) : resolve(value)));
  return { client, sftp };
};
const transferFile = (sftp, method, source, destination) => new Promise((resolve, reject) => sftp[method](source, destination, error => error ? reject(error) : resolve()));

export async function transferSshApplication(source, target, process, targetRoot = '/Projects') {
  if (source.type !== 'ssh' || target.type !== 'ssh') throw new Error('Перенос сейчас доступен между SSH-серверами');
  const sourceDir = process.script && process.cwd && !process.script.startsWith(`${process.cwd.replace(/\/$/, '')}/`)
    ? path.posix.dirname(process.script)
    : process.cwd || path.posix.dirname(process.script);
  const targetDir = path.posix.join(targetRoot, process.name);
  const archive = `/tmp/pm2m-transfer-${randomUUID()}.tgz`;
  const localDir = await mkdtemp(path.join(os.tmpdir(), 'pm2m-transfer-'));
  const localArchive = path.join(localDir, 'application.tgz');
  let sourceSftp, targetSftp;
  try {
    await execute(source, `tar -czf ${quote(archive)} -C ${quote(path.posix.dirname(sourceDir))} ${quote(path.posix.basename(sourceDir))}`);
    sourceSftp = await openSftp(source); await transferFile(sourceSftp.sftp, 'fastGet', archive, localArchive);
    targetSftp = await openSftp(target); const remoteArchive = `/tmp/pm2m-transfer-${randomUUID()}.tgz`;
    await transferFile(targetSftp.sftp, 'fastPut', localArchive, remoteArchive);
    await execute(target, `mkdir -p ${quote(targetDir)} && tar -xzf ${quote(remoteArchive)} -C ${quote(targetDir)} --strip-components=1 && rm -f ${quote(remoteArchive)}`);
    return { cwd: targetDir, script: path.posix.join(targetDir, path.posix.relative(sourceDir, process.script)) };
  } finally {
    try { await execute(source, `rm -f ${quote(archive)}`); } catch {}
    sourceSftp?.client.end(); targetSftp?.client.end(); await rm(localDir, { recursive: true, force: true });
  }
}
