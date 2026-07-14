import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('loads a secure in-memory development configuration', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      PLAYBACK_SIGNING_SECRET: 'this-is-a-development-secret-with-32-chars',
    });
    expect(config.repositoryDriver).toBe('memory');
    expect(config.catalogSnapshotPath).toBe('./data/catalog.json');
    expect(config.cacheRoot).toBe('./data/cache');
    expect(config.cacheLowWatermark).toBeLessThan(config.cacheHighWatermark);
  });

  it('accepts an explicit read-only cache root', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      CACHE_ROOT: '/srv/easy-stream/cache',
      PLAYBACK_SIGNING_SECRET: 'this-is-a-development-secret-with-32-chars',
    });
    expect(config.cacheRoot).toBe('/srv/easy-stream/cache');
  });

  it('rejects short signing secrets', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', PLAYBACK_SIGNING_SECRET: 'short' }),
    ).toThrow(/playbackSigningSecret/);
  });

  it('requires a database URL for PostgreSQL', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        REPOSITORY_DRIVER: 'postgres',
        PLAYBACK_SIGNING_SECRET: 'this-is-a-development-secret-with-32-chars',
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it('accepts only a base64url-safe media auth secret', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        PLAYBACK_SIGNING_SECRET: 'this-is-a-development-secret-with-32-chars',
        MEDIA_AUTH_SHARED_SECRET: 'invalid-secret-with-a-quote-"-inside',
      }),
    ).toThrow(/mediaAuthSharedSecret/);
  });

  it('requires the web, API, and media URLs to remain same-origin in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://easy-stream:test@postgres/easy-stream',
        WEB_ORIGIN: 'https://watch.example.com',
        PUBLIC_ORIGIN: 'https://watch.example.com',
        MEDIA_PUBLIC_BASE_URL: 'https://media.example.com/media',
        PLAYBACK_SIGNING_SECRET: 'production-playback-signing-secret-000000000',
        MEDIA_AUTH_SHARED_SECRET: 'production_media_auth_secret_11111111111',
      }),
    ).toThrow(/must use one origin/);
  });

  it('requires the canonical media base path', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        PLAYBACK_SIGNING_SECRET: 'this-is-a-development-secret-with-32-chars',
        MEDIA_PUBLIC_BASE_URL: 'http://localhost:8080/not-media',
      }),
    ).toThrow(/\/media path/);
  });
});
