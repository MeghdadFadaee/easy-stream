import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CACHE_GENERATION_LEASES_KEY,
  PackageRegistrySchema,
  type MediaCommand,
  type PackageRegistry,
} from '@easy-stream/contracts';
import { Value } from '@sinclair/typebox/value';
import { Queue, type ConnectionOptions } from 'bullmq';
import type {
  MediaCommandPublisher,
  MediaPreparation,
  MediaPreparationService,
} from '../domain.js';

export class JsonlMediaCommandPublisher implements MediaCommandPublisher {
  constructor(private readonly path: string) {}

  async publish(command: MediaCommand): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(command)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}

export class InMemoryMediaCommandPublisher implements MediaCommandPublisher {
  readonly commands: MediaCommand[] = [];

  async publish(command: MediaCommand): Promise<void> {
    this.commands.push(structuredClone(command));
  }
}

export class FileMediaPreparationService implements MediaPreparationService {
  private readonly requested = new Set<string>();

  constructor(
    private readonly registryPath: string,
    private readonly publisher: MediaCommandPublisher,
  ) {}

  async prepare(input: Parameters<MediaPreparationService['prepare']>[0]) {
    const status = await this.find(input.mediaItem.id);
    if (status) {
      if (status.playable || status.state === 'READY' || status.state === 'FAILED') {
        this.requested.delete(input.mediaItem.id);
      }
      await this.recordCacheAccess(input, status);
      return status;
    }
    if (!this.requested.has(input.mediaItem.id)) {
      this.requested.add(input.mediaItem.id);
      try {
        await this.publisher.publish({
          type: 'media.playback.requested',
          sessionId: input.sessionId,
          mediaItemId: input.mediaItem.id,
        });
      } catch (error) {
        this.requested.delete(input.mediaItem.id);
        throw error;
      }
    }
    return {
      state: 'PREPARING' as const,
      playable: false,
      pollAfterMs: 1500,
      reasonCode: 'PACKAGE_REQUESTED',
    };
  }

  async getStatus(input: Parameters<MediaPreparationService['getStatus']>[0]) {
    const status = await this.find(input.mediaItem.id);
    if (status?.playable || status?.state === 'READY' || status?.state === 'FAILED') {
      this.requested.delete(input.mediaItem.id);
    }
    const result = status ?? {
        state: 'PREPARING' as const,
        playable: false,
        pollAfterMs: 1500,
        reasonCode: 'PACKAGE_REQUESTED',
      };
    await this.recordCacheAccess(input, result);
    return result;
  }

  private async recordCacheAccess(
    input: { sessionId: string; protectUntil?: string },
    status: MediaPreparation,
  ): Promise<void> {
    if (input.protectUntil === undefined || !status.playable || !status.generationId
      || !status.manifestPath?.startsWith('/media/generations/')) return;
    await this.publisher.publish({
      type: 'cache.generation.accessed',
      sessionId: input.sessionId,
      generationId: status.generationId,
      accessedAt: new Date().toISOString(),
      protectedUntil: input.protectUntil,
    });
  }

  private async find(mediaItemId: string): Promise<MediaPreparation | undefined> {
    const registry = await readPackageRegistry(this.registryPath);
    const entry = registry?.packages.find((candidate) => candidate.mediaItemId === mediaItemId);
    if (!entry) return undefined;
    return {
      state: entry.state,
      playable: entry.playable,
      ...(entry.generationId ? { generationId: entry.generationId } : {}),
      ...(entry.manifestPath ? { manifestPath: entry.manifestPath } : {}),
      ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}),
      ...(entry.pollAfterMs ? { pollAfterMs: entry.pollAfterMs } : {}),
      ...(entry.durationSeconds !== undefined ? { durationSeconds: entry.durationSeconds } : {}),
      ...(entry.audioTracks ? { audioTracks: entry.audioTracks } : {}),
      ...(entry.subtitleTracks ? { subtitleTracks: entry.subtitleTracks } : {}),
    };
  }
}

export async function readPackageRegistry(path: string): Promise<PackageRegistry | undefined> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(source);
  if (!Value.Check(PackageRegistrySchema, parsed)) {
    const errors = [...Value.Errors(PackageRegistrySchema, parsed)]
      .map((error) => `${error.path || '/'} ${error.message}`)
      .join('; ');
    throw new Error(`Invalid package registry at ${path}: ${errors}`);
  }
  return parsed;
}

export class BullMqMediaBridge implements MediaPreparationService, MediaCommandPublisher {
  private readonly fileStatus: FileMediaPreparationService;
  private readonly queue: Queue<MediaCommand>;
  private leaseCommandReady?: Promise<void>;

  constructor(
    redisUrl: string,
    registryPath: string,
    private readonly profile: string,
  ) {
    this.queue = new Queue<MediaCommand>('easy-stream-media', {
      connection: redisConnection(redisUrl),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 3600, count: 2000 },
        removeOnFail: { age: 86_400, count: 2000 },
      },
    });
    this.fileStatus = new FileMediaPreparationService(registryPath, this);
  }

  async prepare(input: Parameters<MediaPreparationService['prepare']>[0]) {
    return this.fileStatus.prepare(input);
  }

  async getStatus(input: Parameters<MediaPreparationService['getStatus']>[0]) {
    return this.fileStatus.getStatus(input);
  }

  async publish(command: MediaCommand): Promise<void> {
    if (command.type === 'cache.generation.accessed') {
      const protectedUntil = Date.parse(command.protectedUntil);
      if (!Number.isFinite(protectedUntil)) throw new Error('Invalid cache lease expiration');
      const client = await this.queue.client;
      this.leaseCommandReady ??= Promise.resolve(client.defineCommand(
        'easyStreamExtendCacheLease',
        {
          numberOfKeys: 1,
          lua: "return redis.call('ZADD', KEYS[1], 'GT', ARGV[1], ARGV[2])",
        },
      ));
      await this.leaseCommandReady;
      await client.runCommand('easyStreamExtendCacheLease', [
        CACHE_GENERATION_LEASES_KEY,
        protectedUntil,
        command.generationId,
      ]);
    }
    const jobId = commandJobId(command, this.profile);
    if (command.type === 'archive.scan.requested') {
      const existing = await this.queue.getJob(jobId);
      if (existing !== undefined && await existing.getState() === 'failed') {
        await existing.retry('failed');
        return;
      }
    }
    await this.queue.add(command.type, command, {
      jobId,
      ...(['media.playback.requested', 'cache.generation.accessed'].includes(command.type)
        ? { removeOnComplete: true }
        : {}),
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

function redisConnection(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  if (!Number.isInteger(database) || database < 0) throw new Error('REDIS_URL has an invalid database');
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    db: database,
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

function commandJobId(command: MediaCommand, profile: string): string {
  switch (command.type) {
    case 'media.playback.requested':
      return `playback-${command.mediaItemId}-${profile}`;
    case 'archive.scan.requested':
      return `scan-${command.jobId}`;
    case 'media.publication.changed':
      return `publication-${command.mediaItemId}-${command.published ? 'on' : 'off'}-${Date.now()}`;
    case 'package.eviction.requested':
      return `eviction-${command.generationId}`;
    case 'cache.generation.accessed':
      return `cache-access-${command.sessionId}-${command.generationId}`;
  }
}
