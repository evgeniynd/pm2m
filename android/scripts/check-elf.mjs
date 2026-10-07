// Checks the native libraries produced by Gradle. Run with Node.js from project root.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.argv[2] || 'android/app/build/intermediates/merged_native_libs/release/mergeReleaseNativeLibs/out/lib';
let failed = false;
for (const abi of await readdir(root)) for (const name of await readdir(path.join(root, abi))) {
  if (!name.endsWith('.so')) continue;
  const b = await readFile(path.join(root, abi, name));
  if (b.toString('ascii', 1, 4) !== 'ELF' || b[5] !== 1) throw new Error('Unsupported ELF format');
  const is64 = b[4] === 2, offset = is64 ? Number(b.readBigUInt64LE(32)) : b.readUInt32LE(28);
  const size = b.readUInt16LE(is64 ? 54 : 42), count = b.readUInt16LE(is64 ? 56 : 44);
  const alignments = [];
  for (let i = 0; i < count; i++) {
    const p = offset + i * size;
    if (b.readUInt32LE(p) === 1) alignments.push(is64 ? Number(b.readBigUInt64LE(p + 48)) : b.readUInt32LE(p + 28));
  }
  const ok = alignments.length > 0 && alignments.every(a => a >= 16384);
  console.log(`${abi}/${name}: PT_LOAD alignment ${alignments.join(', ')} ${ok ? 'OK' : 'FAIL'}`);
  failed ||= !ok;
}
if (failed) process.exitCode = 1;
