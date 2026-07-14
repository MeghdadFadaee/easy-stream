import type { MetadataCandidate } from '@easy-stream/contracts';
import type { ApiConfig } from '../config.js';
import type { MetadataProvider } from '../domain.js';
import { AppError } from '../errors.js';

type Fetch = typeof globalThis.fetch;

interface TmdbListResponse {
  results?: unknown[];
}

export class DisabledMetadataProvider implements MetadataProvider {
  async search(): Promise<MetadataCandidate[]> {
    throw disabledError();
  }

  async getDetails(): Promise<MetadataCandidate> {
    throw disabledError();
  }
}

export class TmdbMetadataProvider implements MetadataProvider {
  constructor(
    private readonly token: string,
    private readonly options: {
      baseUrl: string;
      timeoutMs: number;
      maxRetries: number;
    },
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {}

  async search(input: {
    query: string;
    kind: 'MOVIE' | 'SERIES';
    year?: number;
  }): Promise<MetadataCandidate[]> {
    const mediaPath = input.kind === 'MOVIE' ? 'movie' : 'tv';
    const query: Record<string, string> = {
      query: input.query,
      include_adult: 'false',
      language: 'fa-IR',
    };
    if (input.year !== undefined) {
      query[input.kind === 'MOVIE' ? 'year' : 'first_air_date_year'] = String(input.year);
    }
    let result = await this.request<TmdbListResponse>(`/search/${mediaPath}`, query);
    if (!Array.isArray(result.results) || result.results.length === 0) {
      result = await this.request<TmdbListResponse>(`/search/${mediaPath}`, {
        ...query,
        language: 'en-US',
      });
    }
    return (result.results ?? [])
      .map((entry) => toCandidate(entry, input.kind))
      .filter((entry): entry is MetadataCandidate => Boolean(entry))
      .slice(0, 20);
  }

  async getDetails(input: {
    externalId: number;
    kind: 'MOVIE' | 'SERIES';
  }): Promise<MetadataCandidate> {
    const mediaPath = input.kind === 'MOVIE' ? 'movie' : 'tv';
    const fa = await this.request<unknown>(`/${mediaPath}/${input.externalId}`, {
      language: 'fa-IR',
    });
    const en = await this.request<unknown>(`/${mediaPath}/${input.externalId}`, {
      language: 'en-US',
    });
    const faCandidate = toCandidate(fa, input.kind);
    const enCandidate = toCandidate(en, input.kind);
    if (!faCandidate && !enCandidate) {
      throw new AppError(502, 'MEDIA_UNAVAILABLE', 'TMDB returned invalid title metadata');
    }
    const primary = faCandidate ?? enCandidate!;
    const posterUrl = faCandidate?.posterUrl ?? enCandidate?.posterUrl;
    const backdropUrl = faCandidate?.backdropUrl ?? enCandidate?.backdropUrl;
    return {
      ...primary,
      name: {
        fa: faCandidate?.name.fa || enCandidate?.name.fa || 'بدون عنوان',
        ...(enCandidate?.name.fa ? { en: enCandidate.name.fa } : {}),
      },
      synopsis: {
        ...(faCandidate?.synopsis.fa
          ? { fa: faCandidate.synopsis.fa }
          : enCandidate?.synopsis.fa
            ? { fa: enCandidate.synopsis.fa }
            : {}),
        ...(enCandidate?.synopsis.fa ? { en: enCandidate.synopsis.fa } : {}),
      },
      ...(posterUrl ? { posterUrl } : {}),
      ...(backdropUrl ? { backdropUrl } : {}),
      ...((faCandidate?.year ?? enCandidate?.year) !== undefined
        ? { year: (faCandidate?.year ?? enCandidate?.year)! }
        : {}),
    };
  }

  private async request<T>(path: string, query: Record<string, string>): Promise<T> {
    const url = new URL(`${this.options.baseUrl.replace(/\/$/, '')}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${this.token}`,
          },
          signal: controller.signal,
        });
        if (response.ok) return (await response.json()) as T;
        if ((response.status === 429 || response.status >= 500) && attempt < this.options.maxRetries) {
          await delay(retryDelay(response.headers.get('retry-after'), attempt));
          continue;
        }
        if (response.status === 404) {
          throw new AppError(404, 'NOT_FOUND', 'TMDB title not found');
        }
        throw new AppError(502, 'MEDIA_UNAVAILABLE', `TMDB request failed (${response.status})`);
      } catch (error) {
        lastError = error;
        if (error instanceof AppError) throw error;
        if (attempt >= this.options.maxRetries) break;
        await delay(100 * 2 ** attempt);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new AppError(502, 'MEDIA_UNAVAILABLE', 'TMDB request timed out or was unavailable', {
      cause: lastError instanceof Error ? lastError.message : 'unknown',
    });
  }
}

export function createMetadataProvider(
  config: ApiConfig,
  fetchImpl: Fetch = globalThis.fetch,
): MetadataProvider {
  if (!config.tmdbApiToken || !config.tmdbCommercialLicenseConfirmed) {
    return new DisabledMetadataProvider();
  }
  return new TmdbMetadataProvider(
    config.tmdbApiToken,
    {
      baseUrl: config.tmdbBaseUrl,
      timeoutMs: config.tmdbTimeoutMs,
      maxRetries: config.tmdbMaxRetries,
    },
    fetchImpl,
  );
}

function toCandidate(value: unknown, kind: 'MOVIE' | 'SERIES'): MetadataCandidate | undefined {
  if (!isObject(value) || typeof value.id !== 'number') return undefined;
  const name = string(value[kind === 'MOVIE' ? 'title' : 'name']);
  const originalName = string(value[kind === 'MOVIE' ? 'original_title' : 'original_name']);
  if (!name && !originalName) return undefined;
  const date = string(value[kind === 'MOVIE' ? 'release_date' : 'first_air_date']);
  const year = date && /^[0-9]{4}/.test(date) ? Number(date.slice(0, 4)) : undefined;
  const posterPath = imagePath(value.poster_path);
  const backdropPath = imagePath(value.backdrop_path);
  const overview = string(value.overview);
  return {
    provider: 'TMDB',
    externalId: value.id,
    kind,
    name: {
      fa: name ?? originalName!,
      ...(originalName && originalName !== name ? { en: originalName } : {}),
    },
    synopsis: { ...(overview ? { fa: overview } : {}) },
    ...(posterPath ? { posterUrl: `/images/tmdb/w500${posterPath}` } : {}),
    ...(backdropPath
      ? { backdropUrl: `/images/tmdb/w1280${backdropPath}` }
      : {}),
    ...(year !== undefined ? { year } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function imagePath(value: unknown): string | undefined {
  const path = string(value);
  return path?.startsWith('/') ? path : undefined;
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  if (retryAfter && /^[0-9]+$/.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1000, 2000);
  }
  return 100 * 2 ** attempt;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function disabledError(): AppError {
  return new AppError(
    409,
    'CONFLICT',
    'TMDB is disabled until TMDB_API_TOKEN and TMDB_COMMERCIAL_LICENSE_CONFIRMED=true are configured',
  );
}
