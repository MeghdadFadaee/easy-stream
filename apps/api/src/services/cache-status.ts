import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import path from 'node:path';
import type { CacheStatus } from '@easy-stream/contracts';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const CACHE_METADATA = '.cache-entry.json';
const MAX_METADATA_BYTES = 64 * 1024;
const CacheEntryMetadataSchema = Type.Object(
  {
    version: Type.Literal(1),
    key: Type.String({ minLength: 8, maxLength: 128, pattern: '^[a-z0-9][a-z0-9._-]+$' }),
    bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    lastAccessedAt: Type.String({ minLength: 1, maxLength: 64 }),
    protectedUntil: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    active: Type.Boolean(),
    building: Type.Boolean(),
    pinned: Type.Boolean(),
  },
  { additionalProperties: false },
);

interface CacheEntryMetadata {
  version: 1;
  key: string;
  bytes: number;
  lastAccessedAt: string;
  protectedUntil?: string;
  active: boolean;
  building: boolean;
  pinned: boolean;
}

export interface CacheStatusService {
  getStatus(): Promise<CacheStatus>;
}

export interface FilesystemCacheStatusOptions {
  cacheRoot: string;
  maxBytes: number;
  highWatermark: number;
  lowWatermark: number;
}

/** Reads the worker-owned cache projection without mutating or walking media payloads. */
export class FilesystemCacheStatusService implements CacheStatusService {
  private readonly root: string;

  constructor(private readonly options: FilesystemCacheStatusOptions) {
    this.root = path.resolve(options.cacheRoot);
  }

  async getStatus(): Promise<CacheStatus> {
    if (!(await managedDirectoryExists(this.root, 'cache root'))) return this.result(0, 0);
    const generations = await readGenerations(path.join(this.root, 'generations'));
    const fontStore = path.join(this.root, 'assets', 'fonts', 'sha256');
    const fontBytes = await managedSubdirectoryExists(
      this.root,
      ['assets', 'fonts', 'sha256'],
      'global font store',
    ) ? await readFontStoreBytes(fontStore) : 0;
    return this.result(
      safeAdd(generations.bytes, fontBytes, 'cache usage'),
      generations.building,
    );
  }

  private result(usedBytes: number, activePackages: number): CacheStatus {
    return {
      usedBytes,
      maxBytes: this.options.maxBytes,
      highWatermark: this.options.highWatermark,
      lowWatermark: this.options.lowWatermark,
      activePackages,
    };
  }
}

async function readGenerations(
  directory: string,
): Promise<{ bytes: number; building: number }> {
  if (!(await managedDirectoryExists(directory, 'cache generations root'))) {
    return { bytes: 0, building: 0 };
  }
  let bytes = 0;
  let building = 0;
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink found in cache generations: ${candidate}`);
    if (!entry.isDirectory()) continue;
    let metadata: CacheEntryMetadata | undefined;
    try {
      metadata = await readCacheMetadata(path.join(candidate, CACHE_METADATA), entry.name);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (metadata === undefined) continue;
    bytes = safeAdd(bytes, metadata.bytes, 'generation cache usage');
    if (metadata.building) building += 1;
  }
  return { bytes, building };
}

async function readCacheMetadata(
  metadataPath: string,
  expectedKey: string,
): Promise<CacheEntryMetadata | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(metadataPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return undefined;
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error(`Symlink found at cache metadata: ${metadataPath}`);
    }
    throw error;
  }
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_METADATA_BYTES) {
      throw new Error(`Cache metadata is not a bounded regular file: ${metadataPath}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await handle.readFile('utf8'));
    } catch (error) {
      throw new Error(`Invalid cache metadata JSON: ${metadataPath}`, { cause: error });
    }
    if (!Value.Check(CacheEntryMetadataSchema, parsed)) {
      throw new Error(`Invalid cache metadata shape: ${metadataPath}`);
    }
    const metadata = parsed as CacheEntryMetadata;
    const archivedGeneration = expectedKey.match(
      /^failed-[0-9]{10,16}-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u,
    )?.[1];
    if (
      (metadata.key !== expectedKey && metadata.key !== archivedGeneration)
      || !Number.isFinite(Date.parse(metadata.lastAccessedAt))
    ) {
      throw new Error(`Cache metadata does not match its generation: ${metadataPath}`);
    }
    if (
      metadata.protectedUntil !== undefined
      && !Number.isFinite(Date.parse(metadata.protectedUntil))
    ) {
      throw new Error(`Cache metadata has an invalid protection timestamp: ${metadataPath}`);
    }
    // If packaging could not rewrite metadata after archiving a failed build, its original
    // UUID key/building flag can remain. The exact archive name relationship makes this safe
    // to count as diagnostic disk usage without reporting a live build forever.
    return archivedGeneration === undefined ? metadata : { ...metadata, building: false };
  } finally {
    await handle.close();
  }
}

async function readFontStoreBytes(directory: string): Promise<number> {
  let bytes = 0;
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink found in global font store: ${candidate}`);
    if (!entry.isFile()) {
      throw new Error(`Non-regular entry found in global font store: ${candidate}`);
    }
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      // Font pruning can remove an entry after opendir returned it.
      if (isMissing(error)) continue;
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new Error(`Symlink found in global font store: ${candidate}`);
      }
      throw error;
    }
    try {
      const details = await file.stat();
      if (!details.isFile()) throw new Error(`Non-regular entry found in global font store: ${candidate}`);
      bytes = safeAdd(bytes, details.size, 'global font cache usage');
    } finally {
      await file.close();
    }
  }
  return bytes;
}

async function managedSubdirectoryExists(
  root: string,
  components: readonly string[],
  label: string,
): Promise<boolean> {
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    if (!(await managedDirectoryExists(current, label))) return false;
  }
  return true;
}

async function managedDirectoryExists(directory: string, label: string): Promise<boolean> {
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(directory);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error(`Managed ${label} is not a regular directory: ${directory}`);
  }
  return true;
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} exceeds safe limits`);
  return result;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}
