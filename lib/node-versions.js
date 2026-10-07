import { execFile } from 'node:child_process';
import { readdir, realpath, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);

// Shared by Linux local and SSH discovery. Only inspect known installation
// locations for the connected user, without traversing the whole filesystem.
export const discoveryScript = await readFile(new URL('./discover-node.sh', import.meta.url), 'utf8');

export function sortVersions(versions) {
  return versions.sort((a, b) => Number(b.default) - Number(a.default) || b.version.localeCompare(a.version, undefined, { numeric: true }) || a.path.localeCompare(b.path));
}

export function parseNodeVersions(output) {
  const nodes = new Map();
  for (const line of output.split('\n')) {
    const [version, executable, preferred] = line.trimEnd().split('\t');
    if (!/^v\d+\.\d+\.\d+(?:[+-][\w.-]+)?$/.test(version) || !executable?.startsWith('/') || !['0', '1'].includes(preferred)) continue;
    nodes.set(executable, { version, path: executable, default: preferred === '1' });
  }
  return sortVersions([...nodes.values()]);
}

export async function localNodeVersions() {
  if (process.platform !== 'win32') {
    const { stdout } = await exec('bash', ['-c', discoveryScript], { timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, PM2M_EXTRA_NODE: process.execPath } });
    return parseNodeVersions(stdout);
  }
  const candidates = new Set([process.execPath]);
  for (const directory of (process.env.PATH || '').split(path.delimiter)) if (directory) candidates.add(path.join(directory.replace(/^"|"$/g, ''), 'node.exe'));
  const roots = [process.env.NVM_HOME, path.join(os.homedir(), 'AppData', 'Roaming', 'nvm'), path.join(process.env.VOLTA_HOME || path.join(os.homedir(), '.volta'), 'tools', 'image', 'node')].filter(Boolean);
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) if (entry.isDirectory()) candidates.add(path.join(root, entry.name, 'node.exe'));
  }
  const nodes = new Map();
  const current = await realpath(process.execPath);
  await Promise.all([...candidates].map(async candidate => {
    try {
      const executable = await realpath(candidate);
      const { stdout } = await exec(executable, ['--version'], { timeout: 2000, maxBuffer: 4096, windowsHide: true });
      const version = stdout.trim();
      if (/^v\d+\.\d+\.\d+(?:[+-][\w.-]+)?$/.test(version)) nodes.set(executable.toLowerCase(), { version, path: executable, default: executable.toLowerCase() === current.toLowerCase() });
    } catch { /* Missing, inaccessible or broken installations are not selectable. */ }
  }));
  return sortVersions([...nodes.values()]);
}
