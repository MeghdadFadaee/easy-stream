import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeCacheMetadata } from '@easy-stream/media';
import { describe, expect, it } from 'vitest';
import { sweepCache } from '../src/cache-lifecycle.js';
import { readRegistry, updateRegistry } from '../src/registry.js';

describe('worker cache lifecycle', () => {
  it('evicts to the low watermark, removes registry rows, and prunes font orphans', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-cache-sweep-'));
    const cacheRoot = path.join(base, 'cache');
    const generations = path.join(cacheRoot, 'generations');
    const registryPath = path.join(base, 'registry.json');
    const oldGeneration = '11111111-1111-4111-8111-111111111111';
    const protectedGeneration = '22222222-2222-4222-8222-222222222222';
    for (const generation of [oldGeneration, protectedGeneration]) {
      const directory = path.join(generations, generation);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'segment.m4s'), Buffer.alloc(60));
      await writeCacheMetadata(generations, directory, {
        key: generation,
        bytes: 60,
        lastAccessedAt: '2020-01-01T00:00:00.000Z',
        active: false,
        building: false,
        pinned: false,
      });
      await updateRegistry(registryPath, generation, {
        mediaItemId: generation,
        generationId: generation,
        state: 'READY',
        playable: true,
        manifestPath: `/media/generations/${generation}/master.m3u8`,
      });
    }
    const fontStore = path.join(cacheRoot, 'assets', 'fonts', 'sha256');
    const orphanFont = path.join(fontStore, `${'a'.repeat(64)}.ttf`);
    await mkdir(fontStore, { recursive: true });
    await writeFile(orphanFont, Buffer.alloc(10));

    const result = await sweepCache({
      cacheRoot,
      registryPath,
      capacityBytes: 100,
      highWatermark: 0.85,
      lowWatermark: 0.75,
      playbackTtlMs: 0,
      protectedKeys: new Set([protectedGeneration]),
      fontOrphanMinimumAgeMs: 0,
      now: new Date('2999-01-01T00:00:00.000Z'),
    });

    expect(result.evicted).toEqual([oldGeneration]);
    expect(result.registryEntriesRemoved).toEqual([oldGeneration]);
    expect(result.orphanFontsRemoved).toEqual([path.basename(orphanFont)]);
    expect((await readRegistry(registryPath)).packages).toEqual([
      expect.objectContaining({ generationId: protectedGeneration }),
    ]);
    await expect(stat(path.join(generations, oldGeneration))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(generations, protectedGeneration))).resolves.toBeDefined();
  });
});
