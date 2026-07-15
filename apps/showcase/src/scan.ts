import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { scanArchive, parseMediaIdentity, slugify, type SnapshotTitle } from '../../worker/src/catalog.js';
import type { ShowcaseConfig } from './config.js';

interface SidecarMetadata {
  title?: string;
  titleFa?: string;
  titleEn?: string;
  synopsis?: string;
  synopsisFa?: string;
  synopsisEn?: string;
  category?: string;
  year?: number;
  releaseWindow?: string;
}

async function sidecar(config: ShowcaseConfig, title: SnapshotTitle): Promise<SidecarMetadata> {
  const source = title.mediaItems[0]?.variants?.[0]?.sourcePath ?? title.mediaItems[0]?.sourcePath;
  if (!source) return {};
  const identity = parseMediaIdentity(source);
  if (!identity.titleDirectory) return {};
  try {
    const value = JSON.parse(await readFile(path.join(config.archiveRoot, identity.titleDirectory, 'metadata.json'), 'utf8')) as SidecarMetadata;
    return typeof value === 'object' && value !== null ? value : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`Invalid metadata.json for ${title.slug}: ${(error as Error).message}`);
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function scanIntoDatabase(db: DatabaseSync, config: ShowcaseConfig): Promise<{ titles: number; media: number; variants: number }> {
  const result = await scanArchive({
    archiveRoot: config.archiveRoot,
    artworkRoot: config.artworkRoot,
    ffmpegPath: config.ffmpegPath,
    ffprobePath: config.ffprobePath,
    onFile: (filename, number) => process.stdout.write(`\r[${number}] ${filename.slice(0, 100).padEnd(100)}`),
  });
  if (result.inventory.items.length) process.stdout.write('\n');
  const metadata = new Map<string, SidecarMetadata>();
  for (const title of result.inventory.items) metadata.set(title.id, await sidecar(config, title));

  db.exec('BEGIN IMMEDIATE; CREATE TEMP TABLE IF NOT EXISTS seen_titles(id TEXT PRIMARY KEY); DELETE FROM seen_titles; CREATE TEMP TABLE IF NOT EXISTS seen_media(id TEXT PRIMARY KEY); DELETE FROM seen_media; CREATE TEMP TABLE IF NOT EXISTS seen_variants(id TEXT PRIMARY KEY); DELETE FROM seen_variants;');
  try {
    const markTitle = db.prepare('INSERT OR IGNORE INTO seen_titles VALUES (?)');
    const markMedia = db.prepare('INSERT OR IGNORE INTO seen_media VALUES (?)');
    const markVariant = db.prepare('INSERT OR IGNORE INTO seen_variants VALUES (?)');
    const upsertTitle = db.prepare(`INSERT INTO titles
      (id,slug,kind,name_fa,name_en,synopsis_fa,synopsis_en,poster_url,category,category_slug,release_year,release_window,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      slug=excluded.slug,kind=excluded.kind,name_fa=excluded.name_fa,name_en=excluded.name_en,
      synopsis_fa=excluded.synopsis_fa,synopsis_en=excluded.synopsis_en,poster_url=excluded.poster_url,
      category=excluded.category,category_slug=excluded.category_slug,release_year=excluded.release_year,
      release_window=excluded.release_window,updated_at=excluded.updated_at`);
    const upsertMedia = db.prepare(`INSERT INTO media_items
      (id,title_id,kind,season_number,episode_number,name_fa,name_en,duration_seconds)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title_id=excluded.title_id,kind=excluded.kind,
      season_number=excluded.season_number,episode_number=excluded.episode_number,name_fa=excluded.name_fa,
      name_en=excluded.name_en,duration_seconds=excluded.duration_seconds`);
    const upsertVariant = db.prepare(`INSERT INTO variants
      (id,media_item_id,source_path,fingerprint,label,width,height,video_codec,compatibility,status,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      media_item_id=excluded.media_item_id,source_path=excluded.source_path,label=excluded.label,width=excluded.width,
      height=excluded.height,video_codec=excluded.video_codec,compatibility=excluded.compatibility,
      status=CASE WHEN variants.fingerprint=excluded.fingerprint THEN variants.status ELSE excluded.status END,
      generation_id=CASE WHEN variants.fingerprint=excluded.fingerprint THEN variants.generation_id ELSE NULL END,
      manifest_path=CASE WHEN variants.fingerprint=excluded.fingerprint THEN variants.manifest_path ELSE NULL END,
      audio_tracks=CASE WHEN variants.fingerprint=excluded.fingerprint THEN variants.audio_tracks ELSE '[]' END,
      subtitle_tracks=CASE WHEN variants.fingerprint=excluded.fingerprint THEN variants.subtitle_tracks ELSE '[]' END,
      error=CASE WHEN variants.fingerprint=excluded.fingerprint THEN variants.error ELSE NULL END,
      fingerprint=excluded.fingerprint,updated_at=excluded.updated_at`);

    for (const title of result.inventory.items) {
      const meta = metadata.get(title.id) ?? {};
      const nameEn = text(meta.titleEn ?? meta.title) ?? title.title.en;
      const nameFa = text(meta.titleFa) ?? nameEn;
      const category = text(meta.category) ?? title.category ?? null;
      const slug = text(meta.titleEn ?? meta.title) ? slugify(nameEn) : title.slug;
      markTitle.run(title.id);
      upsertTitle.run(title.id, slug, title.kind, nameFa, nameEn, text(meta.synopsisFa ?? meta.synopsis), text(meta.synopsisEn), title.posterUrl ?? null, category, category ? slugify(category) : null, meta.year ?? title.year ?? null, text(meta.releaseWindow)?.toUpperCase() ?? title.releaseWindow ?? null, result.inventory.generatedAt);
      for (const media of title.mediaItems) {
        markMedia.run(media.id);
        upsertMedia.run(media.id, title.id, media.kind, media.seasonNumber ?? null, media.episodeNumber ?? null, media.title.fa ?? media.title.en, media.title.en, media.durationSeconds);
        for (const variant of media.variants ?? [media]) {
          const unsupported = variant.compatibility === 'HOLD_HDR' || variant.compatibility === 'INVALID';
          markVariant.run(variant.id);
          upsertVariant.run(variant.id, media.id, variant.sourcePath, JSON.stringify(variant.fingerprint), variant.qualityLabel, variant.width ?? null, variant.height ?? null, variant.videoCodec ?? null, variant.compatibility, unsupported ? 'UNSUPPORTED' : 'UNPREPARED', result.inventory.generatedAt);
        }
      }
    }
    db.exec('DELETE FROM variants WHERE id NOT IN (SELECT id FROM seen_variants); DELETE FROM media_items WHERE id NOT IN (SELECT id FROM seen_media); DELETE FROM titles WHERE id NOT IN (SELECT id FROM seen_titles); COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
  return {
    titles: Number((db.prepare('SELECT count(*) AS count FROM titles').get() as { count: number }).count),
    media: Number((db.prepare('SELECT count(*) AS count FROM media_items').get() as { count: number }).count),
    variants: Number((db.prepare('SELECT count(*) AS count FROM variants').get() as { count: number }).count),
  };
}
