import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { CreatePlaybackSessionSchema, MediaCommandSchema } from '../src/index.js';

describe('public contracts', () => {
  it('accepts a valid browser capability report', () => {
    expect(
      Value.Check(CreatePlaybackSessionSchema, {
        mediaItemId: '00000000-0000-4000-8000-000000000001',
        variantId: '00000000-0000-4000-8000-000000000003',
        clientCapabilities: {
          mse: true,
          nativeHls: false,
          hlsJs: true,
          assRenderer: true,
          supportedCodecs: ['avc1.64001f', 'mp4a.40.2'],
        },
      }),
    ).toBe(true);
  });

  it('keeps worker commands discriminated and closed', () => {
    expect(
      Value.Check(MediaCommandSchema, {
        type: 'archive.scan.requested',
        jobId: '00000000-0000-4000-8000-000000000002',
        full: false,
        unexpected: true,
      }),
    ).toBe(false);
    expect(Value.Check(MediaCommandSchema, {
      type: 'cache.generation.accessed',
      sessionId: '00000000-0000-4000-8000-000000000001',
      generationId: '00000000-0000-4000-8000-000000000002',
      accessedAt: '2026-07-14T10:00:00.000Z',
      protectedUntil: '2026-07-14T14:00:00.000Z',
    })).toBe(true);
  });
});
