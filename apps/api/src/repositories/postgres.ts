import type {
  CacheStatus,
  CatalogCard,
  CatalogQuery,
  Job,
  MetadataCandidate,
  SearchQuery,
  TitleDetail,
} from '@easy-stream/contracts';
import {
  adminSessions,
  admins,
  jobs,
  mediaItems,
  mediaPackages,
  playbackSessions,
  titles,
  type Database,
} from '@easy-stream/database';
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type {
  AdminRecord,
  AppRepository,
  MediaItemForPlayback,
  StoredAdminSession,
  StoredPlaybackSession,
} from '../domain.js';

interface PostgresRepositoryOptions {
  cacheMaxBytes: number;
  cacheHighWatermark: number;
  cacheLowWatermark: number;
}

export class PostgresRepository implements AppRepository {
  constructor(
    private readonly db: Database,
    private readonly options: PostgresRepositoryOptions,
  ) {}

  async listCatalog(query: CatalogQuery) {
    const limit = query.limit ?? 24;
    const offset = decodeOffset(query.cursor);
    const rows = await this.db
      .select()
      .from(titles)
      .where(and(eq(titles.published, true), query.kind ? eq(titles.kind, query.kind) : undefined))
      .orderBy(asc(titles.slug), asc(titles.id))
      .limit(limit + 1)
      .offset(offset);
    const visible = rows.slice(0, limit);
    const cards = await this.cardsForRows(visible);
    return {
      items: cards,
      ...(rows.length > limit ? { nextCursor: encodeOffset(offset + limit) } : {}),
    };
  }

  async searchTitles(query: SearchQuery): Promise<CatalogCard[]> {
    const needle = `%${query.q.trim().replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    const rows = await this.db
      .select()
      .from(titles)
      .where(
        and(
          eq(titles.published, true),
          or(ilike(titles.nameFa, needle), ilike(titles.nameEn, needle)),
        ),
      )
      .orderBy(asc(titles.slug))
      .limit(query.limit ?? 20);
    return this.cardsForRows(rows);
  }

  async getTitleBySlug(slug: string): Promise<TitleDetail | undefined> {
    const [title] = await this.db
      .select()
      .from(titles)
      .where(and(eq(titles.slug, slug), eq(titles.published, true)))
      .limit(1);
    if (!title) return undefined;
    const media = await this.db
      .select()
      .from(mediaItems)
      .where(and(eq(mediaItems.titleId, title.id), eq(mediaItems.published, true)))
      .orderBy(asc(mediaItems.seasonNumber), asc(mediaItems.episodeNumber), asc(mediaItems.id));
    return toTitleDetail(title, media);
  }

  async getMediaItem(id: string): Promise<MediaItemForPlayback | undefined> {
    const [row] = await this.db
      .select({ media: mediaItems, titlePublished: titles.published })
      .from(mediaItems)
      .innerJoin(titles, eq(mediaItems.titleId, titles.id))
      .where(eq(mediaItems.id, id))
      .limit(1);
    if (!row) return undefined;
    return {
      id: row.media.id,
      titleId: row.media.titleId,
      durationSeconds: row.media.durationSeconds ?? 0,
      compatibility: row.media.compatibility,
      published: row.media.published && row.titlePublished,
    };
  }

  async setMediaPublished(mediaItemId: string, published: boolean): Promise<boolean> {
    return this.db.transaction(async (transaction) => {
      const [media] = await transaction
        .update(mediaItems)
        .set({
          published,
          publishedAt: published ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(mediaItems.id, mediaItemId))
        .returning({ titleId: mediaItems.titleId });
      if (!media) return false;
      const [countRow] = await transaction
        .select({ count: sql<number>`count(*)::int` })
        .from(mediaItems)
        .where(and(eq(mediaItems.titleId, media.titleId), eq(mediaItems.published, true)));
      const titlePublished = (countRow?.count ?? 0) > 0;
      await transaction
        .update(titles)
        .set({
          published: titlePublished,
          publishedAt: titlePublished ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(titles.id, media.titleId));
      return true;
    });
  }

  async applyTitleMetadata(titleId: string, metadata: MetadataCandidate): Promise<boolean> {
    const [title] = await this.db
      .update(titles)
      .set({
        tmdbId: metadata.externalId,
        nameFa: metadata.name.fa,
        nameEn: metadata.name.en ?? null,
        synopsisFa: metadata.synopsis.fa ?? null,
        synopsisEn: metadata.synopsis.en ?? null,
        posterUrl: metadata.posterUrl ?? null,
        backdropUrl: metadata.backdropUrl ?? null,
        releaseYear: metadata.year ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(titles.id, titleId), eq(titles.kind, metadata.kind)))
      .returning({ id: titles.id });
    return Boolean(title);
  }

  async createPlaybackSession(session: StoredPlaybackSession): Promise<void> {
    await this.db.insert(playbackSessions).values({
      id: session.id,
      mediaItemId: session.mediaItemId,
      ...(session.generationId ? { generationId: session.generationId } : {}),
      state: session.state,
      capabilities: session.capabilities,
      ...(session.reasonCode ? { reasonCode: session.reasonCode } : {}),
      ...(session.pollAfterMs ? { pollAfterMs: session.pollAfterMs } : {}),
      responseJson: publicSessionDetails(session),
      expiresAt: new Date(session.expiresAt),
    });
  }

  async getPlaybackSession(id: string): Promise<StoredPlaybackSession | undefined> {
    const [row] = await this.db
      .select()
      .from(playbackSessions)
      .where(eq(playbackSessions.id, id))
      .limit(1);
    if (!row) return undefined;
    const details = row.responseJson as Partial<StoredPlaybackSession>;
    return {
      id: row.id,
      mediaItemId: row.mediaItemId,
      state: row.state,
      capabilities: row.capabilities as StoredPlaybackSession['capabilities'],
      expiresAt: row.expiresAt.toISOString(),
      ...(row.generationId ? { generationId: row.generationId } : {}),
      ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
      ...(row.pollAfterMs ? { pollAfterMs: row.pollAfterMs } : {}),
      ...(details.manifestUrl ? { manifestUrl: details.manifestUrl } : {}),
      ...(details.durationSeconds !== undefined ? { durationSeconds: details.durationSeconds } : {}),
      ...(details.audioTracks ? { audioTracks: details.audioTracks } : {}),
      ...(details.subtitleTracks ? { subtitleTracks: details.subtitleTracks } : {}),
    };
  }

  async updatePlaybackSession(session: StoredPlaybackSession): Promise<void> {
    await this.db
      .update(playbackSessions)
      .set({
        state: session.state,
        generationId: session.generationId ?? null,
        reasonCode: session.reasonCode ?? null,
        pollAfterMs: session.pollAfterMs ?? null,
        responseJson: publicSessionDetails(session),
        updatedAt: new Date(),
      })
      .where(eq(playbackSessions.id, session.id));
  }

  async findAdminByEmail(email: string): Promise<AdminRecord | undefined> {
    const [admin] = await this.db
      .select()
      .from(admins)
      .where(eq(admins.email, email.trim().toLowerCase()))
      .limit(1);
    return admin ? toAdmin(admin) : undefined;
  }

  async findAdminById(id: string): Promise<AdminRecord | undefined> {
    const [admin] = await this.db.select().from(admins).where(eq(admins.id, id)).limit(1);
    return admin ? toAdmin(admin) : undefined;
  }

  async createAdmin(admin: AdminRecord): Promise<void> {
    await this.db
      .insert(admins)
      .values({
        id: admin.id,
        email: admin.email.trim().toLowerCase(),
        passwordHash: admin.passwordHash,
        ...(admin.totpSecretEncrypted
          ? { totpSecretEncrypted: admin.totpSecretEncrypted }
          : {}),
        disabled: admin.disabled,
      })
      .onConflictDoNothing({ target: admins.email });
  }

  async createAdminSession(session: StoredAdminSession): Promise<void> {
    await this.db.insert(adminSessions).values({
      id: session.id,
      adminId: session.adminId,
      tokenHash: session.tokenHash,
      csrfTokenHash: session.csrfTokenHash,
      expiresAt: new Date(session.expiresAt),
    });
  }

  async findAdminSessionByTokenHash(tokenHash: string): Promise<StoredAdminSession | undefined> {
    const [session] = await this.db
      .select()
      .from(adminSessions)
      .where(eq(adminSessions.tokenHash, tokenHash))
      .limit(1);
    return session
      ? {
          id: session.id,
          adminId: session.adminId,
          tokenHash: session.tokenHash,
          csrfTokenHash: session.csrfTokenHash,
          expiresAt: session.expiresAt.toISOString(),
          ...(session.revokedAt ? { revokedAt: session.revokedAt.toISOString() } : {}),
        }
      : undefined;
  }

  async revokeAdminSession(id: string): Promise<void> {
    await this.db
      .update(adminSessions)
      .set({ revokedAt: new Date() })
      .where(eq(adminSessions.id, id));
  }

  async createJob(job: Job, payload: Record<string, unknown>): Promise<void> {
    await this.db.insert(jobs).values({
      id: job.id,
      type: job.type,
      state: job.state,
      progress: job.progress,
      payload,
      ...(job.error ? { error: job.error } : {}),
    });
  }

  async listJobs(): Promise<Job[]> {
    const rows = await this.db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(200);
    return rows.map(toJob);
  }

  async findJob(id: string): Promise<Job | undefined> {
    const [job] = await this.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    return job ? toJob(job) : undefined;
  }

  async retryJob(id: string): Promise<Job | undefined> {
    const [job] = await this.db
      .update(jobs)
      .set({ state: 'QUEUED', progress: 0, error: null, updatedAt: new Date() })
      .where(and(eq(jobs.id, id), inArray(jobs.state, ['FAILED', 'CANCELLED'])))
      .returning();
    return job ? toJob(job) : undefined;
  }

  async getCacheStatus(): Promise<CacheStatus> {
    const [summary] = await this.db
      .select({
        usedBytes: sql<number>`coalesce(sum(case when ${mediaPackages.cacheResident} then ${mediaPackages.sizeBytes} else 0 end), 0)::bigint`,
        activePackages: sql<number>`count(*) filter (where ${mediaPackages.state} = 'BUILDING')::int`,
      })
      .from(mediaPackages);
    return {
      usedBytes: Number(summary?.usedBytes ?? 0),
      maxBytes: this.options.cacheMaxBytes,
      highWatermark: this.options.cacheHighWatermark,
      lowWatermark: this.options.cacheLowWatermark,
      activePackages: summary?.activePackages ?? 0,
    };
  }

  private async cardsForRows(rows: (typeof titles.$inferSelect)[]): Promise<CatalogCard[]> {
    if (rows.length === 0) return [];
    const media = await this.db
      .select()
      .from(mediaItems)
      .where(and(inArray(mediaItems.titleId, rows.map((row) => row.id)), eq(mediaItems.published, true)))
      .orderBy(asc(mediaItems.seasonNumber), asc(mediaItems.episodeNumber), asc(mediaItems.id));
    return rows.map((title) =>
      toCatalogCard(
        title,
        media.filter((item) => item.titleId === title.id),
      ),
    );
  }
}

function toCatalogCard(
  title: typeof titles.$inferSelect,
  media: (typeof mediaItems.$inferSelect)[],
): CatalogCard {
  const first = media[0];
  return {
    id: title.id,
    slug: title.slug,
    kind: title.kind,
    name: localizedRequired(title.nameFa, title.nameEn),
    playable: media.length > 0,
    ...(title.posterUrl ? { posterUrl: title.posterUrl } : {}),
    ...(title.backdropUrl ? { backdropUrl: title.backdropUrl } : {}),
    ...(title.releaseYear !== null ? { year: title.releaseYear } : {}),
    ...(first ? { resumeMediaItemId: first.id } : {}),
  };
}

function toTitleDetail(
  title: typeof titles.$inferSelect,
  media: (typeof mediaItems.$inferSelect)[],
): TitleDetail {
  const card = toCatalogCard(
    title,
    media.filter((item) => item.published),
  );
  const seasonNumbers = [...new Set(media.map((item) => item.seasonNumber).filter(isNumber))];
  return {
    ...card,
    synopsis: {
      ...(title.synopsisFa ? { fa: title.synopsisFa } : {}),
      ...(title.synopsisEn ? { en: title.synopsisEn } : {}),
    },
    ...(seasonNumbers.length > 0
      ? {
          seasons: seasonNumbers.map((number) => ({
            number,
            episodeCount: media.filter((item) => item.seasonNumber === number).length,
          })),
        }
      : {}),
    mediaItems: media.map((item) => ({
      id: item.id,
      kind: item.kind,
      ...(item.seasonNumber !== null ? { seasonNumber: item.seasonNumber } : {}),
      ...(item.episodeNumber !== null ? { episodeNumber: item.episodeNumber } : {}),
      ...(item.nameFa || item.nameEn
        ? {
            name: {
              ...(item.nameFa ? { fa: item.nameFa } : {}),
              ...(item.nameEn ? { en: item.nameEn } : {}),
            },
          }
        : {}),
      durationSeconds: item.durationSeconds ?? 0,
      compatibility: item.compatibility,
      published: item.published,
    })),
    updatedAt: title.updatedAt.toISOString(),
  };
}

function localizedRequired(fa: string | null, en: string | null) {
  return { fa: fa ?? en ?? 'بدون عنوان', ...(en ? { en } : {}) };
}

function toAdmin(admin: typeof admins.$inferSelect): AdminRecord {
  return {
    id: admin.id,
    email: admin.email,
    passwordHash: admin.passwordHash,
    disabled: admin.disabled,
    ...(admin.totpSecretEncrypted ? { totpSecretEncrypted: admin.totpSecretEncrypted } : {}),
  };
}

function toJob(job: typeof jobs.$inferSelect): Job {
  return {
    id: job.id,
    type: job.type,
    state: job.state,
    progress: job.progress,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function publicSessionDetails(session: StoredPlaybackSession): Record<string, unknown> {
  return {
    ...(session.manifestUrl ? { manifestUrl: session.manifestUrl } : {}),
    ...(session.durationSeconds !== undefined ? { durationSeconds: session.durationSeconds } : {}),
    ...(session.audioTracks ? { audioTracks: session.audioTracks } : {}),
    ...(session.subtitleTracks ? { subtitleTracks: session.subtitleTracks } : {}),
  };
}

function isNumber(value: number | null): value is number {
  return value !== null;
}

function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

function decodeOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      offset?: unknown;
    };
    return typeof value.offset === 'number' && Number.isSafeInteger(value.offset) && value.offset >= 0
      ? value.offset
      : 0;
  } catch {
    return 0;
  }
}
