import { randomUUID } from 'node:crypto';
import { lstat, opendir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertWritableDestination, assertWritableRoot, isPathInside, UnsafePathError } from './paths.js';

const METADATA = '.cache-entry.json';
let lifecycleTail: Promise<void> = Promise.resolve();

async function serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const previous = lifecycleTail;
  let release!: () => void;
  lifecycleTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export interface CacheEntryMetadata {
  version: 1;
  key: string;
  bytes: number;
  lastAccessedAt: string;
  /** Do not evict before the latest playback grant expires. */
  protectedUntil?: string;
  active: boolean;
  building: boolean;
  pinned: boolean;
}

async function readCacheMetadata(directory: string): Promise<CacheEntryMetadata> {
  const destination = path.join(directory, METADATA);
  const details = await lstat(destination);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new UnsafePathError(`Cache metadata is not a regular file: ${destination}`);
  }
  return JSON.parse(await readFile(destination, 'utf8')) as CacheEntryMetadata;
}

async function assertSafeDeletion(root: string, directory: string): Promise<void> {
  await assertWritableRoot(root);
  await assertWritableDestination(root, directory);
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new UnsafePathError(`Cache deletion target is not a regular directory: ${directory}`);
  }
  const [canonicalRoot, canonicalDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  if (!isPathInside(canonicalRoot, canonicalDirectory) || canonicalDirectory === canonicalRoot) {
    throw new UnsafePathError(`Refusing unsafe cache deletion: ${directory}`);
  }
}

async function directorySize(directory: string): Promise<number> {
  let total = 0;
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const candidate = path.join(directory, entry.name);
    const details = await lstat(candidate);
    if (details.isSymbolicLink()) throw new Error(`Symlink found in media cache: ${candidate}`);
    if (details.isDirectory()) total += await directorySize(candidate);
    // Generation-local font hardlinks do not consume additional blocks while the global
    // content-addressed store owns another link. Cross-device copy fallbacks have nlink=1.
    else if (details.isFile()) total += details.nlink > 1 ? 0 : details.size;
  }
  return total;
}

export async function writeCacheMetadata(
  cacheRoot: string,
  entryDirectory: string,
  metadata: Omit<CacheEntryMetadata, 'version' | 'bytes'> & { bytes?: number },
): Promise<CacheEntryMetadata> {
  const directory = await assertWritableDestination(cacheRoot, entryDirectory);
  const details = await stat(directory);
  if (!details.isDirectory()) throw new Error('Cache entry is not a directory');
  const value: CacheEntryMetadata = {
    version: 1,
    ...metadata,
    bytes: metadata.bytes ?? await directorySize(directory),
  };
  const destination = path.join(directory, METADATA);
  try {
    const existing = await lstat(destination);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new UnsafePathError(`Cache metadata is not a regular file: ${destination}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640, flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return value;
}

export async function touchCacheEntry(cacheRoot: string, entryDirectory: string): Promise<void> {
  const directory = await assertWritableDestination(cacheRoot, entryDirectory);
  const value = await readCacheMetadata(directory);
  await writeCacheMetadata(cacheRoot, directory, { ...value, lastAccessedAt: new Date().toISOString() });
}

export interface CacheTouchOptions {
  accessedAt?: string;
  protectedUntil?: string;
}

/** Updates one cache generation without allowing a caller-controlled filesystem path. */
export async function touchCacheGeneration(
  cacheRoot: string,
  generation: string,
  options: CacheTouchOptions = {},
): Promise<boolean> {
  return await serializeLifecycle(async () => await touchCacheGenerationUnlocked(cacheRoot, generation, options));
}

async function touchCacheGenerationUnlocked(
  cacheRoot: string,
  generation: string,
  options: CacheTouchOptions,
): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9._-]{7,127}$/u.test(generation)) throw new Error('Invalid generation identifier');
  const accessedAt = options.accessedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(accessedAt))) throw new Error('Invalid cache access timestamp');
  if (options.protectedUntil !== undefined && !Number.isFinite(Date.parse(options.protectedUntil))) {
    throw new Error('Invalid cache protection timestamp');
  }
  await assertWritableRoot(cacheRoot);
  const generationsRoot = path.join(path.resolve(cacheRoot), 'generations');
  const directory = await assertWritableDestination(generationsRoot, path.join(generationsRoot, generation));
  let value: CacheEntryMetadata;
  try {
    const details = await lstat(directory);
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error('Cache generation is not a regular directory');
    value = await readCacheMetadata(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (value.version !== 1 || value.key !== generation) throw new Error('Cache generation metadata does not match request');
  const existingAccess = Date.parse(value.lastAccessedAt);
  const requestedAccess = Date.parse(accessedAt);
  const existingProtection = Date.parse(value.protectedUntil ?? '');
  const requestedProtection = Date.parse(options.protectedUntil ?? '');
  await writeCacheMetadata(generationsRoot, directory, {
    ...value,
    lastAccessedAt: new Date(Math.max(
      Number.isFinite(existingAccess) ? existingAccess : 0,
      requestedAccess,
    )).toISOString(),
    ...(Number.isFinite(existingProtection) || Number.isFinite(requestedProtection)
      ? {
          protectedUntil: new Date(Math.max(
            Number.isFinite(existingProtection) ? existingProtection : 0,
            Number.isFinite(requestedProtection) ? requestedProtection : 0,
          )).toISOString(),
        }
      : {}),
  });
  return true;
}

export interface EvictionOptions {
  capacityBytes: number;
  highWatermark?: number;
  lowWatermark?: number;
  protectedKeys?: ReadonlySet<string>;
  /** Bytes owned by the cache but stored outside the per-generation directories. */
  overheadBytes?: number;
  now?: Date;
  /** Grace window for newly built/touched entries while access events propagate. */
  minimumRetentionMs?: number;
  dryRun?: boolean;
}

export interface EvictionResult {
  beforeBytes: number;
  afterBytes: number;
  evicted: string[];
}

export async function evictCacheGeneration(cacheRoot: string, generation: string): Promise<boolean> {
  return await serializeLifecycle(async () => await evictCacheGenerationUnlocked(cacheRoot, generation));
}

async function evictCacheGenerationUnlocked(cacheRoot: string, generation: string): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9._-]{7,127}$/u.test(generation)) throw new Error('Invalid generation identifier');
  await assertWritableRoot(cacheRoot);
  const generationsRoot = path.join(path.resolve(cacheRoot), 'generations');
  const directory = await assertWritableDestination(generationsRoot, path.join(generationsRoot, generation));
  let metadata: CacheEntryMetadata;
  try {
    const details = await lstat(directory);
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error('Cache generation is not a regular directory');
    metadata = await readCacheMetadata(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (metadata.version !== 1 || metadata.key !== generation) throw new Error('Cache generation metadata does not match request');
  if (metadata.active || metadata.building) throw new Error(`Cache generation is active: ${generation}`);
  if (metadata.pinned) throw new Error(`Cache generation is pinned: ${generation}`);
  if (isTimeProtected(metadata, Date.now())) throw new Error(`Cache generation has an active playback lease: ${generation}`);
  await assertSafeDeletion(generationsRoot, directory);
  await rm(directory, { recursive: true, force: false });
  return true;
}

export async function evictCache(cacheRoot: string, options: EvictionOptions): Promise<EvictionResult> {
  return await serializeLifecycle(async () => await evictCacheUnlocked(cacheRoot, options));
}

async function evictCacheUnlocked(cacheRoot: string, options: EvictionOptions): Promise<EvictionResult> {
  const root = path.resolve(cacheRoot);
  const high = options.highWatermark ?? 0.85;
  const low = options.lowWatermark ?? 0.75;
  if (!(options.capacityBytes > 0) || !(low >= 0 && low < high && high <= 1)) {
    throw new RangeError('Invalid cache capacity or watermarks');
  }
  const entries: Array<{ directory: string; metadata: CacheEntryMetadata }> = [];
  const overheadBytes = options.overheadBytes ?? 0;
  if (!Number.isFinite(overheadBytes) || overheadBytes < 0) throw new RangeError('Invalid cache overhead');
  const minimumRetentionMs = options.minimumRetentionMs ?? 0;
  if (!Number.isFinite(minimumRetentionMs) || minimumRetentionMs < 0) {
    throw new RangeError('Invalid cache retention window');
  }
  const now = (options.now ?? new Date()).getTime();
  let beforeBytes = overheadBytes;
  await assertWritableRoot(root);
  try {
    await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { beforeBytes, afterBytes: beforeBytes, evicted: [] };
    }
    throw error;
  }
  const handle = await opendir(root);
  for await (const entry of handle) {
    if (entry.isSymbolicLink()) throw new UnsafePathError(`Symlink found in cache generations: ${path.join(root, entry.name)}`);
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    try {
      const metadata = await readCacheMetadata(directory);
      if (metadata.version !== 1 || metadata.key !== entry.name
        || !Number.isFinite(metadata.bytes) || metadata.bytes < 0
        || !Number.isFinite(Date.parse(metadata.lastAccessedAt))) continue;
      entries.push({ directory, metadata });
      beforeBytes += metadata.bytes;
    } catch (error) {
      if (error instanceof UnsafePathError) throw error;
      // Incomplete/unmanaged directories are never deleted by the LRU.
    }
  }
  if (beforeBytes <= options.capacityBytes * high) return { beforeBytes, afterBytes: beforeBytes, evicted: [] };
  entries.sort((left, right) => Date.parse(left.metadata.lastAccessedAt) - Date.parse(right.metadata.lastAccessedAt));
  const target = options.capacityBytes * low;
  let afterBytes = beforeBytes;
  const evicted: string[] = [];
  for (const entry of entries) {
    if (afterBytes <= target) break;
    const protectedEntry = entry.metadata.active || entry.metadata.building || entry.metadata.pinned
      || isTimeProtected(entry.metadata, now)
      || Date.parse(entry.metadata.lastAccessedAt) > now - minimumRetentionMs
      || options.protectedKeys?.has(entry.metadata.key) === true;
    if (protectedEntry) continue;
    await assertSafeDeletion(root, entry.directory);
    if (options.dryRun !== true) await rm(entry.directory, { recursive: true, force: false });
    afterBytes -= entry.metadata.bytes;
    evicted.push(entry.metadata.key);
  }
  return { beforeBytes, afterBytes, evicted };
}

function isTimeProtected(metadata: CacheEntryMetadata, now: number): boolean {
  if (metadata.protectedUntil === undefined) return false;
  const protectedUntil = Date.parse(metadata.protectedUntil);
  // Corrupt protection metadata fails closed: an operator can inspect/fix it rather than
  // evicting files that might still be in use.
  return !Number.isFinite(protectedUntil) || protectedUntil > now;
}
