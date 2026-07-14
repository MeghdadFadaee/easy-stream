import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemCacheStatusService } from '../src/services/cache-status.js';

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('filesystem cache status', () => {
  it('sums valid generation metadata and global font-store files', async () => {
    const root = await temporaryRoot();
    const generations = path.join(root, 'generations');
    await Promise.all([
      writeEntry(generations, '11111111-1111-4111-8111-111111111111', 120, false),
      writeEntry(generations, '22222222-2222-4222-8222-222222222222', 230, true),
      mkdir(path.join(generations, 'incomplete-generation'), { recursive: true }),
    ]);
    const fontStore = path.join(root, 'assets', 'fonts', 'sha256');
    await mkdir(fontStore, { recursive: true });
    await Promise.all([
      writeFile(path.join(fontStore, `${'a'.repeat(64)}.ttf`), Buffer.alloc(11)),
      writeFile(path.join(fontStore, `${'b'.repeat(64)}.otf`), Buffer.alloc(19)),
    ]);

    await expect(service(root).getStatus()).resolves.toEqual({
      usedBytes: 380,
      maxBytes: 1_000,
      highWatermark: 0.85,
      lowWatermark: 0.75,
      activePackages: 1,
    });
  });

  it('treats a missing cache root as an empty cache', async () => {
    const base = await temporaryRoot();
    await expect(service(path.join(base, 'missing')).getStatus()).resolves.toMatchObject({
      usedBytes: 0,
      activePackages: 0,
    });
  });

  it('rejects invalid managed generation metadata', async () => {
    const root = await temporaryRoot();
    const generations = path.join(root, 'generations');
    const generation = '11111111-1111-4111-8111-111111111111';
    const directory = path.join(generations, generation);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, '.cache-entry.json'), JSON.stringify({
      ...metadata('different-generation', 10, false),
    }));

    await expect(service(root).getStatus()).rejects.toThrow(/does not match its generation/u);
  });

  it('counts a known archived failure without treating stale metadata as a live build', async () => {
    const root = await temporaryRoot();
    const generations = path.join(root, 'generations');
    const generation = '11111111-1111-4111-8111-111111111111';
    const archived = `failed-1784023200000-${generation}`;
    const directory = path.join(generations, archived);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, '.cache-entry.json'), JSON.stringify(
      metadata(generation, 77, true),
    ));

    await expect(service(root).getStatus()).resolves.toMatchObject({
      usedBytes: 77,
      activePackages: 0,
    });
  });

  it('fails closed on symlinks in managed cache namespaces', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const generations = path.join(root, 'generations');
    await mkdir(generations, { recursive: true });
    await symlink(outside, path.join(generations, 'linked-generation'));
    await expect(service(root).getStatus()).rejects.toThrow(/Symlink found in cache generations/u);

    await rm(generations, { recursive: true, force: true });
    await symlink(outside, path.join(root, 'assets'));
    await expect(service(root).getStatus()).rejects.toThrow(/not a regular directory/u);
  });
});

function service(cacheRoot: string): FilesystemCacheStatusService {
  return new FilesystemCacheStatusService({
    cacheRoot,
    maxBytes: 1_000,
    highWatermark: 0.85,
    lowWatermark: 0.75,
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-api-cache-'));
  temporaryRoots.push(root);
  return root;
}

async function writeEntry(
  generations: string,
  generation: string,
  bytes: number,
  building: boolean,
): Promise<void> {
  const directory = path.join(generations, generation);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, '.cache-entry.json'), JSON.stringify(
    metadata(generation, bytes, building),
  ));
}

function metadata(key: string, bytes: number, building: boolean) {
  return {
    version: 1,
    key,
    bytes,
    lastAccessedAt: '2026-07-14T10:00:00.000Z',
    active: false,
    building,
    pinned: false,
  };
}
