import { readFile } from 'node:fs/promises';
import {
  CatalogSnapshotSchema,
  type CacheStatus,
  type CatalogQuery,
  type CatalogSnapshot,
  type Job,
  type MetadataCandidate,
  type SearchQuery,
  type TitleDetail,
} from '@easy-stream/contracts';
import { Value } from '@sinclair/typebox/value';
import type {
  AdminRecord,
  AppRepository,
  MediaItemForPlayback,
  StoredAdminSession,
  StoredPlaybackSession,
} from '../domain.js';

interface InMemoryRepositoryOptions {
  titles?: TitleDetail[];
  cache?: Partial<CacheStatus>;
}

export class InMemoryRepository implements AppRepository {
  private readonly titles = new Map<string, TitleDetail>();
  private readonly playbackSessions = new Map<string, StoredPlaybackSession>();
  private readonly admins = new Map<string, AdminRecord>();
  private readonly adminSessions = new Map<string, StoredAdminSession>();
  private readonly jobs = new Map<string, { job: Job; payload: Record<string, unknown> }>();
  private readonly cache: CacheStatus;

  constructor(options: InMemoryRepositoryOptions = {}) {
    for (const title of options.titles ?? []) this.titles.set(title.id, structuredClone(title));
    this.cache = {
      usedBytes: options.cache?.usedBytes ?? 0,
      maxBytes: options.cache?.maxBytes ?? 2_147_483_648_000,
      highWatermark: options.cache?.highWatermark ?? 0.85,
      lowWatermark: options.cache?.lowWatermark ?? 0.75,
      activePackages: options.cache?.activePackages ?? 0,
    };
  }

  replaceCatalog(titles: TitleDetail[]): void {
    this.titles.clear();
    for (const title of titles) this.titles.set(title.id, structuredClone(title));
  }

  async listCatalog(query: CatalogQuery) {
    const limit = query.limit ?? 24;
    const published = [...this.titles.values()]
      .filter((title) => title.mediaItems.some((item) => item.published))
      .filter((title) => !query.kind || title.kind === query.kind)
      .filter((title) => !query.category || (title.categorySlug ?? 'other') === query.category)
      .filter((title) => !query.year || title.year === query.year)
      .filter((title) => !query.releaseWindow || title.releaseWindow === query.releaseWindow)
      .sort((left, right) => left.slug.localeCompare(right.slug));
    const cursorId = decodeCursor(query.cursor);
    const start = cursorId ? Math.max(0, published.findIndex((title) => title.id === cursorId) + 1) : 0;
    const page = published.slice(start, start + limit);
    const next = published[start + limit];
    return {
      items: page.map(toCard),
      ...(next && page.at(-1) ? { nextCursor: encodeCursor(page.at(-1)!.id) } : {}),
    };
  }

  async listCatalogSections(limitPerSection: number) {
    const groups = new Map<string, TitleDetail[]>();
    for (const title of this.titles.values()) {
      if (!title.mediaItems.some((item) => item.published)) continue;
      const categorySlug = title.categorySlug ?? 'other';
      const group = groups.get(categorySlug) ?? [];
      group.push(title);
      groups.set(categorySlug, group);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([slug, titles]) => ({
      slug,
      name: titles[0]?.category ?? 'Other',
      items: titles.slice(0, limitPerSection).map(toCard),
      hasMore: titles.length > limitPerSection,
    }));
  }

  async searchTitles(query: SearchQuery) {
    const needle = normalizeSearch(query.q);
    const limit = query.limit ?? 20;
    return [...this.titles.values()]
      .filter((title) => title.mediaItems.some((item) => item.published))
      .filter((title) =>
        [title.name.fa, title.name.en]
          .filter((value): value is string => Boolean(value))
          .some((value) => normalizeSearch(value).includes(needle)),
      )
      .slice(0, limit)
      .map(toCard);
  }

  async getTitleBySlug(slug: string): Promise<TitleDetail | undefined> {
    const title = [...this.titles.values()].find(
      (candidate) => candidate.slug === slug && candidate.mediaItems.some((item) => item.published),
    );
    return title ? publicTitle(title) : undefined;
  }

  async getMediaItem(id: string): Promise<MediaItemForPlayback | undefined> {
    for (const title of this.titles.values()) {
      const item = title.mediaItems.find((candidate) => candidate.id === id);
      if (item) {
        return {
          id: item.id,
          titleId: title.id,
          durationSeconds: item.durationSeconds,
          compatibility: item.compatibility,
          published: item.published,
          variants: (item.variants ?? []).map((variant) => ({
            id: variant.id,
            label: variant.label,
            ...(variant.height ? { height: variant.height } : {}),
            compatibility: variant.compatibility,
            available: variant.available,
            isDefault: variant.isDefault,
          })),
        };
      }
    }
    return undefined;
  }

  async setMediaPublished(mediaItemId: string, published: boolean): Promise<boolean> {
    for (const [titleId, title] of this.titles) {
      const index = title.mediaItems.findIndex((item) => item.id === mediaItemId);
      if (index < 0) continue;
      const existing = title.mediaItems[index];
      if (!existing) return false;
      const mediaItems = [...title.mediaItems];
      mediaItems[index] = { ...existing, published };
      this.titles.set(titleId, {
        ...title,
        playable: mediaItems.some((item) => item.published),
        mediaItems,
        updatedAt: new Date().toISOString(),
      });
      return true;
    }
    return false;
  }

  async applyTitleMetadata(titleId: string, metadata: MetadataCandidate): Promise<boolean> {
    const title = this.titles.get(titleId);
    if (!title || title.kind !== metadata.kind) return false;
    const {
      posterUrl: _posterUrl,
      backdropUrl: _backdropUrl,
      year: _year,
      name: _name,
      synopsis: _synopsis,
      ...unchanged
    } = title;
    this.titles.set(titleId, {
      ...unchanged,
      name: structuredClone(metadata.name),
      synopsis: structuredClone(metadata.synopsis),
      ...(metadata.posterUrl ? { posterUrl: metadata.posterUrl } : {}),
      ...(metadata.backdropUrl ? { backdropUrl: metadata.backdropUrl } : {}),
      ...(metadata.year !== undefined ? { year: metadata.year } : {}),
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  async createPlaybackSession(session: StoredPlaybackSession): Promise<void> {
    this.playbackSessions.set(session.id, structuredClone(session));
  }

  async getPlaybackSession(id: string): Promise<StoredPlaybackSession | undefined> {
    const session = this.playbackSessions.get(id);
    return session ? structuredClone(session) : undefined;
  }

  async updatePlaybackSession(session: StoredPlaybackSession): Promise<void> {
    this.playbackSessions.set(session.id, structuredClone(session));
  }

  async findAdminByEmail(email: string): Promise<AdminRecord | undefined> {
    const normalized = email.trim().toLowerCase();
    const record = [...this.admins.values()].find((admin) => admin.email === normalized);
    return record ? structuredClone(record) : undefined;
  }

  async findAdminById(id: string): Promise<AdminRecord | undefined> {
    const record = this.admins.get(id);
    return record ? structuredClone(record) : undefined;
  }

  async createAdmin(admin: AdminRecord): Promise<void> {
    const normalized = admin.email.trim().toLowerCase();
    if ([...this.admins.values()].some((entry) => entry.email === normalized)) return;
    this.admins.set(admin.id, { ...structuredClone(admin), email: normalized });
  }

  async createAdminSession(session: StoredAdminSession): Promise<void> {
    this.adminSessions.set(session.id, structuredClone(session));
  }

  async findAdminSessionByTokenHash(tokenHash: string): Promise<StoredAdminSession | undefined> {
    const session = [...this.adminSessions.values()].find((entry) => entry.tokenHash === tokenHash);
    return session ? structuredClone(session) : undefined;
  }

  async revokeAdminSession(id: string): Promise<void> {
    const session = this.adminSessions.get(id);
    if (session) this.adminSessions.set(id, { ...session, revokedAt: new Date().toISOString() });
  }

  async createJob(job: Job, payload: Record<string, unknown>): Promise<void> {
    this.jobs.set(job.id, { job: structuredClone(job), payload: structuredClone(payload) });
  }

  async listJobs(): Promise<Job[]> {
    return [...this.jobs.values()]
      .map(({ job }) => structuredClone(job))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async findJob(id: string): Promise<Job | undefined> {
    const entry = this.jobs.get(id);
    return entry ? structuredClone(entry.job) : undefined;
  }

  async retryJob(id: string): Promise<Job | undefined> {
    const entry = this.jobs.get(id);
    if (!entry || (entry.job.state !== 'FAILED' && entry.job.state !== 'CANCELLED')) return undefined;
    const now = new Date().toISOString();
    const job: Job = { ...entry.job, state: 'QUEUED', progress: 0, error: null, updatedAt: now };
    this.jobs.set(id, { ...entry, job });
    return structuredClone(job);
  }

  async getCacheStatus(): Promise<CacheStatus> {
    return structuredClone(this.cache);
  }
}

export async function loadCatalogSnapshot(path: string): Promise<CatalogSnapshot | undefined> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(source);
  if (!Value.Check(CatalogSnapshotSchema, parsed)) {
    const errors = [...Value.Errors(CatalogSnapshotSchema, parsed)]
      .map((error) => `${error.path || '/'} ${error.message}`)
      .join('; ');
    throw new Error(`Invalid catalog snapshot at ${path}: ${errors}`);
  }
  return parsed;
}

function toCard(title: TitleDetail) {
  const { synopsis: _synopsis, seasons: _seasons, mediaItems: _mediaItems, updatedAt: _updatedAt, ...card } =
    title;
  return card;
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('fa-IR');
}

function publicTitle(title: TitleDetail): TitleDetail {
  const mediaItems = title.mediaItems.filter((item) => item.published);
  const { seasons: _seasons, resumeMediaItemId: _resumeMediaItemId, ...base } = title;
  const seasonNumbers = [...new Set(mediaItems.map((item) => item.seasonNumber))].filter(
    (value): value is number => value !== undefined,
  );
  return structuredClone({
    ...base,
    playable: mediaItems.length > 0,
    ...(mediaItems[0] ? { resumeMediaItemId: mediaItems[0].id } : {}),
    ...(seasonNumbers.length
      ? {
          seasons: seasonNumbers.map((number) => ({
            number,
            episodeCount: mediaItems.filter((item) => item.seasonNumber === number).length,
          })),
        }
      : {}),
    mediaItems,
  });
}

function encodeCursor(id: string): string {
  return Buffer.from(JSON.stringify({ id })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { id?: unknown };
    return typeof value.id === 'string' ? value.id : undefined;
  } catch {
    return undefined;
  }
}
