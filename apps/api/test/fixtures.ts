import type { ApiConfig } from '../src/config.js';
import type { TitleDetail } from '@easy-stream/contracts';

export const ids = {
  title: '10000000-0000-4000-8000-000000000001',
  media: '20000000-0000-4000-8000-000000000001',
  generation: '30000000-0000-4000-8000-000000000001',
  audio: '40000000-0000-4000-8000-000000000001',
  subtitle: '50000000-0000-4000-8000-000000000001',
  variant: '60000000-0000-4000-8000-000000000001',
};

export const titleFixture: TitleDetail = {
  id: ids.title,
  slug: 'sample-series',
  kind: 'SERIES',
  name: { fa: 'سریال نمونه', en: 'Sample Series' },
  synopsis: { fa: 'خلاصه نمونه', en: 'Sample synopsis' },
  playable: true,
  category: 'Anime',
  categorySlug: 'anime',
  releaseWindow: 'SUMMER',
  year: 2026,
  variants: [{ id: ids.variant, label: '720p', width: 1280, height: 720, videoCodec: 'h264', compatibility: 'COPY', available: true, isDefault: true }],
  resumeMediaItemId: ids.media,
  seasons: [{ number: 1, episodeCount: 1 }],
  mediaItems: [
    {
      id: ids.media,
      kind: 'EPISODE',
      seasonNumber: 1,
      episodeNumber: 1,
      name: { fa: 'قسمت یک', en: 'Episode One' },
      durationSeconds: 1420,
      compatibility: 'COPY',
      published: true,
      variants: [{ id: ids.variant, label: '720p', width: 1280, height: 720, videoCodec: 'h264', compatibility: 'COPY', available: true, isDefault: true }],
    },
  ],
  updatedAt: '2026-07-14T00:00:00.000Z',
};

export function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 3000,
    webOrigin: 'http://localhost:5173',
    publicOrigin: 'http://localhost:8080',
    mediaPublicBaseUrl: 'http://localhost:8080/media',
    repositoryDriver: 'memory',
    catalogSnapshotPath: '/tmp/easy-stream-test-catalog-does-not-exist.json',
    packageRegistryPath: '/tmp/easy-stream-test-registry-does-not-exist.json',
    mediaCommandsPath: '/tmp/easy-stream-test-commands.jsonl',
    cacheRoot: '/tmp/easy-stream-test-cache-does-not-exist',
    playbackProfile: 'cmaf-v1',
    playbackSigningSecret: 'playback-signing-secret-that-is-long-enough',
    mediaAuthSharedSecret: 'media-auth-shared-secret-that-is-long-enough',
    playbackTtlSeconds: 14_400,
    adminSessionTtlSeconds: 28_800,
    adminBootstrapEmail: 'admin@example.com',
    adminBootstrapPassword: 'a-good-test-password',
    tmdbCommercialLicenseConfirmed: false,
    tmdbBaseUrl: 'https://api.themoviedb.org/3',
    tmdbTimeoutMs: 1000,
    tmdbMaxRetries: 1,
    cacheMaxBytes: 2_000_000,
    cacheHighWatermark: 0.85,
    cacheLowWatermark: 0.75,
    ...overrides,
  };
}
