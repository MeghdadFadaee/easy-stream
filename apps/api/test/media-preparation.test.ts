import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileMediaPreparationService,
  InMemoryMediaCommandPublisher,
} from '../src/services/media-preparation.js';
import { ids } from './fixtures.js';

describe('file media preparation cache access', () => {
  it('records a cache lease through the playback session expiry', async () => {
    const registry = await readyRegistry(`/media/generations/${ids.generation}/master.m3u8`);
    const commands = new InMemoryMediaCommandPublisher();
    const service = new FileMediaPreparationService(registry, commands);
    const protectedUntil = '2026-07-14T14:00:00.000Z';
    const result = await service.prepare({
      sessionId: ids.title,
      mediaItem: mediaItem(),
      capabilities: capabilities(),
      protectUntil: protectedUntil,
    });
    expect(result.state).toBe('READY');
    expect(commands.commands).toEqual([
      expect.objectContaining({
        type: 'cache.generation.accessed',
        generationId: ids.generation,
        protectedUntil,
      }),
    ]);
  });

  it('does not put durable derived generations in the disposable cache lifecycle', async () => {
    const registry = await readyRegistry(`/media/derived/generations/${ids.generation}/master.m3u8`);
    const commands = new InMemoryMediaCommandPublisher();
    const service = new FileMediaPreparationService(registry, commands);
    await service.prepare({
      sessionId: ids.title,
      mediaItem: mediaItem(),
      capabilities: capabilities(),
      protectUntil: '2026-07-14T14:00:00.000Z',
    });
    expect(commands.commands).toEqual([]);
  });
});

async function readyRegistry(manifestPath: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-api-registry-'));
  const registry = path.join(directory, 'registry.json');
  await writeFile(registry, JSON.stringify({
    version: 1,
    updatedAt: '2026-07-14T10:00:00.000Z',
    packages: [{
      mediaItemId: ids.media,
      state: 'READY',
      playable: true,
      generationId: ids.generation,
      manifestPath,
    }],
  }));
  return registry;
}

function mediaItem() {
  return {
    id: ids.media,
    titleId: ids.title,
    durationSeconds: 100,
    compatibility: 'COPY' as const,
    published: true,
    variants: [],
  };
}

function capabilities() {
  return {
    mse: true,
    nativeHls: false,
    hlsJs: true,
    assRenderer: true,
    supportedCodecs: ['avc1.64001f'],
  };
}
