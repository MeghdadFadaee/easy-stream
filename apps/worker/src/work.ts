import {
  CACHE_GENERATION_LEASES_KEY,
  MediaCommandSchema,
  type MediaCommand,
} from '@easy-stream/contracts';
import { Value } from '@sinclair/typebox/value';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';

export const MEDIA_QUEUE_NAME = 'easy-stream-media';

export interface MediaQueueWorkerOptions {
  redisUrl: string;
  concurrency?: number;
  dispatch: (command: MediaCommand, job: Job<MediaCommand>) => Promise<void>;
  onCompleted?: (command: MediaCommand, job: Job<MediaCommand>) => Promise<void>;
  onFailed?: (command: MediaCommand | undefined, error: Error, job: Job<MediaCommand> | undefined) => Promise<void>;
}

export interface RunningMediaWorker {
  worker: Worker<MediaCommand>;
  recordCacheLease(generationId: string, protectedUntil: string): Promise<void>;
  protectedCacheGenerations(now?: Date): Promise<ReadonlySet<string>>;
  close(): Promise<void>;
}

export function startMediaQueueWorker(options: MediaQueueWorkerOptions): RunningMediaWorker {
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new RangeError('Worker concurrency must be between 1 and 32');
  }
  const redisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  } as const;
  const connection = new Redis(options.redisUrl, redisOptions);
  const leases = new Redis(options.redisUrl, redisOptions);
  const worker = new Worker<MediaCommand>(
    MEDIA_QUEUE_NAME,
    async (job) => {
      if (!Value.Check(MediaCommandSchema, job.data)) throw new Error(`Invalid media command in job ${job.id ?? 'unknown'}`);
      await options.dispatch(job.data, job);
      await options.onCompleted?.(job.data, job);
    },
    { connection, concurrency },
  );
  worker.on('failed', (job, error) => {
    void options.onFailed?.(job?.data, error, job);
  });
  worker.on('error', (error) => {
    void options.onFailed?.(undefined, error, undefined);
  });
  return {
    worker,
    async recordCacheLease(generationId, protectedUntil) {
      const expiration = Date.parse(protectedUntil);
      if (!Number.isFinite(expiration)) throw new Error('Invalid cache lease expiration');
      await leases.zadd(CACHE_GENERATION_LEASES_KEY, 'GT', expiration, generationId);
    },
    async protectedCacheGenerations(now = new Date()) {
      const timestamp = now.getTime();
      await leases.zremrangebyscore(CACHE_GENERATION_LEASES_KEY, '-inf', timestamp);
      return new Set(await leases.zrangebyscore(CACHE_GENERATION_LEASES_KEY, timestamp + 1, '+inf'));
    },
    async close() {
      await worker.close();
      await Promise.all([connection.quit(), leases.quit()]);
    },
  };
}
