import { createHash } from 'node:crypto';
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside, UnsafePathError } from './paths.js';
import type { SourceFingerprint } from './types.js';

const DEFAULT_EDGE_BYTES = 4 * 1024 * 1024;

export async function fingerprintSource(
  archiveRoot: string,
  sourcePath: string,
  edgeBytes = DEFAULT_EDGE_BYTES,
): Promise<SourceFingerprint> {
  if (!Number.isSafeInteger(edgeBytes) || edgeBytes < 1 || edgeBytes > 64 * 1024 * 1024) {
    throw new RangeError('edgeBytes must be between 1 byte and 64 MiB');
  }
  const [root, source] = await Promise.all([realpath(archiveRoot), realpath(sourcePath)]);
  if (!isPathInside(root, source)) throw new UnsafePathError('Source is outside the archive root');

  const before = await stat(source, { bigint: true });
  if (!before.isFile()) throw new UnsafePathError('Source is not a regular file');
  const size = before.size;
  const chunkSize = Number(size < BigInt(edgeBytes) ? size : BigInt(edgeBytes));
  const first = Buffer.alloc(chunkSize);
  const last = Buffer.alloc(chunkSize);
  const file = await open(source, 'r');
  try {
    await file.read(first, 0, chunkSize, 0);
    const lastOffset = size > BigInt(chunkSize) ? size - BigInt(chunkSize) : 0n;
    await file.read(last, 0, chunkSize, lastOffset);
  } finally {
    await file.close();
  }

  const after = await stat(source, { bigint: true });
  if (after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
    throw new Error('Source changed while it was being fingerprinted');
  }
  const relativePath = path.relative(root, source).split(path.sep).join('/');
  const hash = createHash('sha256');
  hash.update('easy-stream-source-fingerprint-v1\0');
  hash.update(relativePath);
  hash.update('\0');
  hash.update(size.toString());
  hash.update('\0');
  hash.update(before.mtimeNs.toString());
  hash.update('\0');
  hash.update(first);
  hash.update('\0');
  hash.update(last);

  return {
    version: 1,
    algorithm: 'sha256',
    relativePath,
    size: size.toString(),
    mtimeNs: before.mtimeNs.toString(),
    edgeBytes: chunkSize,
    digest: hash.digest('hex'),
  };
}
