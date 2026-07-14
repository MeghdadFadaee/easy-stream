import { Type, type Static } from '@sinclair/typebox';
import { DateTimeSchema, UuidSchema } from './common.js';
import { AudioTrackSchema, SubtitleTrackSchema } from './playback.js';

export const MediaCommandSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('media.playback.requested'),
      sessionId: UuidSchema,
      mediaItemId: UuidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('archive.scan.requested'), jobId: UuidSchema, full: Type.Boolean() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('media.publication.changed'),
      mediaItemId: UuidSchema,
      published: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal('package.eviction.requested'), generationId: UuidSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal('cache.generation.accessed'),
      sessionId: UuidSchema,
      generationId: UuidSchema,
      accessedAt: DateTimeSchema,
      protectedUntil: DateTimeSchema,
    },
    { additionalProperties: false },
  ),
]);

/** Shared by the API lease writer and worker eviction reader. */
export const CACHE_GENERATION_LEASES_KEY = 'easy-stream:cache-generation-leases:v1';

export const MediaPreparationResultSchema = Type.Object(
  {
    sessionId: UuidSchema,
    state: Type.Union([
      Type.Literal('PREPARING'),
      Type.Literal('READY'),
      Type.Literal('UNSUPPORTED_CLIENT'),
      Type.Literal('FAILED'),
    ]),
    playable: Type.Boolean(),
    generationId: Type.Optional(UuidSchema),
    manifestPath: Type.Optional(Type.String({ pattern: '^/media/' })),
    reasonCode: Type.Optional(Type.String()),
    pollAfterMs: Type.Optional(Type.Integer({ minimum: 250, maximum: 30000 })),
  },
  { additionalProperties: false },
);

export const PackageRegistryEntrySchema = Type.Object(
  {
    mediaItemId: UuidSchema,
    state: Type.Union([
      Type.Literal('PREPARING'),
      Type.Literal('READY'),
      Type.Literal('UNSUPPORTED_CLIENT'),
      Type.Literal('FAILED'),
    ]),
    playable: Type.Boolean(),
    generationId: Type.Optional(UuidSchema),
    manifestPath: Type.Optional(Type.String({ pattern: '^/media/' })),
    reasonCode: Type.Optional(Type.String()),
    pollAfterMs: Type.Optional(Type.Integer({ minimum: 250, maximum: 30000 })),
    durationSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    audioTracks: Type.Optional(Type.Array(AudioTrackSchema)),
    subtitleTracks: Type.Optional(Type.Array(SubtitleTrackSchema)),
  },
  { additionalProperties: false },
);

export const PackageRegistrySchema = Type.Object(
  {
    version: Type.Literal(1),
    updatedAt: Type.String({
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$',
    }),
    packages: Type.Array(PackageRegistryEntrySchema),
  },
  { additionalProperties: false },
);

export type MediaCommand = Static<typeof MediaCommandSchema>;
export type MediaPreparationResult = Static<typeof MediaPreparationResultSchema>;
export type PackageRegistryEntry = Static<typeof PackageRegistryEntrySchema>;
export type PackageRegistry = Static<typeof PackageRegistrySchema>;
