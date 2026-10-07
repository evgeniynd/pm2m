// Kept compatible with Node 10: this function also runs on SSH hosts using their Node.
// One bounded read per distinct file; shared cluster logs must not produce duplicates.
export function readErrorFiles(fs, crypto, files, cursors) {
  return files.map(function (entry) {
    const file = entry.file, previous = cursors[file];
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const info = fs.fstatSync(fd);
      if (!info.isFile()) throw new Error('Not a regular file');
      const signature = String(info.dev) + ':' + String(info.ino);
      const anchor = function (offset) {
        const start = Math.max(0, offset - 128), buffer = Buffer.alloc(offset - start);
        const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
        return crypto.createHash('sha256').update(buffer.slice(0, bytes)).digest('hex');
      };
      let offset = info.size;
      if (previous) {
        offset = previous.offset || 0;
        if (previous.signature !== signature || info.size < offset || previous.anchor !== anchor(offset)) offset = 0;
      }
      const start = Math.max(offset, info.size - 65536);
      const buffer = Buffer.alloc(info.size - start);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.slice(0, bytes).toString('utf8');
      const truncated = start > offset;
      if (truncated && text.includes('\n')) text = text.slice(text.indexOf('\n') + 1);
      const end = start + bytes;
      return { file, ids: entry.ids, stream: entry.stream || 'stderr', text, truncated, cursor: { signature, offset: end, anchor: anchor(end) } };
    } catch (error) {
      if (error.code === 'ENOENT') return { file, ids: entry.ids, text: '', cursor: { offset: 0, signature: 'missing' } };
      return { file, ids: entry.ids, error: 'Не удалось прочитать лог приложения' };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  });
}

export function errorFiles(processes, ids) {
  const files = new Map();
  for (const p of processes) {
    const file = p.pm2_env?.pm_err_log_path;
    if (!ids.includes(p.pm_id) || !file) continue;
    if (!files.has(file)) files.set(file, { file, ids: [], stream: 'stderr' });
    files.get(file).ids.push(p.pm_id);
  }
  return [...files.values()];
}
