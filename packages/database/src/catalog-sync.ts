import { CatalogSnapshotSchema, type CatalogSnapshot } from '@easy-stream/contracts';
import { Value } from '@sinclair/typebox/value';
import { sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { mediaItems, titles } from './schema.js';

const UPSERT_BATCH_SIZE = 500;

export interface PreparedCatalogSync {
  scannedAt: Date;
  titleRows: Array<typeof titles.$inferInsert>;
  mediaItemRows: Array<typeof mediaItems.$inferInsert>;
}

export interface CatalogSyncResult {
  titlesSeen: number;
  mediaItemsSeen: number;
}

/**
 * Validates and converts the public scan snapshot into database insert rows. Keeping this
 * conversion separate also makes the scanner/database boundary testable without PostgreSQL.
 */
export function prepareCatalogSync(snapshot: unknown): PreparedCatalogSync {
  if (!Value.Check(CatalogSnapshotSchema, snapshot)) {
    const detail = [...Value.Errors(CatalogSnapshotSchema, snapshot)]
      .slice(0, 8)
      .map((error) => `${error.path || '/'} ${error.message}`)
      .join('; ');
    throw new Error(`Invalid catalog snapshot: ${detail}`);
  }

  const catalog = snapshot as CatalogSnapshot;
  const scannedAt = new Date(catalog.generatedAt);
  const titleIds = new Set<string>();
  const slugs = new Set<string>();
  const mediaItemIds = new Set<string>();
  const titleRows: PreparedCatalogSync['titleRows'] = [];
  const mediaItemRows: PreparedCatalogSync['mediaItemRows'] = [];

  for (const title of catalog.titles) {
    assertUnique(titleIds, title.id, 'title ID');
    assertUnique(slugs, title.slug, 'title slug');
    const published = title.mediaItems.some((item) => item.published);
    titleRows.push({
      id: title.id,
      slug: title.slug,
      kind: title.kind,
      nameFa: title.name.fa,
      nameEn: title.name.en ?? null,
      synopsisFa: title.synopsis.fa ?? null,
      synopsisEn: title.synopsis.en ?? null,
      posterUrl: title.posterUrl ?? null,
      backdropUrl: title.backdropUrl ?? null,
      releaseYear: title.year ?? null,
      published,
      publishedAt: published ? scannedAt : null,
      createdAt: scannedAt,
      updatedAt: scannedAt,
    });

    for (const item of title.mediaItems) {
      assertUnique(mediaItemIds, item.id, 'media item ID');
      if ((title.kind === 'MOVIE') !== (item.kind === 'MOVIE')) {
        throw new Error(`Catalog media item ${item.id} has kind ${item.kind} under ${title.kind}`);
      }
      mediaItemRows.push({
        id: item.id,
        titleId: title.id,
        kind: item.kind,
        seasonNumber: item.seasonNumber ?? null,
        episodeNumber: item.episodeNumber ?? null,
        nameFa: item.name?.fa ?? null,
        nameEn: item.name?.en ?? null,
        durationSeconds: item.durationSeconds,
        compatibility: item.compatibility,
        published: item.published,
        publishedAt: item.published ? scannedAt : null,
        createdAt: scannedAt,
        updatedAt: scannedAt,
      });
    }
  }

  return { scannedAt, titleRows, mediaItemRows };
}

/**
 * Safely imports scanner-owned catalog facts. Existing names, artwork, TMDB matches and all
 * publication fields are intentionally excluded from conflict updates so an archive rescan
 * cannot undo an administrator's choices. Rows absent from a snapshot are retained.
 */
export async function syncCatalogSnapshot(
  db: Database,
  snapshot: unknown,
): Promise<CatalogSyncResult> {
  const prepared = prepareCatalogSync(snapshot);
  await db.transaction(async (transaction) => {
    // Prevent two worker processes from interleaving catalog snapshots.
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext('easy-stream.catalog-sync'))`);

    for (const batch of batches(prepared.titleRows, UPSERT_BATCH_SIZE)) {
      await transaction
        .insert(titles)
        .values(batch)
        .onConflictDoUpdate({
          target: titles.id,
          set: {
            slug: sql`excluded.slug`,
            kind: sql`excluded.kind`,
            updatedAt: prepared.scannedAt,
          },
          setWhere: sql`${titles.slug} is distinct from excluded.slug or ${titles.kind} is distinct from excluded.kind`,
        });
    }

    for (const batch of batches(prepared.mediaItemRows, UPSERT_BATCH_SIZE)) {
      await transaction
        .insert(mediaItems)
        .values(batch)
        .onConflictDoUpdate({
          target: mediaItems.id,
          set: {
            titleId: sql`excluded.title_id`,
            kind: sql`excluded.kind`,
            seasonNumber: sql`excluded.season_number`,
            episodeNumber: sql`excluded.episode_number`,
            durationSeconds: sql`excluded.duration_seconds`,
            compatibility: sql`excluded.compatibility`,
            updatedAt: prepared.scannedAt,
          },
          setWhere: sql`
            ${mediaItems.titleId} is distinct from excluded.title_id
            or ${mediaItems.kind} is distinct from excluded.kind
            or ${mediaItems.seasonNumber} is distinct from excluded.season_number
            or ${mediaItems.episodeNumber} is distinct from excluded.episode_number
            or ${mediaItems.durationSeconds} is distinct from excluded.duration_seconds
            or ${mediaItems.compatibility} is distinct from excluded.compatibility
          `,
        });
    }
  });
  return {
    titlesSeen: prepared.titleRows.length,
    mediaItemsSeen: prepared.mediaItemRows.length,
  };
}

function assertUnique(values: Set<string>, value: string, label: string): void {
  if (values.has(value)) throw new Error(`Catalog contains duplicate ${label}: ${value}`);
  values.add(value);
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
