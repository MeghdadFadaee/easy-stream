import type { MetadataCandidate } from '@easy-stream/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type {
  MediaPreparationService,
  MetadataProvider,
  PasswordHasher,
} from '../src/domain.js';
import type { CacheStatusService } from '../src/services/cache-status.js';
import { InMemoryRepository } from '../src/repositories/in-memory.js';
import { InMemoryMediaCommandPublisher } from '../src/services/media-preparation.js';
import { ids, testConfig, titleFixture } from './fixtures.js';

const passwordHasher: PasswordHasher = {
  async hash(password) {
    return `test:${password}`;
  },
  async verify(hash, password) {
    return hash === `test:${password}`;
  },
};

const readyMedia: MediaPreparationService = {
  async prepare() {
    return readyPreparation();
  },
  async getStatus() {
    return readyPreparation();
  },
};

const metadataCandidate: MetadataCandidate = {
  provider: 'TMDB',
  externalId: 42,
  kind: 'SERIES',
  name: { fa: 'عنوان تازه', en: 'Fresh title' },
  synopsis: { fa: 'خلاصه تازه' },
  year: 2026,
};

const metadataProvider: MetadataProvider = {
  async search() {
    return [metadataCandidate];
  },
  async getDetails() {
    return metadataCandidate;
  },
};

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('viewer API', () => {
  it('lists and searches published catalog titles', async () => {
    const app = await makeApp();
    const catalog = await app.inject({ method: 'GET', url: '/api/v1/catalog' });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().items).toEqual([
      expect.objectContaining({ id: ids.title, playable: true }),
    ]);

    const search = await app.inject({ method: 'GET', url: '/api/v1/search?q=Sample' });
    expect(search.statusCode).toBe(200);
    expect(search.json().items[0].slug).toBe('sample-series');

    const detail = await app.inject({ method: 'GET', url: '/api/v1/titles/sample-series' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().mediaItems[0].id).toBe(ids.media);

    const event = await app.inject({
      method: 'POST',
      url: '/api/v1/client-events',
      payload: {
        name: 'playback_started',
        mediaItemId: ids.media,
        occurredAt: '2026-07-14T00:00:00.000Z',
        details: { subtitleDelivery: 'ASS_JASSUB' },
      },
    });
    expect(event.statusCode).toBe(202);
  });

  it('creates a ready session and authorizes only its generation path', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/playback-sessions',
      payload: {
        mediaItemId: ids.media,
        clientCapabilities: capabilities(),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        state: 'READY',
        manifestUrl: `http://localhost:8080/media/generations/${ids.generation}/master.m3u8`,
      }),
    );
    expect(response.json().subtitleTracks[0]).toEqual(
      expect.objectContaining({ assUrl: expect.any(String), vttUrl: expect.any(String) }),
    );
    const setCookie = response.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0];
    expect(cookie).toBeTruthy();

    const allowed = await app.inject({
      method: 'GET',
      url: '/internal/media-auth',
      headers: {
        cookie: cookie!,
        'x-media-auth-secret': testConfig().mediaAuthSharedSecret,
        'x-original-uri': `/media/generations/${ids.generation}/video/segment-00001.m4s`,
      },
    });
    expect(allowed.statusCode).toBe(204);

    const denied = await app.inject({
      method: 'GET',
      url: '/internal/media-auth',
      headers: {
        cookie: cookie!,
        'x-media-auth-secret': testConfig().mediaAuthSharedSecret,
        'x-original-uri': '/media/generations/30000000-0000-4000-8000-000000000002/master.m3u8',
      },
    });
    expect(denied.statusCode).toBe(401);
  });

  it('promotes a playable EVENT package while it is still preparing', async () => {
    const progressive: MediaPreparationService = {
      async prepare() {
        return { ...readyPreparation(), state: 'PREPARING' };
      },
      async getStatus() {
        return { ...readyPreparation(), state: 'PREPARING' };
      },
    };
    const app = await makeApp(progressive);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/playback-sessions',
      payload: { mediaItemId: ids.media, clientCapabilities: capabilities() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe('READY');
  });

  it('scopes durable compatibility media to the derived generation path', async () => {
    const derivedMedia: MediaPreparationService = {
      async prepare() {
        return {
          ...readyPreparation(),
          manifestPath: `/media/derived/generations/${ids.generation}/master.m3u8`,
          subtitleTracks: [
            {
              id: ids.subtitle,
              language: 'fa',
              label: 'فارسی',
              default: true,
              forced: false,
              assUrl: `/media/derived/generations/${ids.generation}/subtitles/fa.ass`,
              vttUrl: `/media/derived/generations/${ids.generation}/subtitles/fa.vtt`,
              fontUrls: [`/media/derived/generations/${ids.generation}/fonts/a.ttf`],
            },
          ],
        };
      },
      async getStatus() {
        throw new Error('not used');
      },
    };
    const app = await makeApp(derivedMedia);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/playback-sessions',
      payload: { mediaItemId: ids.media, clientCapabilities: capabilities() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().manifestUrl).toBe(
      `http://localhost:8080/media/derived/generations/${ids.generation}/master.m3u8`,
    );
    const setCookie = response.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toContain(`Path=/media/derived/generations/${ids.generation}/`);
    const cookie = cookieHeader?.split(';', 1)[0];

    const allowed = await app.inject({
      method: 'GET',
      url: '/internal/media-auth',
      headers: {
        cookie: cookie!,
        'x-media-auth-secret': testConfig().mediaAuthSharedSecret,
        'x-original-uri': `/media/derived/generations/${ids.generation}/fonts/a.ttf`,
      },
    });
    expect(allowed.statusCode).toBe(204);

    const wrongStore = await app.inject({
      method: 'GET',
      url: '/internal/media-auth',
      headers: {
        cookie: cookie!,
        'x-media-auth-secret': testConfig().mediaAuthSharedSecret,
        'x-original-uri': `/media/generations/${ids.generation}/master.m3u8`,
      },
    });
    expect(wrongStore.statusCode).toBe(401);
  });

  it('returns a stable unsupported-client session without enqueueing media', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/playback-sessions',
      payload: {
        mediaItemId: ids.media,
        clientCapabilities: { ...capabilities(), mse: false, hlsJs: false },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({ state: 'UNSUPPORTED_CLIENT', reasonCode: 'HLS_MSE_UNAVAILABLE' }),
    );
  });
});

describe('administrator API', () => {
  it('enforces session and CSRF, enqueues scans, and applies a metadata match', async () => {
    const commands = new InMemoryMediaCommandPublisher();
    const cacheStatus: CacheStatusService = {
      async getStatus() {
        return {
          usedBytes: 321,
          maxBytes: 1_000,
          highWatermark: 0.85,
          lowWatermark: 0.75,
          activePackages: 2,
        };
      },
    };
    const app = await makeApp(readyMedia, commands, cacheStatus);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/login',
      payload: { email: 'admin@example.com', password: 'a-good-test-password' },
    });
    expect(login.statusCode).toBe(200);
    const csrf = login.json().csrfToken as string;
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';', 1)[0];

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/scans',
      headers: { cookie: cookie! },
      payload: { full: false },
    });
    expect(blocked.statusCode).toBe(403);

    const scan = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/scans',
      headers: { cookie: cookie!, 'x-csrf-token': csrf },
      payload: { full: true },
    });
    expect(scan.statusCode).toBe(202);
    expect(commands.commands).toContainEqual(
      expect.objectContaining({ type: 'archive.scan.requested', full: true }),
    );

    const match = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/titles/${ids.title}/metadata-match`,
      headers: { cookie: cookie!, 'x-csrf-token': csrf },
      payload: { provider: 'TMDB', externalId: 42, kind: 'SERIES' },
    });
    expect(match.statusCode).toBe(200);
    const detail = await app.inject({ method: 'GET', url: '/api/v1/titles/sample-series' });
    expect(detail.json().name.fa).toBe('عنوان تازه');

    const cache = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/cache',
      headers: { cookie: cookie! },
    });
    expect(cache.statusCode).toBe(200);
    expect(cache.json()).toEqual(expect.objectContaining({ usedBytes: 321, activePackages: 2 }));
  });
});

async function makeApp(
  media: MediaPreparationService = readyMedia,
  commands = new InMemoryMediaCommandPublisher(),
  cacheStatus?: CacheStatusService,
) {
  const app = await buildApp({
    config: testConfig(),
    repository: new InMemoryRepository({ titles: [titleFixture] }),
    mediaPreparation: media,
    commandPublisher: commands,
    metadataProvider,
    passwordHasher,
    ...(cacheStatus === undefined ? {} : { cacheStatus }),
    logger: false,
  });
  apps.push(app);
  return app;
}

function capabilities() {
  return {
    mse: true,
    nativeHls: false,
    hlsJs: true,
    assRenderer: true,
    supportedCodecs: ['avc1.64001f', 'mp4a.40.2'],
  };
}

function readyPreparation() {
  return {
    state: 'READY' as const,
    playable: true,
    generationId: ids.generation,
    manifestPath: `/media/generations/${ids.generation}/master.m3u8`,
    durationSeconds: 1420,
    audioTracks: [
      { id: ids.audio, language: 'ja', label: '日本語', default: true },
    ],
    subtitleTracks: [
      {
        id: ids.subtitle,
        language: 'fa',
        label: 'فارسی',
        default: true,
        forced: false,
        assUrl: `/media/generations/${ids.generation}/subtitles/fa.ass`,
        vttUrl: `/media/generations/${ids.generation}/subtitles/fa.vtt`,
        fontUrls: [`/media/generations/${ids.generation}/fonts/a.ttf`],
      },
    ],
  };
}
