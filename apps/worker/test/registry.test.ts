import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PackageRegistrySchema } from '@easy-stream/contracts';
import { Value } from '@sinclair/typebox/value';
import {
  normalizeTrackLabel,
  readRegistry,
  removeGenerationFromRegistry,
  updateRegistry,
} from '../src/registry.js';

describe('local generation registry', () => {
  it('keeps independent generations for quality variants of one episode', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-registry-variants-'));
    const registryPath = path.join(directory, 'package-registry.json');
    const mediaItemId = '11111111-1111-4111-8111-111111111111';
    for (const [variantId, generationId] of [
      ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'],
      ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'],
    ] as const) {
      await updateRegistry(registryPath, mediaItemId, {
        mediaItemId, variantId, generationId, state: 'READY', playable: true,
        manifestPath: `/media/generations/${generationId}/master.m3u8`,
      });
    }
    expect((await readRegistry(registryPath)).packages).toHaveLength(2);
  });

  it('atomically records API-loadable per-media status', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-registry-'));
    const registryPath = path.join(directory, 'package-registry.json');
    const mediaItemId = '11111111-1111-4111-8111-111111111111';
    const generationId = '22222222-2222-4222-8222-222222222222';
    await updateRegistry(registryPath, mediaItemId, {
      mediaItemId, generationId, state: 'READY', playable: true,
      manifestPath: `/media/generations/${generationId}/master.m3u8`,
    });
    const registry = await readRegistry(registryPath);
    expect(registry.packages[0]).toMatchObject({ state: 'READY', playable: true });
    expect(Value.Check(PackageRegistrySchema, registry)).toBe(true);
    expect(JSON.parse(await readFile(registryPath, 'utf8'))).toMatchObject({ version: 1 });
    await updateRegistry(registryPath, mediaItemId, {
      mediaItemId, generationId, state: 'PREPARING', playable: false,
    });
    expect((await readRegistry(registryPath)).packages[0]).toMatchObject({
      state: 'READY', playable: true, manifestPath: `/media/generations/${generationId}/master.m3u8`,
    });
    expect(await removeGenerationFromRegistry(registryPath, generationId)).toBe(true);
    expect((await readRegistry(registryPath)).packages).toEqual([]);
  });

  it('normalizes oversized and control-character container labels for the API contract', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-registry-label-'));
    const registryPath = path.join(directory, 'package-registry.json');
    const mediaItemId = '11111111-1111-4111-8111-111111111111';
    const generationId = '22222222-2222-4222-8222-222222222222';
    const rawMkvTitle = `  Persian\u0000\n\tAudio\u202e ${'x'.repeat(180)}  `;
    const label = normalizeTrackLabel(rawMkvTitle, 'fa');

    expect(label.length).toBeLessThanOrEqual(100);
    expect(label).toBe(`Persian Audio ${'x'.repeat(86)}`);
    expect(label).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);

    await updateRegistry(registryPath, mediaItemId, {
      mediaItemId,
      generationId,
      state: 'READY',
      playable: true,
      manifestPath: `/media/generations/${generationId}/master.m3u8`,
      audioTracks: [{
        id: '33333333-3333-4333-8333-333333333333',
        language: 'fa',
        label,
        default: true,
      }],
    });

    const registry = await readRegistry(registryPath);
    expect(Value.Check(PackageRegistrySchema, registry)).toBe(true);
    expect(registry.packages[0]?.audioTracks?.[0]?.label).toBe(label);
  });

  it('rejects an invalid update before replacing a valid registry file', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-registry-invalid-'));
    const registryPath = path.join(directory, 'package-registry.json');
    const mediaItemId = '11111111-1111-4111-8111-111111111111';
    const generationId = '22222222-2222-4222-8222-222222222222';
    await updateRegistry(registryPath, mediaItemId, {
      mediaItemId,
      generationId,
      state: 'READY',
      playable: true,
      manifestPath: `/media/generations/${generationId}/master.m3u8`,
    });
    const before = await readFile(registryPath, 'utf8');

    await expect(updateRegistry(registryPath, mediaItemId, {
      mediaItemId,
      generationId,
      state: 'READY',
      playable: true,
      manifestPath: `/media/generations/${generationId}/master.m3u8`,
      audioTracks: [{
        id: '33333333-3333-4333-8333-333333333333',
        language: 'en',
        label: 'x'.repeat(101),
        default: true,
      }],
    })).rejects.toThrow(/Refusing to publish invalid package registry/u);

    expect(await readFile(registryPath, 'utf8')).toBe(before);
    expect(Value.Check(PackageRegistrySchema, await readRegistry(registryPath))).toBe(true);
  });
});
