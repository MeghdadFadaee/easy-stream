import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  assDialogueText,
  classifyMedia,
  fingerprintSource,
  normalizeStreamLanguage,
  normalizeTracks,
  probeMedia,
  readSubtitleAsAss,
  walkArchive,
  type Classification,
  type NormalizedTrack,
  type ProbeStream,
  type SourceFingerprint,
} from '@easy-stream/media';

export type CatalogKind = 'MOVIE' | 'SERIES';

export interface ParsedMediaIdentity {
  kind: CatalogKind;
  title: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeTitle?: string;
}

export interface SnapshotSubtitle {
  id: string;
  streamIndex: number;
  codec: string;
  sourceLanguage: string;
  language: string;
  label: string;
  sourceDefault: boolean;
  sourceForced: boolean;
  default: boolean;
  forced: false;
}

export interface SnapshotMediaItem {
  id: string;
  titleId: string;
  kind: 'MOVIE' | 'EPISODE';
  sourcePath: string;
  durationSeconds: number;
  seasonNumber?: number;
  episodeNumber?: number;
  title: { en: string; fa?: string };
  published: boolean;
  compatibility: Classification['class'];
  compatibilityReasons: string[];
  fingerprint: SourceFingerprint;
  streams: NormalizedTrack[];
  subtitles: SnapshotSubtitle[];
}

export interface SnapshotSeason {
  number: number;
  title: { en: string };
  episodes: SnapshotMediaItem[];
}

export interface SnapshotTitle {
  id: string;
  slug: string;
  kind: CatalogKind;
  title: { en: string; fa?: string };
  published: boolean;
  playable: boolean;
  mediaItemId: string;
  resumeMediaItemId: string;
  runtimeSeconds?: number;
  seasonCount?: number;
  episodeCount?: number;
  seasons: SnapshotSeason[];
  mediaItems: SnapshotMediaItem[];
}

export interface InventorySnapshot {
  version: 1;
  generatedAt: string;
  archiveRoot: string;
  items: SnapshotTitle[];
}

export interface PublicMediaItem {
  id: string;
  kind: 'MOVIE' | 'EPISODE';
  seasonNumber?: number;
  episodeNumber?: number;
  name?: { fa?: string; en?: string };
  durationSeconds: number;
  compatibility: Classification['class'];
  published: boolean;
}

export interface PublicTitleDetail {
  id: string;
  slug: string;
  kind: CatalogKind;
  name: { fa: string; en?: string };
  playable: boolean;
  resumeMediaItemId?: string;
  synopsis: { fa?: string; en?: string };
  seasons?: Array<{ number: number; episodeCount: number }>;
  mediaItems: PublicMediaItem[];
  updatedAt: string;
}

export interface CatalogSnapshot {
  version: 1;
  generatedAt: string;
  titles: PublicTitleDetail[];
}

export interface ScanArchiveResult {
  catalog: CatalogSnapshot;
  inventory: InventorySnapshot;
}

export function deterministicUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] ?? 0) & 0x0f | 0x50;
  bytes[8] = (bytes[8] ?? 0) & 0x3f | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function cleanName(value: string): string {
  return value
    .replace(/\[[^\]]*\]/gu, ' ')
    .replace(/[._]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function slugify(value: string): string {
  return value.normalize('NFKD').toLocaleLowerCase('en-US')
    .replace(/\p{Mark}+/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 180) || deterministicUuid(value);
}

export function parseMediaIdentity(relativePath: string): ParsedMediaIdentity {
  const extension = path.extname(relativePath);
  const filename = path.basename(relativePath, extension);
  const parent = path.basename(path.dirname(relativePath));
  const combined = filename.match(/\bS(?:eason)?\s*(\d{1,3})\s*E(?:p(?:isode)?)?\s*(\d{1,4})\b/iu);
  const parentSeason = parent.match(/^(.*?)(?:[\s._-]+S(?:eason)?\s*(\d{1,3}))$/iu);
  const episode = combined?.[2]
    ?? filename.match(/(?:-|–)\s*(\d{1,4})(?=(?:[.\s_\[]|$))/u)?.[1]
    ?? filename.match(/\bE(?:p(?:isode)?)?\s*(\d{1,4})\b/iu)?.[1];
  if (episode !== undefined) {
    const season = Number(combined?.[1] ?? parentSeason?.[2] ?? 1);
    const title = cleanName(parentSeason?.[1] ?? parent);
    return {
      kind: 'SERIES',
      title: title || cleanName(filename),
      seasonNumber: season,
      episodeNumber: Number(episode),
      episodeTitle: `Episode ${Number(episode)}`,
    };
  }
  return { kind: 'MOVIE', title: cleanName(filename) };
}

export interface ScanArchiveOptions {
  archiveRoot: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  onFile?: (relativePath: string, current: number) => void;
}

const TEXT_SUBTITLE_CODECS = new Set(['ass', 'ssa', 'subrip', 'srt', 'webvtt', 'mov_text']);

export function shouldInspectSubtitleContent(stream: ProbeStream): boolean {
  return stream.codec_type === 'subtitle'
    && TEXT_SUBTITLE_CODECS.has(stream.codec_name ?? '')
    && normalizeStreamLanguage(stream) === 'und';
}

async function inspectFile(
  sourcePath: string,
  archiveRoot: string,
  options: ScanArchiveOptions,
): Promise<{ identity: ParsedMediaIdentity; media: SnapshotMediaItem }> {
  const relativePath = path.relative(archiveRoot, sourcePath).split(path.sep).join('/');
  const identity = parseMediaIdentity(relativePath);
  const [probe, fingerprint] = await Promise.all([
    probeMedia(sourcePath, options.ffprobePath === undefined ? {} : { ffprobePath: options.ffprobePath }),
    fingerprintSource(archiveRoot, sourcePath),
  ]);
  const compatibility = classifyMedia(probe);
  const titleId = deterministicUuid(`title:${identity.kind}:${identity.title.toLocaleLowerCase('en-US')}`);
  const mediaId = deterministicUuid(`media:${relativePath}`);
  const tracks = normalizeTracks(probe);
  const subtitles: SnapshotSubtitle[] = [];
  for (const stream of probe.streams.filter((candidate) => candidate.codec_type === 'subtitle')) {
    let content: string | undefined;
    const declaredLanguage = normalizeStreamLanguage(stream);
    if (shouldInspectSubtitleContent(stream)) {
      try {
        content = await readSubtitleAsAss(sourcePath, stream.index, {
          archiveRoot,
          maxDurationSeconds: 10 * 60,
          ...(options.ffmpegPath === undefined ? {} : { ffmpegPath: options.ffmpegPath }),
        });
      } catch {
        // Preserve the track as undetermined; packaging will report extraction failures.
      }
    }
    const language = content === undefined
      ? declaredLanguage
      : normalizeStreamLanguage(stream, assDialogueText(content));
    const track = tracks.find((candidate) => candidate.index === stream.index);
    if (track !== undefined) {
      track.language = language;
      track.default = language === 'fa';
      track.forced = false;
    }
    subtitles.push({
      id: deterministicUuid(`subtitle:${relativePath}:${stream.index}`),
      streamIndex: stream.index,
      codec: stream.codec_name ?? 'unknown',
      sourceLanguage: stream.tags?.language ?? 'und',
      language,
      label: stream.tags?.title ?? language,
      sourceDefault: stream.disposition?.default === 1,
      sourceForced: stream.disposition?.forced === 1,
      default: language === 'fa',
      forced: false,
    });
  }
  const duration = Number(probe.format.duration);
  const published = ['COPY', 'AUDIO_TRANSCODE'].includes(compatibility.class);
  return {
    identity,
    media: {
      id: mediaId,
      titleId,
      kind: identity.kind === 'SERIES' ? 'EPISODE' : 'MOVIE',
      sourcePath: relativePath,
      durationSeconds: Number.isFinite(duration) ? duration : 0,
      ...(identity.seasonNumber === undefined ? {} : { seasonNumber: identity.seasonNumber }),
      ...(identity.episodeNumber === undefined ? {} : { episodeNumber: identity.episodeNumber }),
      title: { en: identity.episodeTitle ?? identity.title },
      published,
      compatibility: compatibility.class,
      compatibilityReasons: compatibility.reasons,
      fingerprint,
      streams: tracks,
      subtitles,
    },
  };
}

export async function scanArchive(options: ScanArchiveOptions): Promise<ScanArchiveResult> {
  const root = path.resolve(options.archiveRoot);
  const grouped = new Map<string, { identity: ParsedMediaIdentity; media: SnapshotMediaItem[] }>();
  let current = 0;
  for await (const sourcePath of walkArchive(root)) {
    current += 1;
    const relative = path.relative(root, sourcePath).split(path.sep).join('/');
    options.onFile?.(relative, current);
    const inspected = await inspectFile(sourcePath, root, options);
    const key = `${inspected.identity.kind}:${inspected.identity.title.toLocaleLowerCase('en-US')}`;
    const group = grouped.get(key) ?? { identity: inspected.identity, media: [] };
    group.media.push(inspected.media);
    grouped.set(key, group);
  }
  const items: SnapshotTitle[] = [...grouped.values()].map(({ identity, media }) => {
    media.sort((left, right) => (left.seasonNumber ?? 0) - (right.seasonNumber ?? 0)
      || (left.episodeNumber ?? 0) - (right.episodeNumber ?? 0));
    const first = media[0];
    if (first === undefined) throw new Error('Internal catalog group is empty');
    const seasonsByNumber = new Map<number, SnapshotMediaItem[]>();
    for (const item of media) {
      if (item.kind !== 'EPISODE') continue;
      const season = item.seasonNumber ?? 1;
      const episodes = seasonsByNumber.get(season) ?? [];
      episodes.push(item);
      seasonsByNumber.set(season, episodes);
    }
    const seasons = [...seasonsByNumber.entries()].sort(([left], [right]) => left - right)
      .map(([number, episodes]) => ({ number, title: { en: `Season ${number}` }, episodes }));
    const published = media.some((item) => item.published);
    return {
      id: first.titleId,
      slug: slugify(identity.title),
      kind: identity.kind,
      title: { en: identity.title },
      published,
      playable: published,
      mediaItemId: first.id,
      resumeMediaItemId: first.id,
      ...(identity.kind === 'MOVIE' ? { runtimeSeconds: first.durationSeconds } : {}),
      ...(identity.kind === 'SERIES' ? { seasonCount: seasons.length, episodeCount: media.length } : {}),
      seasons,
      mediaItems: media,
    };
  });
  items.sort((left, right) => left.title.en.localeCompare(right.title.en));
  const generatedAt = new Date().toISOString();
  const titles: PublicTitleDetail[] = items.map((item) => ({
    id: item.id,
    slug: item.slug,
    kind: item.kind,
    // Filename-derived text is a safe temporary fallback until metadata matching supplies Persian.
    name: { fa: item.title.fa ?? item.title.en, en: item.title.en },
    playable: item.playable,
    ...(item.playable ? { resumeMediaItemId: item.resumeMediaItemId } : {}),
    synopsis: {},
    ...(item.kind === 'SERIES'
      ? { seasons: item.seasons.map((season) => ({ number: season.number, episodeCount: season.episodes.length })) }
      : {}),
    mediaItems: item.mediaItems.map((media): PublicMediaItem => ({
      id: media.id,
      kind: media.kind,
      ...(media.seasonNumber === undefined ? {} : { seasonNumber: media.seasonNumber }),
      ...(media.episodeNumber === undefined ? {} : { episodeNumber: media.episodeNumber }),
      name: { fa: media.title.fa ?? media.title.en, en: media.title.en },
      durationSeconds: media.durationSeconds,
      compatibility: media.compatibility,
      published: media.published,
    })),
    updatedAt: generatedAt,
  }));
  return {
    catalog: { version: 1, generatedAt, titles },
    inventory: { version: 1, generatedAt, archiveRoot: root, items },
  };
}

export function findMediaItem(snapshot: InventorySnapshot, idOrPath: string): SnapshotMediaItem | undefined {
  return snapshot.items.flatMap((item) => item.mediaItems)
    .find((media) => media.id === idOrPath || media.sourcePath === idOrPath);
}
