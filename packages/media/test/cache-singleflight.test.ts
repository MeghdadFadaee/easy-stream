import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evictCache,
  evictCacheGeneration,
  SingleFlight,
  touchCacheGeneration,
  writeCacheMetadata,
} from '../src/index.js';

describe('single flight and cache pressure', () => {
  it('shares one running promise per generation', async () => {
    const flight = new SingleFlight();
    let calls = 0;
    const operation = async (): Promise<number> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 42;
    };
    const [left, right] = await Promise.all([flight.run('generation', operation), flight.run('generation', operation)]);
    expect([left, right]).toEqual([42, 42]);
    expect(calls).toBe(1);
  });

  it('evicts oldest unprotected entries down to the low watermark', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-cache-'));
    for (const [key, date, pinned] of [['old', '2020-01-01T00:00:00.000Z', false], ['new', '2021-01-01T00:00:00.000Z', false], ['pin', '2019-01-01T00:00:00.000Z', true]] as const) {
      const directory = path.join(root, key);
      await mkdir(directory);
      await writeFile(path.join(directory, 'data'), Buffer.alloc(40));
      await writeCacheMetadata(root, directory, { key, lastAccessedAt: date, active: false, building: false, pinned, bytes: 40 });
    }
    const result = await evictCache(root, { capacityBytes: 100, highWatermark: 0.85, lowWatermark: 0.75 });
    expect(result.evicted).toEqual(['old', 'new']);
    expect(result.afterBytes).toBe(40);
  });

  it('evicts only inactive, unpinned cache generations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-generation-'));
    const generations = path.join(root, 'generations');
    const active = path.join(generations, 'active-generation');
    const ready = path.join(generations, 'ready-generation');
    await Promise.all([mkdir(active, { recursive: true }), mkdir(ready, { recursive: true })]);
    await Promise.all([writeFile(path.join(active, 'data'), 'active'), writeFile(path.join(ready, 'data'), 'ready')]);
    await writeCacheMetadata(generations, active, { key: 'active-generation', lastAccessedAt: new Date().toISOString(), active: true, building: false, pinned: false });
    await writeCacheMetadata(generations, ready, { key: 'ready-generation', lastAccessedAt: new Date().toISOString(), active: false, building: false, pinned: false });
    await expect(evictCacheGeneration(root, 'active-generation')).rejects.toThrow('active');
    expect(await evictCacheGeneration(root, 'ready-generation')).toBe(true);
    await expect(stat(ready)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('touches recency and keeps the longest playback protection window', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-generation-touch-'));
    const generations = path.join(root, 'generations');
    const generation = '11111111-1111-4111-8111-111111111111';
    const directory = path.join(generations, generation);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'data'), 'ready');
    await writeCacheMetadata(generations, directory, {
      key: generation,
      lastAccessedAt: '2026-01-01T00:00:00.000Z',
      protectedUntil: '2999-07-14T10:00:00.000Z',
      active: false,
      building: false,
      pinned: false,
    });
    await touchCacheGeneration(root, generation, {
      accessedAt: '2026-07-14T09:00:00.000Z',
      protectedUntil: '2026-07-14T09:30:00.000Z',
    });
    const metadata = JSON.parse(await readFile(path.join(directory, '.cache-entry.json'), 'utf8'));
    expect(metadata).toMatchObject({
      lastAccessedAt: '2026-07-14T09:00:00.000Z',
      protectedUntil: '2999-07-14T10:00:00.000Z',
    });
    await expect(evictCacheGeneration(root, generation)).rejects.toThrow('playback lease');
  });

  it('protects recently touched entries while evicting older pressure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-cache-retention-'));
    for (const [key, date] of [
      ['old-entry', '2026-07-14T00:00:00.000Z'],
      ['recent-entry', '2026-07-14T09:59:00.000Z'],
    ] as const) {
      const directory = path.join(root, key);
      await mkdir(directory);
      await writeFile(path.join(directory, 'data'), Buffer.alloc(60));
      await writeCacheMetadata(root, directory, {
        key,
        lastAccessedAt: date,
        active: false,
        building: false,
        pinned: false,
        bytes: 60,
      });
    }
    const result = await evictCache(root, {
      capacityBytes: 100,
      highWatermark: 0.85,
      lowWatermark: 0.75,
      minimumRetentionMs: 60 * 60 * 1000,
      now: new Date('2026-07-14T10:00:00.000Z'),
    });
    expect(result.evicted).toEqual(['old-entry']);
    expect(result.afterBytes).toBe(60);
  });

  it('rejects a planted writable-path symlink without writing outside the cache', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-cache-write-link-'));
    const root = path.join(base, 'cache');
    const outside = path.join(base, 'outside');
    await Promise.all([mkdir(root), mkdir(outside)]);
    const marker = path.join(outside, 'marker');
    await writeFile(marker, 'untouched');
    await symlink(outside, path.join(root, 'linked-entry'));

    await expect(writeCacheMetadata(root, path.join(root, 'linked-entry'), {
      key: 'linked-entry',
      lastAccessedAt: new Date().toISOString(),
      active: false,
      building: false,
      pinned: false,
      bytes: 1,
    })).rejects.toThrow(/Symlink found in writable path/u);

    expect(await readFile(marker, 'utf8')).toBe('untouched');
    await expect(stat(path.join(outside, '.cache-entry.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a planted generations symlink without deleting outside the cache', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-cache-delete-link-'));
    const root = path.join(base, 'cache');
    const outside = path.join(base, 'outside');
    const generation = '33333333-3333-4333-8333-333333333333';
    const outsideGeneration = path.join(outside, generation);
    await Promise.all([mkdir(root), mkdir(outsideGeneration, { recursive: true })]);
    const marker = path.join(outsideGeneration, 'marker');
    await writeFile(marker, 'untouched');
    await writeCacheMetadata(outside, outsideGeneration, {
      key: generation,
      lastAccessedAt: '2020-01-01T00:00:00.000Z',
      active: false,
      building: false,
      pinned: false,
    });
    await symlink(outside, path.join(root, 'generations'));

    await expect(evictCacheGeneration(root, generation)).rejects.toThrow(/writable root is a symlink/u);
    expect(await readFile(marker, 'utf8')).toBe('untouched');
    await expect(stat(outsideGeneration)).resolves.toBeDefined();
  });
});
