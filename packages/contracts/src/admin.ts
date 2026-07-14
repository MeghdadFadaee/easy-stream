import { Type, type Static } from '@sinclair/typebox';
import { DateTimeSchema, EmailSchema, UuidSchema } from './common.js';

export const AdminLoginSchema = Type.Object(
  {
    email: EmailSchema,
    password: Type.String({ minLength: 12, maxLength: 1024 }),
    totp: Type.Optional(Type.String({ pattern: '^[0-9]{6}$' })),
  },
  { additionalProperties: false },
);

export const AdminSessionResponseSchema = Type.Object(
  {
    admin: Type.Object(
      { id: UuidSchema, email: EmailSchema },
      { additionalProperties: false },
    ),
    csrfToken: Type.String(),
    expiresAt: DateTimeSchema,
  },
  { additionalProperties: false },
);

export const StartScanSchema = Type.Object(
  { full: Type.Optional(Type.Boolean({ default: false })) },
  { additionalProperties: false },
);

export const PublicationParamsSchema = Type.Object(
  { mediaItemId: UuidSchema },
  { additionalProperties: false },
);

export const PublicationBodySchema = Type.Object(
  { published: Type.Boolean() },
  { additionalProperties: false },
);

export const JobStateSchema = Type.Union([
  Type.Literal('QUEUED'),
  Type.Literal('RUNNING'),
  Type.Literal('SUCCEEDED'),
  Type.Literal('FAILED'),
  Type.Literal('CANCELLED'),
]);

export const JobSchema = Type.Object(
  {
    id: UuidSchema,
    type: Type.String(),
    state: JobStateSchema,
    progress: Type.Number({ minimum: 0, maximum: 1 }),
    error: Type.Union([Type.String(), Type.Null()]),
    createdAt: DateTimeSchema,
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);

export const JobParamsSchema = Type.Object({ jobId: UuidSchema }, { additionalProperties: false });
export const CacheParamsSchema = Type.Object(
  { generationId: UuidSchema },
  { additionalProperties: false },
);

export const CacheStatusSchema = Type.Object(
  {
    usedBytes: Type.Integer({ minimum: 0 }),
    maxBytes: Type.Integer({ minimum: 1 }),
    highWatermark: Type.Number({ minimum: 0, maximum: 1 }),
    lowWatermark: Type.Number({ minimum: 0, maximum: 1 }),
    activePackages: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const MetadataSearchQuerySchema = Type.Object(
  {
    q: Type.String({ minLength: 1, maxLength: 200 }),
    kind: Type.Union([Type.Literal('MOVIE'), Type.Literal('SERIES')]),
    year: Type.Optional(Type.Integer({ minimum: 1888, maximum: 2200 })),
  },
  { additionalProperties: false },
);

export const MetadataCandidateSchema = Type.Object(
  {
    provider: Type.Literal('TMDB'),
    externalId: Type.Integer({ minimum: 1 }),
    kind: Type.Union([Type.Literal('MOVIE'), Type.Literal('SERIES')]),
    name: Type.Object(
      { fa: Type.String(), en: Type.Optional(Type.String()) },
      { additionalProperties: false },
    ),
    synopsis: Type.Object(
      { fa: Type.Optional(Type.String()), en: Type.Optional(Type.String()) },
      { additionalProperties: false },
    ),
    posterUrl: Type.Optional(Type.String()),
    backdropUrl: Type.Optional(Type.String()),
    year: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

export const MetadataSearchResponseSchema = Type.Object(
  { items: Type.Array(MetadataCandidateSchema) },
  { additionalProperties: false },
);

export const MetadataMatchParamsSchema = Type.Object(
  { titleId: UuidSchema },
  { additionalProperties: false },
);

export const MetadataMatchBodySchema = Type.Object(
  {
    provider: Type.Literal('TMDB'),
    externalId: Type.Integer({ minimum: 1 }),
    kind: Type.Union([Type.Literal('MOVIE'), Type.Literal('SERIES')]),
  },
  { additionalProperties: false },
);

export type AdminLogin = Static<typeof AdminLoginSchema>;
export type AdminSessionResponse = Static<typeof AdminSessionResponseSchema>;
export type StartScan = Static<typeof StartScanSchema>;
export type Job = Static<typeof JobSchema>;
export type JobState = Static<typeof JobStateSchema>;
export type CacheStatus = Static<typeof CacheStatusSchema>;
export type MetadataSearchQuery = Static<typeof MetadataSearchQuerySchema>;
export type MetadataCandidate = Static<typeof MetadataCandidateSchema>;
export type MetadataMatchBody = Static<typeof MetadataMatchBodySchema>;
