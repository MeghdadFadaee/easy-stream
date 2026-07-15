import { randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { ShowcaseConfig } from './config.js';
import type { VariantRow } from './database.js';

interface TitleRow {
  id: string; slug: string; kind: string; name_fa: string; name_en: string | null;
  synopsis_fa: string | null; synopsis_en: string | null; poster_url: string | null;
  category: string | null; category_slug: string | null; release_year: number | null;
  release_window: string | null; updated_at: string;
}
interface MediaRow { id: string; title_id: string; kind: string; season_number: number | null; episode_number: number | null; name_fa: string | null; name_en: string | null; duration_seconds: number }

function readyVariants(db: DatabaseSync, mediaId: string): VariantRow[] {
  return db.prepare("SELECT * FROM variants WHERE media_item_id=? AND status='READY' ORDER BY abs(coalesce(height,720)-720),height").all(mediaId) as unknown as VariantRow[];
}

function variantJson(row: VariantRow, index: number) {
  return { id: row.id, label: row.label, width: row.width ?? undefined, height: row.height ?? undefined, videoCodec: row.video_codec ?? undefined, compatibility: row.compatibility, available: true, isDefault: index === 0 };
}

function titleJson(db: DatabaseSync, title: TitleRow, detail = false) {
  const media = db.prepare('SELECT * FROM media_items WHERE title_id=? ORDER BY coalesce(season_number,0),coalesce(episode_number,0)').all(title.id) as unknown as MediaRow[];
  const playable = media.map((item) => ({ item, variants: readyVariants(db, item.id) })).filter((entry) => entry.variants.length);
  const first = playable[0];
  const seasons = new Set(playable.map(({ item }) => item.season_number).filter((value) => value !== null));
  const base = {
    id: title.id,
    slug: title.slug,
    kind: title.kind,
    name: { fa: title.name_fa, en: title.name_en ?? undefined },
    title: { fa: title.name_fa, en: title.name_en ?? undefined },
    synopsis: { fa: title.synopsis_fa ?? undefined, en: title.synopsis_en ?? undefined },
    posterUrl: title.poster_url ?? undefined,
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
      id: item.id, mediaItemId: item.id, kind: item.kind,
      seasonNumber: item.season_number ?? undefined, episodeNumber: item.episode_number ?? undefined,
      name: { fa: item.name_fa ?? undefined, en: item.name_en ?? undefined },
      durationSeconds: item.duration_seconds, published: true, variants: variants.map(variantJson),
    })),
  };
}

function visibleTitles(db: DatabaseSync): TitleRow[] {
  return db.prepare(`SELECT DISTINCT t.* FROM titles t JOIN media_items m ON m.title_id=t.id JOIN variants v ON v.media_item_id=m.id WHERE v.status='READY' ORDER BY t.name_en,t.name_fa`).all() as unknown as TitleRow[];
}

export async function createServer(db: DatabaseSync, config: ShowcaseConfig) {
  await access(config.webRoot).catch(() => { throw new Error('Viewer build is missing. Run `pnpm showcase:build` first.'); });
  await Promise.all([mkdir(config.mediaRoot, { recursive: true }), mkdir(config.artworkRoot, { recursive: true })]);
  const app = Fastify({ logger: true });
  await app.register(fastifyStatic, { root: config.webRoot, prefix: '/', wildcard: false });
  await app.register(fastifyStatic, { root: config.mediaRoot, prefix: '/media/', decorateReply: false, setHeaders(response, filename) {
    if (filename.endsWith('.m3u8')) response.setHeader('content-type', 'application/vnd.apple.mpegurl');
    else if (filename.endsWith('.m4s') || filename.endsWith('.mp4')) response.setHeader('content-type', 'video/mp4');
    response.setHeader('cache-control', filename.endsWith('.m3u8') ? 'no-cache' : 'public, max-age=31536000, immutable');
  } });
  await app.register(fastifyStatic, { root: config.artworkRoot, prefix: '/images/archive/', decorateReply: false });

  app.get('/healthz', async () => ({ status: 'ok', time: new Date().toISOString(), edition: 'showcase' }));
  app.get<{ Querystring: { limit?: string; category?: string } }>('/api/v1/catalog', async (request) => {
    const all = visibleTitles(db).filter((title) => !request.query.category || title.category_slug === request.query.category);
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 40));
    return { items: all.slice(0, limit).map((title) => titleJson(db, title)), total: all.length };
  });
  app.get<{ Querystring: { limitPerSection?: string } }>('/api/v1/catalog/sections', async (request) => {
    const limit = Math.min(40, Math.max(1, Number(request.query.limitPerSection) || 12));
    const groups = new Map<string, { name: string; items: TitleRow[] }>();
    for (const title of visibleTitles(db)) {
      const slug = title.category_slug ?? 'showcase';
      const group = groups.get(slug) ?? { name: title.category ?? 'Showcase', items: [] };
      group.items.push(title);
      groups.set(slug, group);
    }
    return { sections: [...groups].map(([slug, group]) => ({ slug, name: group.name, items: group.items.slice(0, limit).map((title) => titleJson(db, title)), hasMore: group.items.length > limit })) };
  });
  app.get<{ Params: { slug: string } }>('/api/v1/titles/:slug', async (request, reply) => {
    const title = db.prepare('SELECT * FROM titles WHERE slug=?').get(request.params.slug) as unknown as TitleRow | undefined;
    if (!title || !visibleTitles(db).some((candidate) => candidate.id === title.id)) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Title not found' } });
    return titleJson(db, title, true);
  });
  app.post<{ Body: { mediaItemId?: string; variantId?: string } }>('/api/v1/playback-sessions', async (request, reply) => {
    const mediaId = request.body?.mediaItemId;
    if (!mediaId) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'mediaItemId is required' } });
    const rows = readyVariants(db, mediaId);
    const variant = request.body.variantId ? rows.find((row) => row.id === request.body.variantId) : rows[0];
    const media = db.prepare('SELECT * FROM media_items WHERE id=?').get(mediaId) as unknown as MediaRow | undefined;
    if (!variant || !media) return reply.code(404).send({ error: { code: 'NOT_PREPARED', message: 'This media is not prepared for playback' } });
    return {
      id: randomUUID(), state: 'READY', mediaItemId: mediaId, variantId: variant.id,
      qualityLabel: variant.label, manifestUrl: variant.manifest_path, generationId: variant.generation_id,
      durationSeconds: media.duration_seconds, audioTracks: JSON.parse(variant.audio_tracks),
      subtitleTracks: JSON.parse(variant.subtitle_tracks), pollAfterMs: 1000,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  });
  app.post('/api/v1/client-events', async (_request, reply) => reply.code(202).send({ ok: true }));
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/media/') || request.url.startsWith('/images/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    return reply.type('text/html').sendFile('index.html', config.webRoot);
  });
  return app;
}

export async function startServer(db: DatabaseSync, config: ShowcaseConfig): Promise<void> {
  const app = await createServer(db, config);
  await app.listen({ host: config.host, port: config.port });
  console.log(`Easy Stream Showcase: http://${config.host}:${config.port}`);
}
