import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const ConfigSchema = Type.Object(
  {
    nodeEnv: Type.Union([
      Type.Literal('development'),
      Type.Literal('test'),
      Type.Literal('production'),
    ]),
    host: Type.String({ minLength: 1 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    webOrigin: Type.String({ pattern: '^https?://[^\\s]+$' }),
    publicOrigin: Type.String({ pattern: '^https?://[^\\s]+$' }),
    mediaPublicBaseUrl: Type.String({ pattern: '^https?://[^\\s]+$' }),
    repositoryDriver: Type.Union([Type.Literal('memory'), Type.Literal('postgres')]),
    databaseUrl: Type.Optional(Type.String({ minLength: 1 })),
    redisUrl: Type.Optional(Type.String({ pattern: '^rediss?://[^\\s]+$' })),
    catalogSnapshotPath: Type.String({ minLength: 1 }),
    packageRegistryPath: Type.String({ minLength: 1 }),
    mediaCommandsPath: Type.String({ minLength: 1 }),
    cacheRoot: Type.String({ minLength: 1 }),
    playbackProfile: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: '^[a-zA-Z0-9._-]+$',
    }),
    playbackSigningSecret: Type.String({ minLength: 32 }),
    // This value is substituted into an Nginx quoted string, so keep it to a
    // portable base64url/hex alphabet rather than accepting config syntax.
    mediaAuthSharedSecret: Type.String({
      minLength: 32,
      maxLength: 256,
      pattern: '^[A-Za-z0-9_-]+$',
    }),
    playbackTtlSeconds: Type.Integer({ minimum: 300, maximum: 86400 }),
    adminSessionTtlSeconds: Type.Integer({ minimum: 300, maximum: 86400 }),
    adminBootstrapEmail: Type.Optional(
      Type.String({ maxLength: 320, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' }),
    ),
    adminBootstrapPassword: Type.Optional(Type.String({ minLength: 12 })),
    tmdbApiToken: Type.Optional(Type.String({ minLength: 1 })),
    tmdbCommercialLicenseConfirmed: Type.Boolean(),
    tmdbBaseUrl: Type.String({ pattern: '^https?://[^\\s]+$' }),
    tmdbTimeoutMs: Type.Integer({ minimum: 250, maximum: 30000 }),
    tmdbMaxRetries: Type.Integer({ minimum: 0, maximum: 5 }),
    cacheMaxBytes: Type.Integer({ minimum: 1 }),
    cacheHighWatermark: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    cacheLowWatermark: Type.Number({ minimum: 0, exclusiveMaximum: 1 }),
  },
  { additionalProperties: false },
);

export interface ApiConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  webOrigin: string;
  publicOrigin: string;
  mediaPublicBaseUrl: string;
  repositoryDriver: 'memory' | 'postgres';
  databaseUrl?: string;
  redisUrl?: string;
  catalogSnapshotPath: string;
  packageRegistryPath: string;
  mediaCommandsPath: string;
  cacheRoot: string;
  playbackProfile: string;
  playbackSigningSecret: string;
  mediaAuthSharedSecret: string;
  playbackTtlSeconds: number;
  adminSessionTtlSeconds: number;
  adminBootstrapEmail?: string;
  adminBootstrapPassword?: string;
  tmdbApiToken?: string;
  tmdbCommercialLicenseConfirmed: boolean;
  tmdbBaseUrl: string;
  tmdbTimeoutMs: number;
  tmdbMaxRetries: number;
  cacheMaxBytes: number;
  cacheHighWatermark: number;
  cacheLowWatermark: number;
}

function integer(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  if (!/^-?[0-9]+$/.test(value)) return Number.NaN;
  return Number(value);
}

function decimal(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  return Number(value);
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Expected a boolean, received ${JSON.stringify(value)}`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const signingSecret = env.PLAYBACK_SIGNING_SECRET ?? '';
  const config: ApiConfig = {
    nodeEnv: nodeEnv as ApiConfig['nodeEnv'],
    host: env.HOST ?? '0.0.0.0',
    port: integer(env.PORT, 3000),
    webOrigin: env.WEB_ORIGIN ?? 'http://localhost:5173',
    publicOrigin: env.PUBLIC_ORIGIN ?? 'http://localhost:8080',
    mediaPublicBaseUrl: env.MEDIA_PUBLIC_BASE_URL ?? 'http://localhost:8080/media',
    repositoryDriver:
      (env.REPOSITORY_DRIVER as ApiConfig['repositoryDriver'] | undefined) ??
      (nodeEnv === 'production' ? 'postgres' : 'memory'),
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    ...(env.REDIS_URL ? { redisUrl: env.REDIS_URL } : {}),
    catalogSnapshotPath: env.CATALOG_SNAPSHOT_PATH ?? './data/catalog.json',
    packageRegistryPath: env.PACKAGE_REGISTRY_PATH ?? './data/package-registry.json',
    mediaCommandsPath: env.MEDIA_COMMANDS_PATH ?? './data/media-commands.jsonl',
    cacheRoot: env.CACHE_ROOT ?? './data/cache',
    playbackProfile: env.PLAYBACK_PROFILE ?? 'cmaf-v1',
    playbackSigningSecret: signingSecret,
    mediaAuthSharedSecret: env.MEDIA_AUTH_SHARED_SECRET ?? signingSecret,
    playbackTtlSeconds: integer(env.PLAYBACK_TTL_SECONDS, 4 * 60 * 60),
    adminSessionTtlSeconds: integer(env.ADMIN_SESSION_TTL_SECONDS, 8 * 60 * 60),
    ...(env.ADMIN_BOOTSTRAP_EMAIL ? { adminBootstrapEmail: env.ADMIN_BOOTSTRAP_EMAIL } : {}),
    ...(env.ADMIN_BOOTSTRAP_PASSWORD
      ? { adminBootstrapPassword: env.ADMIN_BOOTSTRAP_PASSWORD }
      : {}),
    ...(env.TMDB_API_TOKEN ? { tmdbApiToken: env.TMDB_API_TOKEN } : {}),
    tmdbCommercialLicenseConfirmed: bool(env.TMDB_COMMERCIAL_LICENSE_CONFIRMED, false),
    tmdbBaseUrl: env.TMDB_BASE_URL ?? 'https://api.themoviedb.org/3',
    tmdbTimeoutMs: integer(env.TMDB_TIMEOUT_MS, 4000),
    tmdbMaxRetries: integer(env.TMDB_MAX_RETRIES, 2),
    cacheMaxBytes: integer(env.CACHE_MAX_BYTES, 2_147_483_648_000),
    cacheHighWatermark: decimal(env.CACHE_HIGH_WATERMARK, 0.85),
    cacheLowWatermark: decimal(env.CACHE_LOW_WATERMARK, 0.75),
  };

  if (!Value.Check(ConfigSchema, config)) {
    const errors = [...Value.Errors(ConfigSchema, config)]
      .map((error) => `${error.path || '/'} ${error.message}`)
      .join('; ');
    throw new Error(`Invalid API configuration: ${errors}`);
  }
  if (config.repositoryDriver === 'postgres' && !config.databaseUrl) {
    throw new Error('DATABASE_URL is required when REPOSITORY_DRIVER=postgres');
  }
  if (config.cacheLowWatermark >= config.cacheHighWatermark) {
    throw new Error('CACHE_LOW_WATERMARK must be lower than CACHE_HIGH_WATERMARK');
  }
  const mediaBase = new URL(config.mediaPublicBaseUrl);
  if (mediaBase.pathname.replace(/\/+$/u, '') !== '/media' || mediaBase.search || mediaBase.hash) {
    throw new Error('MEDIA_PUBLIC_BASE_URL must use the /media path without query or fragment');
  }
  if (
    config.nodeEnv === 'production' &&
    config.adminBootstrapPassword === 'change-me-before-production'
  ) {
    throw new Error('The example administrator password is forbidden in production');
  }
  if (
    config.nodeEnv === 'production' &&
    [
      'replace-with-at-least-32-random-characters',
      'replace-with-another-32-random-character-secret',
    ].includes(config.playbackSigningSecret)
  ) {
    throw new Error('The example playback signing secret is forbidden in production');
  }
  if (
    config.nodeEnv === 'production' &&
    [
      'replace-with-at-least-32-random-characters',
      'replace-with-another-32-random-character-secret',
    ].includes(config.mediaAuthSharedSecret)
  ) {
    throw new Error('The example media auth secret is forbidden in production');
  }
  if (
    config.nodeEnv === 'production' &&
    config.mediaAuthSharedSecret === config.playbackSigningSecret
  ) {
    throw new Error('MEDIA_AUTH_SHARED_SECRET must differ from PLAYBACK_SIGNING_SECRET in production');
  }
  if (config.nodeEnv === 'production') {
    const publicOrigin = new URL(config.publicOrigin).origin;
    if (
      new URL(config.webOrigin).origin !== publicOrigin ||
      mediaBase.origin !== publicOrigin
    ) {
      throw new Error(
        'WEB_ORIGIN, PUBLIC_ORIGIN, and MEDIA_PUBLIC_BASE_URL must use one origin in production',
      );
    }
  }
  return config;
}
