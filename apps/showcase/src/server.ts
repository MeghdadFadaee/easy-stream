import { randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { ShowcaseConfig } from './config.js';
import { buildShowcaseSnapshot } from './snapshot.js';

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
    const snapshot = buildShowcaseSnapshot(db);
    const all = snapshot.titles.filter((entry) => {
      const title = entry as { categorySlug?: string };
      return !request.query.category || title.categorySlug === request.query.category;
    });
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 40));
    return { items: all.slice(0, limit), total: all.length };
  });
  app.get<{ Querystring: { limitPerSection?: string } }>('/api/v1/catalog/sections', async (request) => {
    const limit = Math.min(40, Math.max(1, Number(request.query.limitPerSection) || 12));
    const snapshot = buildShowcaseSnapshot(db);
    return { sections: snapshot.sections.map((section) => ({ ...section, items: section.items.slice(0, limit), hasMore: section.items.length > limit })) };
  });
  app.get<{ Params: { slug: string } }>('/api/v1/titles/:slug', async (request, reply) => {
    const title = buildShowcaseSnapshot(db).titles.find((entry) => (entry as { slug?: string }).slug === request.params.slug);
    if (!title) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Title not found' } });
    return title;
  });
  app.post<{ Body: { mediaItemId?: string; variantId?: string } }>('/api/v1/playback-sessions', async (request, reply) => {
    const mediaId = request.body?.mediaItemId;
    if (!mediaId) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'mediaItemId is required' } });
    const snapshot = buildShowcaseSnapshot(db);
    const variantId = request.body.variantId ?? snapshot.defaultVariantByMedia[mediaId];
    const playback = variantId ? snapshot.playbackByVariant[variantId] : undefined;
    if (!playback || playback.mediaItemId !== mediaId) return reply.code(404).send({ error: { code: 'NOT_PREPARED', message: 'This media is not prepared for playback' } });
    return {
      id: randomUUID(), state: 'READY', ...playback, pollAfterMs: 1000,
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
