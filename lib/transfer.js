import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
const execFileAsync = promisify(execFile);
const localTar = (args, options = {}) => execFileAsync(process.platform === 'win32' ? 'tar.exe' : 'tar', args, { ...options, maxBuffer: 1024 * 1024 * 2 });

export async function transferSshApplication(source, target, process, targetRoot = '/Projects') {
  const sourcePath = source.type === 'ssh' ? path.posix : path;
  const sourceDir = process.script && process.cwd && !process.script.startsWith(`${process.cwd.replace(/[\\/]+$/, '')}${source.type === 'ssh' ? '/' : path.sep}`)
    ? sourcePath.dirname(process.script)
    : process.cwd || sourcePath.dirname(process.script);
  const targetPath = target.type === 'ssh' ? path.posix : path;
  const targetDir = targetPath.join(targetRoot, process.name);
  const archive = `/tmp/pm2m-transfer-${randomUUID()}.tgz`;
  const localDir = await mkdtemp(path.join(os.tmpdir(), 'pm2m-transfer-'));
  const localArchive = path.join(localDir, 'application.tgz');
  let sourceSftp, targetSftp;
  try {
    if (source.type === 'ssh') {
      await execute(source, `tar -czf ${quote(archive)} --dereference -C ${quote(path.posix.dirname(sourceDir))} ${quote(path.posix.basename(sourceDir))}`);
      sourceSftp = await openSftp(source); await transferFile(sourceSftp.sftp, 'fastGet', archive, localArchive);
    } else {
      await localTar(['-czf', localArchive, '--dereference', '-C', path.dirname(sourceDir), path.basename(sourceDir)]);
    }
    if (target.type === 'ssh') {
      targetSftp = await openSftp(target); const remoteArchive = `/tmp/pm2m-transfer-${randomUUID()}.tgz`;
      await transferFile(targetSftp.sftp, 'fastPut', localArchive, remoteArchive);
      await execute(target, `mkdir -p ${quote(targetDir)} && tar -xzf ${quote(remoteArchive)} -C ${quote(targetDir)} --strip-components=1 && rm -f ${quote(remoteArchive)}`);
    } else {
      await mkdir(targetDir, { recursive: true });
      await localTar(['-xzf', localArchive, '-C', targetDir, '--strip-components=1']);
    }
    const relativeScript = sourcePath.relative(sourceDir, process.script).split(path.sep).join('/');
    return { cwd: targetDir, script: targetPath.join(targetDir, relativeScript) };
  } finally {
    if (source.type === 'ssh') { try { await execute(source, `rm -f ${quote(archive)}`); } catch {} }
    sourceSftp?.client.end(); targetSftp?.client.end(); await rm(localDir, { recursive: true, force: true });
  }
}
