import { describe, expect, it } from 'vitest';
import { MEDIA_QUEUE_NAME, startMediaQueueWorker } from '../src/work.js';

describe('BullMQ media worker', () => {
  it('uses the API queue name and rejects unsafe concurrency before connecting', () => {
    expect(MEDIA_QUEUE_NAME).toBe('easy-stream-media');
    expect(() => startMediaQueueWorker({
      redisUrl: 'redis://127.0.0.1:1',
      concurrency: 0,
      async dispatch() {},
    })).toThrow('concurrency');
  });
});
