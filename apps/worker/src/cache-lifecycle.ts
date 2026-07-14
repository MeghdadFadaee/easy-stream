import path from 'node:path';
import { evictCache, pruneOrphanedFonts, type EvictionResult } from '@easy-stream/media';
import { removeGenerationsFromRegistry } from './registry.js';

export interface CacheSweepOptions {
  cacheRoot: string;
  registryPath: string;
  capacityBytes: number;
  highWatermark: number;
  lowWatermark: number;
  playbackTtlMs: number;
  protectedKeys?: ReadonlySet<string>;
  fontOrphanMinimumAgeMs?: number;
  now?: Date;
}

export interface CacheSweepResult extends EvictionResult {
  registryEntriesRemoved: string[];
  orphanFontsRemoved: string[];
}

/** Sweeps only disposable cache generations. Durable derived media is deliberately out of scope. */
export async function sweepCache(options: CacheSweepOptions): Promise<CacheSweepResult> {
  const now = options.now ?? new Date();
  const fontOptions = {
    minimumAgeMs: options.fontOrphanMinimumAgeMs ?? 60 * 60 * 1000,
    now,
  };
  const beforeFonts = await pruneOrphanedFonts(options.cacheRoot, fontOptions);
  const eviction = await evictCache(path.join(options.cacheRoot, 'generations'), {
    capacityBytes: options.capacityBytes,
    highWatermark: options.highWatermark,
    lowWatermark: options.lowWatermark,
    ...(options.protectedKeys === undefined ? {} : { protectedKeys: options.protectedKeys }),
    overheadBytes: beforeFonts.retainedBytes,
    minimumRetentionMs: options.playbackTtlMs,
    now,
  });
  const registryEntriesRemoved = await removeGenerationsFromRegistry(
    options.registryPath,
    new Set(eviction.evicted),
  );
  const afterFonts = eviction.evicted.length === 0
    ? { removed: [] as string[], retainedBytes: beforeFonts.retainedBytes }
    : await pruneOrphanedFonts(options.cacheRoot, fontOptions);
  return {
    ...eviction,
    afterBytes: Math.max(0, eviction.afterBytes - beforeFonts.retainedBytes + afterFonts.retainedBytes),
    registryEntriesRemoved,
    orphanFontsRemoved: [...beforeFonts.removed, ...afterFonts.removed],
  };
}
