import { describe, expect, it, vi } from 'vitest';
import { TmdbMetadataProvider } from '../src/services/tmdb.js';

describe('TmdbMetadataProvider', () => {
  it('falls back from Persian search to English and sends a bearer token', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(
        Response.json({
          results: [
            {
              id: 42,
              name: 'Sample Series',
              original_name: 'Sample Series',
              overview: 'Overview',
              first_air_date: '2026-01-02',
              poster_path: '/sample-poster.jpg',
              backdrop_path: '/sample-backdrop.jpg',
            },
          ],
        }),
      );
    const provider = new TmdbMetadataProvider(
      'secret-token',
      { baseUrl: 'https://api.themoviedb.org/3', timeoutMs: 1000, maxRetries: 0 },
      fetch,
    );

    const result = await provider.search({ query: 'Sample', kind: 'SERIES' });
    expect(result[0]).toEqual(expect.objectContaining({
      externalId: 42,
      year: 2026,
      posterUrl: '/images/tmdb/w500/sample-poster.jpg',
      backdropUrl: '/images/tmdb/w1280/sample-backdrop.jpg',
    }));
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('language')).toBe('fa-IR');
    expect(new URL(String(fetch.mock.calls[1]?.[0])).searchParams.get('language')).toBe('en-US');
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual(
      expect.objectContaining({ authorization: 'Bearer secret-token' }),
    );
  });

  it('merges Persian and English detail responses', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: 42, title: 'عنوان فارسی', overview: 'خلاصه', release_date: '2025-01-01' }),
      )
      .mockResolvedValueOnce(
        Response.json({ id: 42, title: 'English title', overview: 'Synopsis', release_date: '2025-01-01' }),
      );
    const provider = new TmdbMetadataProvider(
      'token',
      { baseUrl: 'https://api.themoviedb.org/3', timeoutMs: 1000, maxRetries: 0 },
      fetch,
    );
    const result = await provider.getDetails({ externalId: 42, kind: 'MOVIE' });
    expect(result.name).toEqual({ fa: 'عنوان فارسی', en: 'English title' });
    expect(result.synopsis).toEqual({ fa: 'خلاصه', en: 'Synopsis' });
  });

  it('retries transient upstream failures', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(Response.json({ results: [] }));
    const provider = new TmdbMetadataProvider(
      'token',
      { baseUrl: 'https://api.themoviedb.org/3', timeoutMs: 1000, maxRetries: 1 },
      fetch,
    );
    await expect(provider.search({ query: 'x', kind: 'MOVIE' })).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
