import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import {
  AdminLoginSchema,
  AdminSessionResponseSchema,
  CacheParamsSchema,
  CacheStatusSchema,
  CatalogQuerySchema,
  CatalogResponseSchema,
  CreatePlaybackSessionSchema,
  DateTimeSchema,
  ErrorResponseSchema,
  JobParamsSchema,
  JobSchema,
  MetadataCandidateSchema,
  MetadataMatchBodySchema,
  MetadataMatchParamsSchema,
  MetadataSearchQuerySchema,
  MetadataSearchResponseSchema,
  PlaybackSessionParamsSchema,
  PlaybackSessionSchema,
  PublicationBodySchema,
  PublicationParamsSchema,
  SearchQuerySchema,
  SearchResponseSchema,
  StartScanSchema,
  TitleDetailSchema,
  UuidSchema,
  type AdminLogin,
  type CatalogQuery,
  type CreatePlaybackSession,
  type MetadataMatchBody,
  type MetadataSearchQuery,
  type SearchQuery,
  type StartScan,
} from '@easy-stream/contracts';
import { createDatabase } from '@easy-stream/database';
import { Type, type Static } from '@sinclair/typebox';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { loadConfig, type ApiConfig } from './config.js';
import { PlaybackGrantSigner, playbackCookieName } from './crypto.js';
import type {
  AppRepository,
  MediaCommandPublisher,
  MediaPreparationService,
  MetadataProvider,
  PasswordHasher,
  StoredPlaybackSession,
  TotpVerifier,
} from './domain.js';
import { AppError } from './errors.js';
import { InMemoryRepository, loadCatalogSnapshot } from './repositories/in-memory.js';
import { PostgresRepository } from './repositories/postgres.js';
import { AdminService, Argon2PasswordHasher, DenyEncryptedTotpVerifier } from './services/admin.js';
import {
  FileMediaPreparationService,
  BullMqMediaBridge,
  JsonlMediaCommandPublisher,
} from './services/media-preparation.js';
import { PlaybackService } from './services/playback.js';
import {
  FilesystemCacheStatusService,
  type CacheStatusService,
} from './services/cache-status.js';
import { createMetadataProvider } from './services/tmdb.js';

interface BuildAppOptions {
  config?: ApiConfig;
  repository?: AppRepository;
  mediaPreparation?: MediaPreparationService;
  commandPublisher?: MediaCommandPublisher;
  metadataProvider?: MetadataProvider;
  passwordHasher?: PasswordHasher;
  totpVerifier?: TotpVerifier;
  cacheStatus?: CacheStatusService;
  fetch?: typeof globalThis.fetch;
  logger?: boolean;
}

const SlugParamsSchema = Type.Object(
  { slug: Type.String({ minLength: 1, maxLength: 240 }) },
  { additionalProperties: false },
);
const OkSchema = Type.Object({ ok: Type.Literal(true) }, { additionalProperties: false });
const HealthSchema = Type.Object(
  {
    status: Type.Literal('ok'),
    time: Type.String(),
    repository: Type.Union([Type.Literal('memory'), Type.Literal('postgres')]),
  },
  { additionalProperties: false },
);
const JobsResponseSchema = Type.Object(
  { items: Type.Array(JobSchema) },
  { additionalProperties: false },
);
const ClientEventSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9._-]+$' }),
    mediaItemId: Type.Optional(UuidSchema),
    sessionId: Type.Optional(UuidSchema),
    occurredAt: DateTimeSchema,
    details: Type.Optional(
      Type.Record(
        Type.String({ minLength: 1, maxLength: 64 }),
        Type.Union([
          Type.String({ maxLength: 2048 }),
          Type.Number(),
          Type.Boolean(),
          Type.Null(),
        ]),
      ),
    ),
  },
  { additionalProperties: false },
);

type PublicationBody = Static<typeof PublicationBodySchema>;

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    logger: options.logger ?? config.nodeEnv !== 'test',
    genReqId: (request) =>
      typeof request.headers['x-request-id'] === 'string'
        ? request.headers['x-request-id'].slice(0, 128)
        : randomUUID(),
    bodyLimit: 64 * 1024,
    trustProxy: config.nodeEnv === 'production' ? 1 : false,
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: config.webOrigin,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'x-request-id'],
  });
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
  });

  const runtime = await createRepository(app, config, options.repository);
  const repository = runtime.repository;
  const cacheStatus = options.cacheStatus ?? new FilesystemCacheStatusService({
    cacheRoot: config.cacheRoot,
    maxBytes: config.cacheMaxBytes,
    highWatermark: config.cacheHighWatermark,
    lowWatermark: config.cacheLowWatermark,
  });
  const redisBridge =
    config.redisUrl && (!options.commandPublisher || !options.mediaPreparation)
      ? new BullMqMediaBridge(config.redisUrl, config.packageRegistryPath, config.playbackProfile)
      : undefined;
  if (redisBridge) app.addHook('onClose', async () => redisBridge.close());
  const commands =
    options.commandPublisher ??
    redisBridge ??
    new JsonlMediaCommandPublisher(config.mediaCommandsPath);
  const media =
    options.mediaPreparation ??
    redisBridge ??
    new FileMediaPreparationService(config.packageRegistryPath, commands);
  const metadata =
    options.metadataProvider ?? createMetadataProvider(config, options.fetch ?? globalThis.fetch);
  const playback = new PlaybackService(repository, media, config);
  const admin = new AdminService(
    repository,
    commands,
    media,
    metadata,
    options.passwordHasher ?? new Argon2PasswordHasher(),
    options.totpVerifier ?? new DenyEncryptedTotpVerifier(),
    config,
  );
  await admin.initialize();
  const grantSigner = new PlaybackGrantSigner(config.playbackSigningSecret);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      });
    }
    if (typeof error === 'object' && error && 'validation' in error && error.validation) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          requestId: request.id,
          details: error.validation,
        },
      });
    }
    request.log.error({ err: error }, 'unhandled request error');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: request.id },
    });
  });

  app.get('/health', { schema: { response: { 200: HealthSchema } } }, async () => ({
    status: 'ok' as const,
    time: new Date().toISOString(),
    repository: config.repositoryDriver,
  }));

  app.get<{ Querystring: CatalogQuery }>(
    '/api/v1/catalog',
    {
      schema: {
        querystring: CatalogQuerySchema,
        response: { 200: CatalogResponseSchema, 400: ErrorResponseSchema },
      },
    },
    async (request) => repository.listCatalog(request.query),
  );

  app.get<{ Params: Static<typeof SlugParamsSchema> }>(
    '/api/v1/titles/:slug',
    {
      schema: {
        params: SlugParamsSchema,
        response: { 200: TitleDetailSchema, 404: ErrorResponseSchema },
      },
    },
    async (request) => {
      const title = await repository.getTitleBySlug(request.params.slug);
      if (!title) throw new AppError(404, 'NOT_FOUND', 'Title not found');
      return title;
    },
  );

  app.get<{ Querystring: SearchQuery }>(
    '/api/v1/search',
    {
      schema: {
        querystring: SearchQuerySchema,
        response: { 200: SearchResponseSchema, 400: ErrorResponseSchema },
      },
    },
    async (request) => ({ items: await repository.searchTitles(request.query) }),
  );

  app.post<{ Body: Static<typeof ClientEventSchema> }>(
    '/api/v1/client-events',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        body: ClientEventSchema,
        response: { 202: OkSchema, 400: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      request.log.info({ clientEvent: request.body }, 'client playback event');
      return reply.code(202).send({ ok: true as const });
    },
  );

  app.post<{ Body: CreatePlaybackSession }>(
    '/api/v1/playback-sessions',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: {
        body: CreatePlaybackSessionSchema,
        response: {
          200: PlaybackSessionSchema,
          202: PlaybackSessionSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const session = await playback.create(request.body);
      if (session.state === 'READY') issuePlaybackCookie(reply, session, grantSigner, config);
      return reply.code(session.state === 'PREPARING' ? 202 : 200).send(playback.toPublic(session));
    },
  );

  app.get<{ Params: Static<typeof PlaybackSessionParamsSchema> }>(
    '/api/v1/playback-sessions/:id',
    {
      schema: {
        params: PlaybackSessionParamsSchema,
        response: { 200: PlaybackSessionSchema, 202: PlaybackSessionSchema, 404: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const session = await playback.get(request.params.id);
      if (session.state === 'READY') issuePlaybackCookie(reply, session, grantSigner, config);
      return reply.code(session.state === 'PREPARING' ? 202 : 200).send(playback.toPublic(session));
    },
  );

  app.get(
    '/internal/media-auth',
    { config: { rateLimit: false } },
    async (request, reply) => {
      if (header(request, 'x-media-auth-secret') !== config.mediaAuthSharedSecret) {
        throw new AppError(401, 'UNAUTHORIZED', 'Invalid media authorization secret');
      }
      const originalUri = header(request, 'x-original-uri');
      if (!originalUri || /%2f|%5c|%2e/i.test(originalUri)) {
        throw new AppError(401, 'UNAUTHORIZED', 'Invalid media request path');
      }
      const pathname = new URL(originalUri, config.publicOrigin).pathname;
      const match = pathname.match(
        /^\/media\/(?:derived\/)?generations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\//i,
      );
      const generationId = match?.[1];
      if (!generationId) throw new AppError(401, 'UNAUTHORIZED', 'Invalid media request path');
      const token = request.cookies[playbackCookieName(generationId)];
      const grant = token ? grantSigner.verify(token) : undefined;
      if (
        !grant ||
        grant.generationId !== generationId ||
        grant.expiresAtEpochSeconds <= Math.floor(Date.now() / 1000) ||
        !pathname.startsWith(grant.path)
      ) {
        throw new AppError(401, 'UNAUTHORIZED', 'Media authorization expired or invalid');
      }
      const session = await repository.getPlaybackSession(grant.sessionId);
      if (
        !session ||
        session.state !== 'READY' ||
        session.generationId !== generationId ||
        Date.parse(session.expiresAt) <= Date.now()
      ) {
        throw new AppError(401, 'UNAUTHORIZED', 'Playback session expired or invalid');
      }
      return reply.code(204).send();
    },
  );

  app.post<{ Body: AdminLogin }>(
    '/api/v1/admin/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: AdminLoginSchema,
        response: { 200: AdminSessionResponseSchema, 401: ErrorResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await admin.login(request.body);
      reply.setCookie('es_admin_session', result.rawToken, adminCookie(config));
      return result.response;
    },
  );

  const adminRead = async (request: FastifyRequest) => {
    await admin.authenticate(request.cookies.es_admin_session);
  };
  const adminWrite = async (request: FastifyRequest) => {
    const csrf = header(request, 'x-csrf-token');
    if (!csrf) throw new AppError(403, 'FORBIDDEN', 'CSRF token is required');
    await admin.authenticate(request.cookies.es_admin_session, csrf);
  };

  app.post(
    '/api/v1/admin/logout',
    { preHandler: adminWrite, schema: { response: { 200: OkSchema } } },
    async (request, reply) => {
      await admin.logout(request.cookies.es_admin_session, header(request, 'x-csrf-token'));
      reply.clearCookie('es_admin_session', { path: '/' });
      return { ok: true as const };
    },
  );

  app.post<{ Body: StartScan }>(
    '/api/v1/admin/scans',
    {
      preHandler: adminWrite,
      schema: { body: StartScanSchema, response: { 202: JobSchema } },
    },
    async (request, reply) => reply.code(202).send(await admin.startScan(request.body.full ?? false)),
  );

  app.patch<{
    Params: Static<typeof PublicationParamsSchema>;
    Body: PublicationBody;
  }>(
    '/api/v1/admin/media/:mediaItemId/publication',
    {
      preHandler: adminWrite,
      schema: {
        params: PublicationParamsSchema,
        body: PublicationBodySchema,
        response: { 200: OkSchema },
      },
    },
    async (request) => {
      await admin.setPublished(request.params.mediaItemId, request.body.published);
      return { ok: true as const };
    },
  );

  app.get(
    '/api/v1/admin/jobs',
    { preHandler: adminRead, schema: { response: { 200: JobsResponseSchema } } },
    async () => ({ items: await repository.listJobs() }),
  );

  app.post<{ Params: Static<typeof JobParamsSchema> }>(
    '/api/v1/admin/jobs/:jobId/retry',
    {
      preHandler: adminWrite,
      schema: { params: JobParamsSchema, response: { 202: JobSchema } },
    },
    async (request, reply) => reply.code(202).send(await admin.retryJob(request.params.jobId)),
  );

  app.get(
    '/api/v1/admin/cache',
    { preHandler: adminRead, schema: { response: { 200: CacheStatusSchema } } },
    async () => cacheStatus.getStatus(),
  );

  app.post<{ Params: Static<typeof CacheParamsSchema> }>(
    '/api/v1/admin/cache/:generationId/evict',
    {
      preHandler: adminWrite,
      schema: { params: CacheParamsSchema, response: { 202: OkSchema } },
    },
    async (request, reply) => {
      await admin.evict(request.params.generationId);
      return reply.code(202).send({ ok: true as const });
    },
  );

  app.get<{ Querystring: MetadataSearchQuery }>(
    '/api/v1/admin/metadata/tmdb/search',
    {
      preHandler: adminRead,
      schema: {
        querystring: MetadataSearchQuerySchema,
        response: { 200: MetadataSearchResponseSchema },
      },
    },
    async (request) => ({ items: await admin.searchMetadata(request.query) }),
  );

  app.post<{
    Params: Static<typeof MetadataMatchParamsSchema>;
    Body: MetadataMatchBody;
  }>(
    '/api/v1/admin/titles/:titleId/metadata-match',
    {
      preHandler: adminWrite,
      schema: {
        params: MetadataMatchParamsSchema,
        body: MetadataMatchBodySchema,
        response: { 200: MetadataCandidateSchema },
      },
    },
    async (request) => admin.matchMetadata(request.params.titleId, request.body),
  );

  await app.ready();
  return app;
}

async function createRepository(
  app: FastifyInstance,
  config: ApiConfig,
  injected: AppRepository | undefined,
): Promise<{ repository: AppRepository }> {
  if (injected) return { repository: injected };
  if (config.repositoryDriver === 'memory') {
    const snapshot = await loadCatalogSnapshot(config.catalogSnapshotPath);
    const repository = new InMemoryRepository({
      ...(snapshot ? { titles: snapshot.titles } : {}),
      cache: {
        maxBytes: config.cacheMaxBytes,
        highWatermark: config.cacheHighWatermark,
        lowWatermark: config.cacheLowWatermark,
      },
    });
    if (snapshot) app.log.info({ path: config.catalogSnapshotPath }, 'loaded catalog snapshot');
    else app.log.warn({ path: config.catalogSnapshotPath }, 'catalog snapshot not found; catalog is empty');
    return { repository };
  }
  const connection = createDatabase(config.databaseUrl!);
  app.addHook('onClose', async () => connection.close());
  return {
    repository: new PostgresRepository(connection.db, {
      cacheMaxBytes: config.cacheMaxBytes,
      cacheHighWatermark: config.cacheHighWatermark,
      cacheLowWatermark: config.cacheLowWatermark,
    }),
  };
}

function issuePlaybackCookie(
  reply: FastifyReply,
  session: StoredPlaybackSession,
  signer: PlaybackGrantSigner,
  config: ApiConfig,
): void {
  if (!session.generationId || !session.manifestUrl) return;
  const manifestPath = new URL(session.manifestUrl).pathname;
  const match = manifestPath.match(
    /^\/media\/(?:derived\/)?generations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\//i,
  );
  if (!match || match[1]?.toLowerCase() !== session.generationId.toLowerCase()) return;
  const path = match[0];
  const expiresAtEpochSeconds = Math.floor(Date.parse(session.expiresAt) / 1000);
  reply.setCookie(
    playbackCookieName(session.generationId),
    signer.sign({
      version: 1,
      sessionId: session.id,
      generationId: session.generationId,
      path,
      expiresAtEpochSeconds,
    }),
    {
      httpOnly: true,
      secure: config.nodeEnv === 'production',
      sameSite: 'lax',
      path,
      expires: new Date(session.expiresAt),
    },
  );
}

function adminCookie(config: ApiConfig) {
  return {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: config.adminSessionTtlSeconds,
  };
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
