import type { DatabaseSync } from 'node:sqlite';
import type { VariantRow } from './database.js';

interface TitleRow {
  id: string; slug: string; kind: string; name_fa: string; name_en: string | null;
  synopsis_fa: string | null; synopsis_en: string | null; poster_url: string | null;
  category: string | null; category_slug: string | null; release_year: number | null;
  release_window: string | null; updated_at: string;
}

interface MediaRow {
  id: string; title_id: string; kind: string; season_number: number | null;
  episode_number: number | null; name_fa: string | null; name_en: string | null;
  duration_seconds: number;
}

export interface ShowcasePlayback {
  mediaItemId: string;
  variantId: string;
  qualityLabel: string;
  manifestUrl: string;
  durationSeconds: number;
  audioTracks: unknown[];
  subtitleTracks: unknown[];
}

export interface ShowcaseSnapshot {
  version: 1;
  generatedAt: string;
  sections: Array<{ slug: string; name: string; items: unknown[]; hasMore: boolean }>;
  titles: unknown[];
  playbackByVariant: Record<string, ShowcasePlayback>;
  defaultVariantByMedia: Record<string, string>;
}

export type AssetUrlResolver = (localUrl: string) => string;

export function readyVariants(db: DatabaseSync, mediaId: string): VariantRow[] {
  return db.prepare("SELECT * FROM variants WHERE media_item_id=? AND status='READY' ORDER BY abs(coalesce(height,720)-720),height")
    .all(mediaId) as unknown as VariantRow[];
}

function variantJson(row: VariantRow, index: number) {
  return {
    id: row.id,
    label: row.label,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    videoCodec: row.video_codec ?? undefined,
    compatibility: row.compatibility,
    available: true,
    isDefault: index === 0,
  };
}

function rewriteTrackUrls(track: unknown, resolveAssetUrl: AssetUrlResolver): unknown {
  if (track === null || typeof track !== 'object' || Array.isArray(track)) return track;
  const source = track as Record<string, unknown>;
  return {
    ...source,
    ...(typeof source.assUrl === 'string' ? { assUrl: resolveAssetUrl(source.assUrl) } : {}),
    ...(typeof source.vttUrl === 'string' ? { vttUrl: resolveAssetUrl(source.vttUrl) } : {}),
    ...(Array.isArray(source.fontUrls) ? {
      fontUrls: source.fontUrls.map((url) => typeof url === 'string' ? resolveAssetUrl(url) : url),
    } : {}),
  };
}

function titleJson(db: DatabaseSync, title: TitleRow, resolveAssetUrl: AssetUrlResolver, detail: boolean) {
  const media = db.prepare('SELECT * FROM media_items WHERE title_id=? ORDER BY coalesce(season_number,0),coalesce(episode_number,0)')
    .all(title.id) as unknown as MediaRow[];
  const playable = media.map((item) => ({ item, variants: readyVariants(db, item.id) }))
    .filter((entry) => entry.variants.length);
  const first = playable[0];
  const seasons = new Set(playable.map(({ item }) => item.season_number).filter((number) => number !== null));
  const base = {
    id: title.id,
    slug: title.slug,
    kind: title.kind,
    name: { fa: title.name_fa, en: title.name_en ?? undefined },
    title: { fa: title.name_fa, en: title.name_en ?? undefined },
    synopsis: { fa: title.synopsis_fa ?? undefined, en: title.synopsis_en ?? undefined },
    posterUrl: title.poster_url ? resolveAssetUrl(title.poster_url) : undefined,
    category: title.category ?? undefined,
    categorySlug: title.category_slug ?? undefined,
    year: title.release_year ?? undefined,
    releaseWindow: title.release_window ?? undefined,
    playable: Boolean(first),
    resumeMediaItemId: first?.item.id,
    mediaItemId: first?.item.id,
    variants: first?.variants.map(variantJson) ?? [],
    runtimeSeconds: title.kind === 'MOVIE' ? first?.item.duration_seconds : undefined,
    seasonCount: title.kind === 'SERIES' ? seasons.size : undefined,
    episodeCount: title.kind === 'SERIES' ? playable.length : undefined,
    updatedAt: title.updated_at,
  };
  if (!detail) return base;
  return {
    ...base,
    mediaItems: playable.map(({ item, variants }) => ({
      id: item.id,
      mediaItemId: item.id,
      kind: item.kind,
      seasonNumber: item.season_number ?? undefined,
      episodeNumber: item.episode_number ?? undefined,
      name: { fa: item.name_fa ?? undefined, en: item.name_en ?? undefined },
      durationSeconds: item.duration_seconds,
      published: true,
      variants: variants.map(variantJson),
    })),
  };
}

function visibleTitles(db: DatabaseSync): TitleRow[] {
  return db.prepare(`SELECT DISTINCT t.* FROM titles t JOIN media_items m ON m.title_id=t.id JOIN variants v ON v.media_item_id=m.id WHERE v.status='READY' ORDER BY t.name_en,t.name_fa`)
    .all() as unknown as TitleRow[];
}

export function buildShowcaseSnapshot(
  db: DatabaseSync,
  resolveAssetUrl: AssetUrlResolver = (url) => url,
): ShowcaseSnapshot {
  const titles = visibleTitles(db);
  const details = titles.map((title) => titleJson(db, title, resolveAssetUrl, true));
  const groups = new Map<string, { name: string; items: unknown[] }>();
  for (const title of titles) {
    const slug = title.category_slug ?? 'showcase';
    const group = groups.get(slug) ?? { name: title.category ?? 'Showcase', items: [] };
    group.items.push(titleJson(db, title, resolveAssetUrl, false));
    groups.set(slug, group);
  }
  const playbackByVariant: Record<string, ShowcasePlayback> = {};
  const defaultVariantByMedia: Record<string, string> = {};
  const media = db.prepare(`SELECT m.* FROM media_items m JOIN titles t ON t.id=m.title_id WHERE t.id IN (SELECT DISTINCT m2.title_id FROM media_items m2 JOIN variants v2 ON v2.media_item_id=m2.id WHERE v2.status='READY')`)
    .all() as unknown as MediaRow[];
  for (const item of media) {
    for (const [index, variant] of readyVariants(db, item.id).entries()) {
      if (!variant.manifest_path) continue;
      if (index === 0) defaultVariantByMedia[item.id] = variant.id;
      playbackByVariant[variant.id] = {
        mediaItemId: item.id,
        variantId: variant.id,
        qualityLabel: variant.label,
        manifestUrl: resolveAssetUrl(variant.manifest_path),
        durationSeconds: item.duration_seconds,
        audioTracks: JSON.parse(variant.audio_tracks) as unknown[],
        subtitleTracks: (JSON.parse(variant.subtitle_tracks) as unknown[])
          .map((track) => rewriteTrackUrls(track, resolveAssetUrl)),
      };
    }
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sections: [...groups].map(([slug, group]) => ({ slug, name: group.name, items: group.items, hasMore: false })),
    titles: details,
    playbackByVariant,
    defaultVariantByMedia,
  };
}
