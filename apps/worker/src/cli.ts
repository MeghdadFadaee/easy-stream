#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createDatabase,
  markArchiveScanFailed,
  markArchiveScanRunning,
  markArchiveScanSucceeded,
  syncCatalogSnapshot,
  type Database,
} from '@easy-stream/database';
import {
  classifyMedia,
  extractAndStoreFonts,
  extractSubtitleVariants,
  evictCacheGeneration,
  fingerprintSource,
  isPathInside,
  normalizeStreamLanguage,
  packageProgressiveHls,
  prepareCompatibilityHls,
  probeMedia,
  publishGenerationFonts,
  pruneOrphanedFonts,
  resolveInside,
  touchCacheGeneration,
  writeCacheMetadata,
} from '@easy-stream/media';
import {
  deterministicUuid,
  findMediaItem,
  scanArchive,
  type InventorySnapshot,
  type SnapshotMediaItem,
} from './catalog.js';
import { sweepCache } from './cache-lifecycle.js';
import {
  normalizeTrackLabel,
  removeGenerationFromRegistry,
  updateRegistry,
} from './registry.js';

for (const candidate of [process.env.ENV_FILE, '.env', '../../.env']) {
  if (!candidate) continue;
  try {
    process.loadEnvFile?.(candidate);
    break;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

interface Arguments {
  command?: string;
  flags: Map<string, string | true>;
}

interface CommandRuntime {
  protectedCacheKeys?: () => Promise<ReadonlySet<string>>;
}

function parseArguments(argv: readonly string[]): Arguments {
  const flags = new Map<string, string | true>();
  let command: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined || value === '--') continue;
    if (!value.startsWith('--') && command === undefined) {
      command = value;
      continue;
    }
    if (!value.startsWith('--')) throw new Error(`Unexpected positional argument: ${value}`);
    const equals = value.indexOf('=');
    if (equals >= 0) {
      flags.set(value.slice(2, equals), value.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(value.slice(2), next);
      index += 1;
    } else {
      flags.set(value.slice(2), true);
    }
  }
  return { ...(command === undefined ? {} : { command }), flags };
}

function flag(arguments_: Arguments, name: string, fallback?: string): string | undefined {
  const value = arguments_.flags.get(name);
  if (value === true) throw new Error(`--${name} requires a value`);
  return value ?? fallback;
}

async function writeJsonAtomic(destinationPath: string, value: unknown): Promise<void> {
  const destination = path.resolve(destinationPath);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o750 });
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  await rename(temporary, destination);
}

async function scanCommand(arguments_: Arguments): Promise<void> {
  const archiveRoot = path.resolve(flag(arguments_, 'root', './movies') ?? './movies');
  const output = flag(arguments_, 'output');
  const inventoryOutput = flag(arguments_, 'inventory-output')
    ?? (output === undefined ? undefined : path.join(path.dirname(output), 'inventory.json'));
  if ((output !== undefined && isPathInside(archiveRoot, path.resolve(output)))
    || (inventoryOutput !== undefined && isPathInside(archiveRoot, path.resolve(inventoryOutput)))) {
    throw new Error('Catalog output must not be written into the read-only archive');
  }
  const result = await scanArchive({
    archiveRoot,
    ...(flag(arguments_, 'ffmpeg') === undefined ? {} : { ffmpegPath: flag(arguments_, 'ffmpeg') as string }),
    ...(flag(arguments_, 'ffprobe') === undefined ? {} : { ffprobePath: flag(arguments_, 'ffprobe') as string }),
    onFile(relativePath, current) {
      process.stderr.write(`[scan ${current}] ${relativePath}\n`);
    },
  });
  if (output !== undefined) {
    await Promise.all([
      writeJsonAtomic(output, result.catalog),
      ...(inventoryOutput === undefined ? [] : [writeJsonAtomic(inventoryOutput, result.inventory)]),
    ]);
  }

  // Direct scans stay portable; the long-running worker passes DATABASE_URL explicitly.
  const databaseUrl = flag(arguments_, 'database');
  const databaseSync = databaseUrl === undefined
    ? undefined
    : await withDatabase(databaseUrl, (database) => syncCatalogSnapshot(database, result.catalog));

  if (output === undefined) process.stdout.write(`${JSON.stringify(result.catalog, null, 2)}\n`);
  else {
    process.stdout.write(`${JSON.stringify({
      output: path.resolve(output),
      ...(inventoryOutput === undefined ? {} : { inventoryOutput: path.resolve(inventoryOutput) }),
      titles: result.catalog.titles.length,
      mediaItems: result.catalog.titles.reduce((sum, item) => sum + item.mediaItems.length, 0),
      ...(databaseSync === undefined ? {} : { databaseSync }),
    })}\n`);
  }
}

async function withDatabase<T>(
  connectionString: string,
  action: (database: Database) => Promise<T>,
): Promise<T> {
  const connection = createDatabase(connectionString, { max: 2 });
  try {
    return await action(connection.db);
  } finally {
    await connection.close();
  }
}

async function loadInventory(snapshotPath: string): Promise<InventorySnapshot> {
  const value = JSON.parse(await readFile(snapshotPath, 'utf8')) as InventorySnapshot;
  if (value.version !== 1 || !Array.isArray(value.items)) throw new Error('Unsupported catalog snapshot');
  return value;
}

async function sourceSelection(
  arguments_: Arguments,
  archiveRoot: string,
): Promise<{ media: SnapshotMediaItem; sourcePath: string }> {
  const mediaItem = flag(arguments_, 'media-item');
  const requestedSource = flag(arguments_, 'source');
  const inventoryPath = flag(arguments_, 'inventory', './data/inventory.json') ?? './data/inventory.json';
  let inventory: InventorySnapshot | undefined;
  try {
    inventory = await loadInventory(inventoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || mediaItem !== undefined) throw error;
  }
  const selected = mediaItem === undefined
    ? (requestedSource === undefined ? undefined : inventory === undefined ? undefined : findMediaItem(inventory, requestedSource))
    : inventory === undefined ? undefined : findMediaItem(inventory, mediaItem);
  if (selected !== undefined) {
    return { media: selected, sourcePath: await resolveInside(archiveRoot, path.join(archiveRoot, selected.sourcePath)) };
  }
  if (mediaItem !== undefined) throw new Error(`Media item was not found in ${inventoryPath}: ${mediaItem}`);
  if (requestedSource === undefined) throw new Error('package requires --media-item ID or --source PATH');
  const sourcePath = await resolveInside(
    archiveRoot,
    path.isAbsolute(requestedSource) ? requestedSource : path.join(archiveRoot, requestedSource),
  );
  const relative = path.relative(archiveRoot, sourcePath).split(path.sep).join('/');
  const ffprobePath = flag(arguments_, 'ffprobe');
  const probe = await probeMedia(sourcePath, ffprobePath === undefined ? {} : { ffprobePath });
  const fingerprint = await fingerprintSource(archiveRoot, sourcePath);
  const classification = classifyMedia(probe);
  return {
    sourcePath,
    media: {
      id: deterministicUuid(`media:${relative}`),
      titleId: deterministicUuid(`title:${relative}`),
      kind: 'MOVIE',
      sourcePath: relative,
      durationSeconds: Number(probe.format.duration) || 0,
      title: { en: path.basename(relative, path.extname(relative)) },
      published: ['COPY', 'AUDIO_TRANSCODE'].includes(classification.class),
      compatibility: classification.class,
      compatibilityReasons: classification.reasons,
      fingerprint,
      streams: [],
      subtitles: [],
    },
  };
}

async function packageCommand(arguments_: Arguments, runtime: CommandRuntime): Promise<void> {
  const archiveRoot = path.resolve(flag(arguments_, 'root', './movies') ?? './movies');
  const cacheRoot = path.resolve(flag(arguments_, 'cache', './data/media-cache') ?? './data/media-cache');
  const registryPath = path.resolve(flag(arguments_, 'registry', './data/package-registry.json') ?? './data/package-registry.json');
  if (isPathInside(archiveRoot, cacheRoot) || isPathInside(archiveRoot, registryPath)) {
    throw new Error('Cache and registry must be outside the read-only archive');
  }
  const selected = await sourceSelection(arguments_, archiveRoot);
  const [probe, fingerprint] = await Promise.all([
    probeMedia(selected.sourcePath, flag(arguments_, 'ffprobe') === undefined ? {} : { ffprobePath: flag(arguments_, 'ffprobe') as string }),
    fingerprintSource(archiveRoot, selected.sourcePath),
  ]);
  const classification = classifyMedia(probe);
  if (!['COPY', 'AUDIO_TRANSCODE'].includes(classification.class)) {
    throw new Error(`Media requires offline preparation (${classification.class}): ${classification.reasons.join(', ')}`);
  }
  const generationId = deterministicUuid(`generation:cmaf-v1:${fingerprint.digest}`);
  const generationPath = `generations/${generationId}`;
  const ffmpegPath = flag(arguments_, 'ffmpeg');
  const ffprobePath = flag(arguments_, 'ffprobe');
  const preparing = async (error?: string): Promise<void> => {
    await updateRegistry(registryPath, selected.media.id, {
      mediaItemId: selected.media.id,
      generationId,
      state: error === undefined ? 'PREPARING' : 'FAILED',
      playable: false,
      ...(error === undefined ? { pollAfterMs: 1000 } : { reasonCode: 'PACKAGE_FAILED' }),
      durationSeconds: Number(probe.format.duration) || selected.media.durationSeconds,
    });
  };
  type Assets = {
    subtitles: Awaited<ReturnType<typeof extractSubtitleVariants>>;
    fonts: Awaited<ReturnType<typeof extractAndStoreFonts>>;
  };
  let assetError: unknown;
  let assetsPromise: Promise<Assets | undefined> | undefined;
  const startAssets = (): void => {
    if (assetsPromise !== undefined) return;
    assetsPromise = Promise.all([
      extractSubtitleVariants(selected.sourcePath, probe, {
        archiveRoot,
        outputRoot: cacheRoot,
        generation: generationPath,
        ...(ffmpegPath === undefined ? {} : { ffmpegPath }),
      }),
      extractAndStoreFonts(selected.sourcePath, probe, {
        archiveRoot,
        fontRoot: path.join(cacheRoot, 'assets', 'fonts'),
        ...(ffmpegPath === undefined ? {} : { ffmpegPath }),
        ...(flag(arguments_, 'font-sanitizer') === undefined ? {} : { sanitizerPath: flag(arguments_, 'font-sanitizer') as string }),
      }),
    ]).then(async ([subtitles, storedFonts]) => ({
      subtitles,
      fonts: await publishGenerationFonts(storedFonts, cacheRoot, path.join(cacheRoot, generationPath)),
    })).catch((error: unknown) => {
      assetError = error;
      return undefined;
    });
  };
  let result: Awaited<ReturnType<typeof packageProgressiveHls>>;
  try {
    result = await packageProgressiveHls({
      archiveRoot,
      cacheRoot,
      sourcePath: selected.sourcePath,
      fingerprint,
      probe,
      classification,
      generation: generationId,
      ...(ffmpegPath === undefined ? {} : { ffmpegPath }),
      ...(ffprobePath === undefined ? {} : { ffprobePath }),
      async onProgress(progress) {
        startAssets();
        await preparing(progress.state === 'FAILED'
          ? progress.error ?? 'Unknown packaging error'
          : undefined);
      },
    });
  } catch (error) {
    await assetsPromise;
    await preparing(error instanceof Error ? error.message : String(error));
    throw error;
  }
  startAssets();
  const assets = await assetsPromise;
  if (assetError !== undefined || assets === undefined) {
    const error = assetError instanceof Error ? assetError : new Error(String(assetError ?? 'Asset preparation failed'));
    await preparing(error.message);
    throw error;
  }
  const { subtitles, fonts } = assets;
  const audioStreams = probe.streams.filter((stream) => stream.codec_type === 'audio');
  const fontUrls = fonts.map((font) => `/media/${generationPath}/fonts/${font.sha256}.${font.format}`);
  await updateRegistry(registryPath, selected.media.id, {
    mediaItemId: selected.media.id,
    generationId,
    state: 'READY',
    playable: true,
    manifestPath: `/media/${generationPath}/master.m3u8`,
    durationSeconds: Number(probe.format.duration) || selected.media.durationSeconds,
    audioTracks: audioStreams.map((stream, index) => ({
      id: deterministicUuid(`audio:${selected.media.id}:${stream.index}`),
      language: normalizeStreamLanguage(stream),
      label: normalizeTrackLabel(stream.tags?.title, normalizeStreamLanguage(stream)),
      default: index === 0,
    })),
    subtitleTracks: subtitles.map((subtitle) => ({
      id: deterministicUuid(`subtitle:${selected.media.id}:${subtitle.streamIndex}`),
      language: subtitle.language,
      label: subtitle.language,
      default: subtitle.default,
      forced: subtitle.forced,
      assUrl: `/media/${path.relative(cacheRoot, subtitle.assPath).split(path.sep).join('/')}`,
      vttUrl: `/media/${path.relative(cacheRoot, subtitle.vttPath).split(path.sep).join('/')}`,
      fontUrls,
    })),
  });
  await writeCacheMetadata(path.join(cacheRoot, 'generations'), path.join(cacheRoot, generationPath), {
    key: generationId,
    lastAccessedAt: new Date().toISOString(),
    active: false,
    building: false,
    pinned: false,
  });
  const protectedKeys = await runtime.protectedCacheKeys?.();
  const cacheSweep = await sweepCache({
    cacheRoot,
    registryPath,
    capacityBytes: numericFlag(arguments_, 'cache-max-bytes', process.env.CACHE_MAX_BYTES, 2_147_483_648_000),
    highWatermark: numericFlag(arguments_, 'cache-high-watermark', process.env.CACHE_HIGH_WATERMARK, 0.85),
    lowWatermark: numericFlag(arguments_, 'cache-low-watermark', process.env.CACHE_LOW_WATERMARK, 0.75),
    playbackTtlMs: numericFlag(arguments_, 'playback-ttl-seconds', process.env.PLAYBACK_TTL_SECONDS, 4 * 60 * 60) * 1000,
    ...(protectedKeys === undefined ? {} : { protectedKeys }),
  });
  process.stdout.write(`${JSON.stringify({ mediaItemId: selected.media.id, generationId, manifestPath: `/media/${generationPath}/master.m3u8`, knownAacRepairs: result.knownAacRepairs, subtitles: subtitles.length, fonts: fonts.length, cacheSweep })}\n`);
}

function numericFlag(
  arguments_: Arguments,
  name: string,
  environmentValue: string | undefined,
  fallback: number,
): number {
  const value = flag(arguments_, name, environmentValue);
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) throw new Error(`--${name} must be a finite number`);
  return number;
}

async function prepareCommand(arguments_: Arguments): Promise<void> {
  const archiveRoot = path.resolve(flag(arguments_, 'root', './movies') ?? './movies');
  const derivedRoot = path.resolve(flag(arguments_, 'derived', process.env.DERIVED_ROOT ?? './data/media-derived') ?? './data/media-derived');
  const registryPath = path.resolve(flag(arguments_, 'registry', './data/package-registry.json') ?? './data/package-registry.json');
  if (isPathInside(archiveRoot, derivedRoot) || isPathInside(archiveRoot, registryPath)) {
    throw new Error('Derived output and registry must be outside the read-only archive');
  }
  const selected = await sourceSelection(arguments_, archiveRoot);
  const [probe, fingerprint] = await Promise.all([
    probeMedia(selected.sourcePath, flag(arguments_, 'ffprobe') === undefined ? {} : { ffprobePath: flag(arguments_, 'ffprobe') as string }),
    fingerprintSource(archiveRoot, selected.sourcePath),
  ]);
  const classification = classifyMedia(probe);
  if (classification.class === 'HOLD_HDR') throw new Error('HDR_UNSUPPORTED_V1');
  if (classification.class !== 'VIDEO_TRANSCODE') {
    throw new Error(`Offline video compatibility encoding is not applicable to ${classification.class}`);
  }
  const generationId = deterministicUuid(`generation:compat-h264-v1:${fingerprint.digest}`);
  await updateRegistry(registryPath, selected.media.id, {
    mediaItemId: selected.media.id,
    generationId,
    state: 'PREPARING',
    playable: false,
    pollAfterMs: 5000,
    durationSeconds: Number(probe.format.duration) || selected.media.durationSeconds,
  });
  try {
    const result = await prepareCompatibilityHls({
      archiveRoot,
      derivedRoot,
      sourcePath: selected.sourcePath,
      fingerprint,
      probe,
      classification,
      generation: generationId,
      ...(flag(arguments_, 'ffmpeg') === undefined ? {} : { ffmpegPath: flag(arguments_, 'ffmpeg') as string }),
      ...(flag(arguments_, 'ffprobe') === undefined ? {} : { ffprobePath: flag(arguments_, 'ffprobe') as string }),
    });
    const generationPath = `generations/${generationId}`;
    const [subtitles, storedFonts] = await Promise.all([
      extractSubtitleVariants(selected.sourcePath, probe, {
        archiveRoot,
        outputRoot: derivedRoot,
        generation: generationPath,
        ...(flag(arguments_, 'ffmpeg') === undefined ? {} : { ffmpegPath: flag(arguments_, 'ffmpeg') as string }),
      }),
      extractAndStoreFonts(selected.sourcePath, probe, {
        archiveRoot,
        fontRoot: path.join(derivedRoot, 'assets', 'fonts'),
        ...(flag(arguments_, 'ffmpeg') === undefined ? {} : { ffmpegPath: flag(arguments_, 'ffmpeg') as string }),
        ...(flag(arguments_, 'font-sanitizer') === undefined ? {} : { sanitizerPath: flag(arguments_, 'font-sanitizer') as string }),
      }),
    ]);
    const fonts = await publishGenerationFonts(storedFonts, derivedRoot, path.join(derivedRoot, generationPath));
    const fontUrls = fonts.map((font) => `/media/derived/${generationPath}/fonts/${font.sha256}.${font.format}`);
    const audioStreams = probe.streams.filter((stream) => stream.codec_type === 'audio');
    await updateRegistry(registryPath, selected.media.id, {
      mediaItemId: selected.media.id,
      generationId,
      state: 'READY',
      playable: true,
      manifestPath: `/media/derived/${generationPath}/master.m3u8`,
      durationSeconds: Number(probe.format.duration) || selected.media.durationSeconds,
      audioTracks: audioStreams.map((stream, index) => ({
        id: deterministicUuid(`audio:${selected.media.id}:${stream.index}`),
        language: normalizeStreamLanguage(stream),
        label: normalizeTrackLabel(stream.tags?.title, normalizeStreamLanguage(stream)),
        default: index === 0,
      })),
      subtitleTracks: subtitles.map((subtitle) => ({
        id: deterministicUuid(`subtitle:${selected.media.id}:${subtitle.streamIndex}`),
        language: subtitle.language,
        label: subtitle.language,
        default: subtitle.default,
        forced: subtitle.forced,
        assUrl: `/media/derived/${path.relative(derivedRoot, subtitle.assPath).split(path.sep).join('/')}`,
        vttUrl: `/media/derived/${path.relative(derivedRoot, subtitle.vttPath).split(path.sep).join('/')}`,
        fontUrls,
      })),
    });
    process.stdout.write(`${JSON.stringify({ mediaItemId: selected.media.id, generationId, manifestPath: `/media/derived/${generationPath}/master.m3u8`, knownAacRepairs: result.knownAacRepairs })}\n`);
  } catch (error) {
    await updateRegistry(registryPath, selected.media.id, {
      mediaItemId: selected.media.id,
      generationId,
      state: 'FAILED',
      playable: false,
      reasonCode: 'COMPATIBILITY_ENCODE_FAILED',
      durationSeconds: Number(probe.format.duration) || selected.media.durationSeconds,
    });
    throw error;
  }
}

async function workCommand(arguments_: Arguments): Promise<void> {
  const redisUrl = flag(arguments_, 'redis', process.env.REDIS_URL);
  if (redisUrl === undefined) throw new Error('REDIS_URL or --redis is required');
  const archiveRoot = flag(arguments_, 'root', process.env.ARCHIVE_ROOT ?? './movies') ?? './movies';
  const cacheRoot = flag(arguments_, 'cache', process.env.MEDIA_CACHE_ROOT ?? process.env.CACHE_ROOT ?? './data/media-cache') ?? './data/media-cache';
  const catalog = flag(arguments_, 'catalog', process.env.CATALOG_SNAPSHOT_PATH ?? './data/catalog.json') ?? './data/catalog.json';
  const inventory = flag(arguments_, 'inventory', process.env.MEDIA_INVENTORY_PATH ?? process.env.INVENTORY_SNAPSHOT_PATH ?? './data/inventory.json') ?? './data/inventory.json';
  const registry = flag(arguments_, 'registry', process.env.PACKAGE_REGISTRY_PATH ?? './data/package-registry.json') ?? './data/package-registry.json';
  const configuredDatabaseUrl = flag(arguments_, 'database', process.env.DATABASE_URL);
  const databaseUrl = configuredDatabaseUrl?.trim() ? configuredDatabaseUrl : undefined;
  const concurrency = Number(flag(
    arguments_,
    'concurrency',
    process.env.MEDIA_WORKER_CONCURRENCY ?? process.env.JIT_REMUX_CONCURRENCY ?? '2',
  ));
  const ffmpegPath = flag(arguments_, 'ffmpeg', process.env.FFMPEG_PATH);
  const ffprobePath = flag(arguments_, 'ffprobe', process.env.FFPROBE_PATH);
  const mediaTools = [
    ...(ffmpegPath === undefined ? [] : ['--ffmpeg', ffmpegPath]),
    ...(ffprobePath === undefined ? [] : ['--ffprobe', ffprobePath]),
  ];
  const { startMediaQueueWorker } = await import('./work.js');
  let running: ReturnType<typeof startMediaQueueWorker>;
  running = startMediaQueueWorker({
    redisUrl,
    concurrency,
    async dispatch(command) {
      if (command.type === 'media.playback.requested') {
        await main([
          'package', '--root', archiveRoot, '--cache', cacheRoot, '--inventory', inventory,
          '--registry', registry, '--media-item', command.mediaItemId, ...mediaTools,
        ], { protectedCacheKeys: () => running.protectedCacheGenerations() });
      } else if (command.type === 'archive.scan.requested') {
        if (databaseUrl !== undefined) {
          const updated = await withDatabase(databaseUrl, (database) => markArchiveScanRunning(database, command.jobId));
          if (!updated) throw new Error(`Archive scan job is missing or not runnable: ${command.jobId}`);
        }
        await main([
          'scan', '--root', archiveRoot, '--output', catalog, '--inventory-output', inventory,
          ...(databaseUrl === undefined ? [] : ['--database', databaseUrl]),
          ...mediaTools,
        ]);
      } else if (command.type === 'package.eviction.requested') {
        if ((await running.protectedCacheGenerations()).has(command.generationId)) {
          throw new Error(`Cache generation has an active playback lease: ${command.generationId}`);
        }
        const evicted = await evictCacheGeneration(cacheRoot, command.generationId);
        if (evicted) {
          await removeGenerationFromRegistry(registry, command.generationId);
          await pruneOrphanedFonts(cacheRoot);
        }
      } else if (command.type === 'cache.generation.accessed') {
        await running.recordCacheLease(command.generationId, command.protectedUntil);
        await touchCacheGeneration(cacheRoot, command.generationId, {
          accessedAt: command.accessedAt,
          protectedUntil: command.protectedUntil,
        });
      } else if (command.type === 'media.publication.changed') {
        // Publication state is owned by the API/database; no media mutation is necessary.
      } else {
        const exhaustive: never = command;
        throw new Error(`Unsupported media command: ${String(exhaustive)}`);
      }
    },
    async onCompleted(command) {
      if (command.type !== 'archive.scan.requested' || databaseUrl === undefined) return;
      const updated = await withDatabase(databaseUrl, (database) => markArchiveScanSucceeded(
        database,
        command.jobId,
        { catalogPath: path.resolve(catalog), inventoryPath: path.resolve(inventory) },
      ));
      if (!updated) throw new Error(`Archive scan job did not remain RUNNING: ${command.jobId}`);
    },
    async onFailed(command, error, job) {
      if (command?.type === 'archive.scan.requested' && databaseUrl !== undefined) {
        try {
          await withDatabase(databaseUrl, (database) => markArchiveScanFailed(database, command.jobId, error.message));
        } catch (statusError) {
          process.stderr.write(`${JSON.stringify({ level: 'error', queue: 'easy-stream-media', jobId: job?.id, command: command.type, error: 'Unable to persist failed job status', detail: statusError instanceof Error ? statusError.message : String(statusError) })}\n`);
        }
      }
      process.stderr.write(`${JSON.stringify({ level: 'error', queue: 'easy-stream-media', jobId: job?.id, command: command?.type, error: error.message })}\n`);
    },
  });
  process.stdout.write(`${JSON.stringify({ state: 'WORKING', queue: 'easy-stream-media', concurrency })}\n`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await running.close();
}

export async function main(
  argv = process.argv.slice(2),
  runtime: CommandRuntime = {},
): Promise<void> {
  const arguments_ = parseArguments(argv);
  if (arguments_.command === 'scan') await scanCommand(arguments_);
  else if (arguments_.command === 'package') await packageCommand(arguments_, runtime);
  else if (arguments_.command === 'prepare') await prepareCommand(arguments_);
  else if (arguments_.command === 'work') await workCommand(arguments_);
  else {
    process.stderr.write('Usage:\n  worker scan --root DIR [--output FILE] [--inventory-output FILE] [--database URL]\n  worker package --root DIR --cache DIR (--media-item ID | --source FILE) [--inventory FILE] [--registry FILE]\n  worker prepare --root DIR --derived DIR (--media-item ID | --source FILE) [--inventory FILE]\n  worker work --redis URL [--database URL] [--concurrency N]\n');
    process.exitCode = arguments_.command === undefined ? 0 : 2;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
