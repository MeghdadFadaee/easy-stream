import { beforeEach, describe, expect, it, vi } from 'vitest'

const snapshot = {
  version: 1,
  generatedAt: '2026-07-15T00:00:00.000Z',
  sections: [{
    slug: 'anime', name: 'Anime', hasMore: false,
    items: [{ id: 'title-1', slug: 'demo', kind: 'MOVIE', name: { fa: 'دمو', en: 'Demo' }, playable: true, resumeMediaItemId: 'media-1', variants: [{ id: 'variant-1', label: '720p', available: true, isDefault: true, compatibility: 'COPY' }] }],
  }],
  titles: [{
    id: 'title-1', slug: 'demo', kind: 'MOVIE', name: { fa: 'دمو', en: 'Demo' }, playable: true,
    resumeMediaItemId: 'media-1', variants: [{ id: 'variant-1', label: '720p', available: true, isDefault: true, compatibility: 'COPY' }],
    mediaItems: [{ id: 'media-1', kind: 'MOVIE', name: { fa: 'دمو', en: 'Demo' }, published: true, variants: [{ id: 'variant-1', label: '720p', available: true, isDefault: true, compatibility: 'COPY' }] }],
  }],
  defaultVariantByMedia: { 'media-1': 'variant-1' },
  playbackByVariant: {
    'variant-1': { mediaItemId: 'media-1', variantId: 'variant-1', qualityLabel: '720p', manifestUrl: './media/master.m3u8', durationSeconds: 60, audioTracks: [], subtitleTracks: [] },
  },
}

describe('static showcase API', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_APP_EDITION', 'showcase')
    vi.stubEnv('VITE_SHOWCASE_CATALOG_URL', './catalog.json')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(snapshot), { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('crypto', { randomUUID: () => 'session-1' })
  })

  it('serves catalog and playback entirely from the static snapshot', async () => {
    const { api } = await import('@/api/client')
    const sections = await api.catalogSections()
    expect(sections[0]?.items[0]).toMatchObject({ slug: 'demo', mediaItemId: 'media-1' })
    const detail = await api.title('demo')
    expect(detail.playableMediaItemId).toBe('media-1')
    const session = await api.createPlaybackSession('media-1', {
      nativeHls: false, mse: true, hlsJs: true, assRenderer: true, supportedCodecs: ['avc1', 'mp4a'],
    })
    expect(session).toMatchObject({ id: 'session-1', state: 'READY', manifestUrl: './media/master.m3u8' })
    expect(await api.playbackSession('session-1')).toEqual(session)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
});
