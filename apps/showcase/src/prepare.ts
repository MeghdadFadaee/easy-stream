import { opendir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  classifyMedia,
  extractAndStoreFonts,
  extractSubtitleVariants,
  fingerprintSource,
  languageDisplayName,
  normalizeStreamLanguage,
  packageProgressiveHls,
  prepareCompatibilityHls,
  probeMedia,
  publishGenerationFonts,
  type SourceFingerprint,
} from '@easy-stream/media';
import { deterministicUuid } from '../../worker/src/catalog.js';
import type { ShowcaseConfig } from './config.js';
import type { VariantRow } from './database.js';

export interface PrepareSelection { all?: boolean; title?: string; quality?: string; force?: boolean }

function selectedRows(db: DatabaseSync, selection: PrepareSelection): VariantRow[] {
  const values: string[] = [];
  const clauses = ["v.compatibility NOT IN ('HOLD_HDR','INVALID')"];
  if (!selection.all) {
    if (!selection.title) throw new Error('Choose --all or --title <slug>');
    clauses.push('t.slug = ?');
    values.push(selection.title);
  }
  if (selection.quality) {
    clauses.push('lower(v.label) = lower(?)');
    values.push(selection.quality);
  }
  return db.prepare(`SELECT v.* FROM variants v JOIN media_items m ON m.id=v.media_item_id JOIN titles t ON t.id=m.title_id WHERE ${clauses.join(' AND ')} ORDER BY t.name_en,m.season_number,m.episode_number,v.height`).all(...values) as unknown as VariantRow[];
}

function mediaUrl(config: ShowcaseConfig, filename: string): string {
  return `/media/${path.relative(config.mediaRoot, filename).split(path.sep).join('/')}`;
}

async function prepareOne(db: DatabaseSync, config: ShowcaseConfig, row: VariantRow, force: boolean): Promise<void> {
  const original = JSON.parse(row.fingerprint) as SourceFingerprint;
  const sourcePath = path.join(config.archiveRoot, row.source_path);
  const generation = `showcase-v1-${original.digest.slice(0, 32)}`;
  const generationDirectory = path.join(config.mediaRoot, 'generations', generation);
  if (force) await rm(generationDirectory, { recursive: true, force: true });
  db.prepare("UPDATE variants SET status='PREPARING',error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), row.id);
  try {
    const probe = await probeMedia(sourcePath, { ffprobePath: config.ffprobePath });
    const fingerprint = await fingerprintSource(config.archiveRoot, sourcePath, original.edgeBytes);
    if (fingerprint.digest !== original.digest) throw new Error('Source changed since scan; run `pnpm showcase scan` first');
    const classification = classifyMedia(probe);
    if (classification.class === 'HOLD_HDR' || classification.class === 'INVALID') throw new Error(`Unsupported source: ${classification.class}`);
    const packaged = classification.class === 'VIDEO_TRANSCODE'
      ? await prepareCompatibilityHls({ archiveRoot: config.archiveRoot, derivedRoot: config.mediaRoot, sourcePath, fingerprint, probe, classification, generation, ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath })
      : await packageProgressiveHls({ archiveRoot: config.archiveRoot, cacheRoot: config.mediaRoot, sourcePath, fingerprint, probe, classification, generation, ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath });
    const subtitles = await extractSubtitleVariants(sourcePath, probe, { archiveRoot: config.archiveRoot, outputRoot: config.mediaRoot, generation: `generations/${generation}`, ffmpegPath: config.ffmpegPath });
    const storedFonts = await extractAndStoreFonts(sourcePath, probe, { archiveRoot: config.archiveRoot, fontRoot: path.join(config.mediaRoot, 'assets', 'fonts'), ffmpegPath: config.ffmpegPath });
    const fonts = await publishGenerationFonts(storedFonts, config.mediaRoot, packaged.outputDirectory);
    const fontUrls = fonts.map((font) => mediaUrl(config, font.path));
    const subtitleTracks = subtitles.map((track) => ({
      id: deterministicUuid(`showcase:subtitle:${row.id}:${track.streamIndex}`),
      language: track.language,
      label: languageDisplayName(track.language),
      default: track.default,
      forced: track.forced,
      assUrl: mediaUrl(config, track.assPath),
      vttUrl: mediaUrl(config, track.vttPath),
      fontUrls,
    }));
    const audioTracks = classification.audioStreamIndexes.map((index, position) => {
      const stream = probe.streams.find((candidate) => candidate.index === index)!;
      const language = normalizeStreamLanguage(stream);
      return { id: deterministicUuid(`showcase:audio:${row.id}:${index}`), language, label: languageDisplayName(language), default: position === 0 };
    });
    db.prepare(`UPDATE variants SET status='READY',generation_id=?,manifest_path=?,audio_tracks=?,subtitle_tracks=?,error=NULL,updated_at=? WHERE id=?`)
      .run(generation, mediaUrl(config, packaged.masterPlaylist), JSON.stringify(audioTracks), JSON.stringify(subtitleTracks), new Date().toISOString(), row.id);
  } catch (error) {
    db.prepare("UPDATE variants SET status='FAILED',error=?,updated_at=? WHERE id=?").run((error as Error).message.slice(0, 2000), new Date().toISOString(), row.id);
    throw error;
  }
}

export async function prepareSelection(db: DatabaseSync, config: ShowcaseConfig, selection: PrepareSelection): Promise<{ ready: number; failed: number }> {
  const rows = selectedRows(db, selection);
  if (!rows.length) throw new Error('No matching preparable variants. Run scan and check the title slug/quality.');
  let ready = 0;
  let failed = 0;
  for (const [index, row] of rows.entries()) {
    process.stdout.write(`[${index + 1}/${rows.length}] ${row.source_path} ... `);
    try {
      await prepareOne(db, config, row, selection.force === true);
      ready += 1;
      console.log('ready');
    } catch (error) {
      failed += 1;
      console.error(`failed: ${(error as Error).message}`);
    }
  }
  return { ready, failed };
}

export function printStatus(db: DatabaseSync): void {
  const rows = db.prepare('SELECT status,count(*) AS count FROM variants GROUP BY status ORDER BY status').all() as Array<{ status: string; count: number }>;
  const failures = db.prepare("SELECT source_path,error FROM variants WHERE status='FAILED' ORDER BY updated_at DESC LIMIT 10").all() as Array<{ source_path: string; error: string }>;
  if (!rows.length) console.log('No archive entries. Run `pnpm showcase scan`.');
  else rows.forEach((row) => console.log(`${row.status.padEnd(12)} ${row.count}`));
  failures.forEach((row) => console.log(`FAILED      ${row.source_path}: ${row.error}`));
}

export async function pruneMedia(db: DatabaseSync, config: ShowcaseConfig, apply: boolean): Promise<string[]> {
  const referenced = new Set((db.prepare("SELECT generation_id FROM variants WHERE status='READY' AND generation_id IS NOT NULL").all() as Array<{ generation_id: string }>).map((row) => row.generation_id));
  const root = path.join(config.mediaRoot, 'generations');
  const stale: string[] = [];
  try {
    for await (const entry of await opendir(root)) {
      if (entry.isDirectory() && !referenced.has(entry.name)) stale.push(entry.name);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const generation of stale) {
    console.log(`${apply ? 'remove' : 'would remove'} ${generation}`);
    if (apply) await rm(path.join(root, generation), { recursive: true, force: true });
  }
  if (!stale.length) console.log('Nothing to prune.');
  return stale;
}
