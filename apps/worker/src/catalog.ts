import { createHash } from 'node:crypto';
import { access, copyFile, mkdir } from 'node:fs/promises';
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
  category?: string;
  categorySlug?: string;
  year?: number;
  releaseWindow?: 'SPRING' | 'SUMMER' | 'FALL' | 'WINTER' | 'MOVIE';
  titleDirectory?: string;
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

export interface SnapshotMediaVariant {
  id: string;
  sourcePath: string;
  durationSeconds: number;
  qualityLabel: string;
  width?: number;
  height?: number;
  videoCodec?: string;
  available: boolean;
  compatibility: Classification['class'];
  compatibilityReasons: string[];
  fingerprint: SourceFingerprint;
  streams: NormalizedTrack[];
  subtitles: SnapshotSubtitle[];
}

export interface SnapshotMediaItem extends SnapshotMediaVariant {
  titleId: string;
  kind: 'MOVIE' | 'EPISODE';
  seasonNumber?: number;
  episodeNumber?: number;
  title: { en: string; fa?: string };
  published: boolean;
  variants?: SnapshotMediaVariant[];
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
  category?: string;
  categorySlug?: string;
  year?: number;
  releaseWindow?: 'SPRING' | 'SUMMER' | 'FALL' | 'WINTER' | 'MOVIE';
  posterUrl?: string;
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
  variants?: Array<{
    id: string;
    label: string;
    width?: number;
    height?: number;
    videoCodec?: string;
    compatibility: Classification['class'];
    available: boolean;
    isDefault: boolean;
  }>;
}

export interface PublicTitleDetail {
  id: string;
  slug: string;
  kind: CatalogKind;
  name: { fa: string; en?: string };
  posterUrl?: string;
  category?: string;
  categorySlug?: string;
  year?: number;
  releaseWindow?: 'SPRING' | 'SUMMER' | 'FALL' | 'WINTER' | 'MOVIE';
  playable: boolean;
  resumeMediaItemId?: string;
  variants?: PublicMediaItem['variants'];
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
  const segments = relativePath.split('/').filter(Boolean);
  const immediateParent = segments.at(-2) ?? '';
  const qualityDirectory = /^(?:\d{3,4}p?)(?:[\s._-]+(?:x26[45]|hevc|av1))?$|^(?:x26[45]|hevc|av1)$/iu.test(immediateParent);
  const titleDirectory = segments.at(qualityDirectory ? -3 : -2) ?? immediateParent;
  const titleIndex = Math.max(0, segments.length - (qualityDirectory ? 3 : 2));
  const hierarchy = segments.slice(0, titleIndex);
  const categorySource = hierarchy[0];
  const yearSource = hierarchy.find((segment) => /^(?:18|19|20|21|22)\d{2}$/u.test(segment));
  const releaseSource = hierarchy.find((segment) => /^(?:spring|summer|fall|winter|movie)$/iu.test(segment));
  const releaseWindow = releaseSource?.toLocaleUpperCase('en-US') as ParsedMediaIdentity['releaseWindow'];
  const category = categorySource ? cleanName(categorySource).replace(/^./u, (value) => value.toLocaleUpperCase('en-US')) : undefined;
  const combined = filename.match(/\bS(?:eason)?\s*(\d{1,3})\s*E(?:p(?:isode)?)?\s*(\d{1,4})\b/iu);
  const parentSeason = titleDirectory.match(/^(.*?)(?:[\s._-]+S(?:eason)?\s*(\d{1,3}))$/iu);
  const episode = combined?.[2]
    ?? filename.match(/(?:-|–)\s*(\d{1,4})(?=(?:[.\s_\[]|$))/u)?.[1]
    ?? filename.match(/\bE(?:p(?:isode)?)?\s*(\d{1,4})\b/iu)?.[1];
  const common = {
    ...(category ? { category, categorySlug: slugify(category) } : {}),
    ...(yearSource ? { year: Number(yearSource) } : {}),
    ...(releaseWindow ? { releaseWindow } : {}),
    ...(titleDirectory ? { titleDirectory: segments.slice(0, titleIndex + 1).join('/') } : {}),
  };
  if (episode !== undefined && releaseWindow !== 'MOVIE') {
    const season = Number(combined?.[1] ?? parentSeason?.[2] ?? 1);
    const title = cleanName(parentSeason?.[1] ?? titleDirectory);
    return {
      ...common,
      kind: 'SERIES',
      title: title || cleanName(filename),
      seasonNumber: season,
      episodeNumber: Number(episode),
      episodeTitle: `Episode ${Number(episode)}`,
    };
  }
  return { ...common, kind: 'MOVIE', title: cleanName(titleDirectory || filename) };
}

export interface ScanArchiveOptions {
  archiveRoot: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  onFile?: (relativePath: string, current: number) => void;
  artworkRoot?: string;
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
): Promise<{ identity: ParsedMediaIdentity; variant: SnapshotMediaVariant }> {
  const relativePath = path.relative(archiveRoot, sourcePath).split(path.sep).join('/');
  const identity = parseMediaIdentity(relativePath);
  const [probe, fingerprint] = await Promise.all([
    probeMedia(sourcePath, options.ffprobePath === undefined ? {} : { ffprobePath: options.ffprobePath }),
    fingerprintSource(archiveRoot, sourcePath),
  ]);
  const compatibility = classifyMedia(probe);
  const variantId = deterministicUuid(`variant:${relativePath}`);
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
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  const available = ['COPY', 'AUDIO_TRANSCODE'].includes(compatibility.class);
  const qualityLabel = video?.height ? `${video.height}p` : cleanName(path.basename(path.dirname(relativePath))) || 'Source';
  return {
    identity,
    variant: {
      id: variantId,
      sourcePath: relativePath,
      durationSeconds: Number.isFinite(duration) ? duration : 0,
      qualityLabel,
      ...(video?.width ? { width: video.width } : {}),
      ...(video?.height ? { height: video.height } : {}),
      ...(video?.codec_name ? { videoCodec: video.codec_name } : {}),
      available,
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
  const grouped = new Map<string, { identity: ParsedMediaIdentity; variants: SnapshotMediaVariant[] }>();
  let current = 0;
  for await (const sourcePath of walkArchive(root)) {
    current += 1;
    const relative = path.relative(root, sourcePath).split(path.sep).join('/');
    options.onFile?.(relative, current);
    const inspected = await inspectFile(sourcePath, root, options);
    const logical = inspected.identity.kind === 'MOVIE'
      ? 'movie'
      : `s${inspected.identity.seasonNumber ?? 1}e${inspected.identity.episodeNumber ?? 0}`;
    const key = `${inspected.identity.kind}:${inspected.identity.title.toLocaleLowerCase('en-US')}:${logical}`;
    const group = grouped.get(key) ?? { identity: inspected.identity, variants: [] };
    group.variants.push(inspected.variant);
    grouped.set(key, group);
  }
  const logicalItems = [...grouped.values()].map(({ identity, variants }) => {
    variants.sort(compareVariants);
    const selected = variants[0];
    if (!selected) throw new Error('Internal media group has no source variants');
    const titleId = deterministicUuid(`title:${identity.kind}:${identity.title.toLocaleLowerCase('en-US')}`);
    const logicalKey = identity.kind === 'MOVIE' ? 'movie' : `s${identity.seasonNumber ?? 1}e${identity.episodeNumber ?? 0}`;
    const media: SnapshotMediaItem = {
      ...selected,
      id: deterministicUuid(`media:${titleId}:${logicalKey}`),
      titleId,
      kind: identity.kind === 'SERIES' ? 'EPISODE' : 'MOVIE',
      ...(identity.seasonNumber === undefined ? {} : { seasonNumber: identity.seasonNumber }),
      ...(identity.episodeNumber === undefined ? {} : { episodeNumber: identity.episodeNumber }),
      title: { en: identity.episodeTitle ?? identity.title },
      published: variants.some((variant) => variant.available),
      variants,
    };
    return { identity, media };
  });
  const byTitle = new Map<string, { identity: ParsedMediaIdentity; media: SnapshotMediaItem[] }>();
  for (const entry of logicalItems) {
    const key = `${entry.identity.kind}:${entry.identity.title.toLocaleLowerCase('en-US')}`;
    const title = byTitle.get(key) ?? { identity: entry.identity, media: [] };
    title.media.push(entry.media);
    byTitle.set(key, title);
  }
  const items: SnapshotTitle[] = [...byTitle.values()].map(({ identity, media }) => {
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
      ...(identity.category ? { category: identity.category } : {}),
      ...(identity.categorySlug ? { categorySlug: identity.categorySlug } : {}),
      ...(identity.year ? { year: identity.year } : {}),
      ...(identity.releaseWindow ? { releaseWindow: identity.releaseWindow } : {}),
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
  for (const item of items) {
    const identity = byTitle.get(`${item.kind}:${item.title.en.toLocaleLowerCase('en-US')}`)?.identity;
    if (!identity?.titleDirectory) continue;
    const source = await findThumbnail(path.join(root, identity.titleDirectory));
    if (!source) continue;
    const extension = path.extname(source).toLocaleLowerCase('en-US').replace('.jpeg', '.jpg');
    item.posterUrl = `/images/archive/${item.id}${extension}`;
    if (options.artworkRoot) {
      await mkdir(options.artworkRoot, { recursive: true, mode: 0o750 });
      await copyFile(source, path.join(options.artworkRoot, `${item.id}${extension}`));
    }
  }
  items.sort((left, right) => left.title.en.localeCompare(right.title.en));
  const generatedAt = new Date().toISOString();
  const titles: PublicTitleDetail[] = items.map((item) => ({
    id: item.id,
    slug: item.slug,
    kind: item.kind,
    // Filename-derived text is a safe temporary fallback until metadata matching supplies Persian.
    name: { fa: item.title.fa ?? item.title.en, en: item.title.en },
    ...(item.posterUrl ? { posterUrl: item.posterUrl } : {}),
    ...(item.category ? { category: item.category } : {}),
    ...(item.categorySlug ? { categorySlug: item.categorySlug } : {}),
    ...(item.year ? { year: item.year } : {}),
    ...(item.releaseWindow ? { releaseWindow: item.releaseWindow } : {}),
    playable: item.playable,
    ...(item.playable ? { resumeMediaItemId: item.resumeMediaItemId } : {}),
    ...(item.mediaItems[0]?.variants ? {
      variants: item.mediaItems[0].variants.map((variant, index) => ({
        id: variant.id,
        label: variant.qualityLabel,
        ...(variant.width ? { width: variant.width } : {}),
        ...(variant.height ? { height: variant.height } : {}),
        ...(variant.videoCodec ? { videoCodec: variant.videoCodec } : {}),
        compatibility: variant.compatibility,
        available: variant.available,
        isDefault: index === 0,
      })),
    } : {}),
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
      variants: (media.variants ?? [media]).map((variant, index) => ({
        id: variant.id,
        label: variant.qualityLabel,
        ...(variant.width ? { width: variant.width } : {}),
        ...(variant.height ? { height: variant.height } : {}),
        ...(variant.videoCodec ? { videoCodec: variant.videoCodec } : {}),
        compatibility: variant.compatibility,
        available: variant.available,
        isDefault: index === 0,
      })),
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

export function findMediaVariant(
  snapshot: InventorySnapshot,
  mediaItemId: string,
  variantId?: string,
): SnapshotMediaItem | undefined {
  const media = findMediaItem(snapshot, mediaItemId);
  if (!media || variantId === undefined) return media;
  const variant = media.variants?.find((candidate) => candidate.id === variantId);
  return variant ? { ...media, ...variant, id: media.id, ...(media.variants ? { variants: media.variants } : {}) } : undefined;
}

function compareVariants(left: SnapshotMediaVariant, right: SnapshotMediaVariant): number {
  if (left.available !== right.available) return left.available ? -1 : 1;
  const leftHeight = left.height ?? 0;
  const rightHeight = right.height ?? 0;
  const leftDistance = Math.abs(leftHeight - 720);
  const rightDistance = Math.abs(rightHeight - 720);
  if (leftDistance !== rightDistance) return leftDistance - rightDistance;
  if ((leftHeight <= 720) !== (rightHeight <= 720)) return leftHeight <= 720 ? -1 : 1;
  if (left.compatibility !== right.compatibility) return left.compatibility === 'COPY' ? -1 : 1;
  return left.sourcePath.localeCompare(right.sourcePath);
}

async function findThumbnail(directory: string): Promise<string | undefined> {
  for (const filename of ['thumbnail.jpg', 'thumbnail.jpeg', 'thumbnail.png', 'thumbnail.webp']) {
    const candidate = path.join(directory, filename);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next supported local artwork extension.
    }
  }
  return undefined;
}
