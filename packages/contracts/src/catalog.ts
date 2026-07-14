import { Type, type Static } from '@sinclair/typebox';
import { DateTimeSchema, UuidSchema } from './common.js';

export const TitleKindSchema = Type.Union([Type.Literal('MOVIE'), Type.Literal('SERIES')]);
export const MediaKindSchema = Type.Union([Type.Literal('MOVIE'), Type.Literal('EPISODE')]);

export const LocalizedTextSchema = Type.Object(
  {
    fa: Type.String(),
    en: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const OptionalLocalizedTextSchema = Type.Object(
  {
    fa: Type.Optional(Type.String()),
    en: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const CatalogCardSchema = Type.Object(
  {
    id: UuidSchema,
    slug: Type.String(),
    kind: TitleKindSchema,
    name: LocalizedTextSchema,
    posterUrl: Type.Optional(Type.String()),
    backdropUrl: Type.Optional(Type.String()),
    year: Type.Optional(Type.Integer()),
    playable: Type.Boolean(),
    resumeMediaItemId: Type.Optional(UuidSchema),
  },
  { additionalProperties: false },
);

export const MediaItemSummarySchema = Type.Object(
  {
    id: UuidSchema,
    kind: MediaKindSchema,
    seasonNumber: Type.Optional(Type.Integer({ minimum: 0 })),
    episodeNumber: Type.Optional(Type.Integer({ minimum: 0 })),
    name: Type.Optional(OptionalLocalizedTextSchema),
    durationSeconds: Type.Number({ minimum: 0 }),
    compatibility: Type.Union([
      Type.Literal('COPY'),
      Type.Literal('AUDIO_TRANSCODE'),
      Type.Literal('VIDEO_TRANSCODE'),
      Type.Literal('HOLD_HDR'),
      Type.Literal('INVALID'),
    ]),
    published: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const SeasonSummarySchema = Type.Object(
  {
    number: Type.Integer({ minimum: 0 }),
    episodeCount: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const TitleDetailSchema = Type.Object(
  {
    id: UuidSchema,
    slug: Type.String(),
    kind: TitleKindSchema,
    name: LocalizedTextSchema,
    posterUrl: Type.Optional(Type.String()),
    backdropUrl: Type.Optional(Type.String()),
    year: Type.Optional(Type.Integer()),
    playable: Type.Boolean(),
    resumeMediaItemId: Type.Optional(UuidSchema),
    synopsis: OptionalLocalizedTextSchema,
    seasons: Type.Optional(Type.Array(SeasonSummarySchema)),
    mediaItems: Type.Array(MediaItemSummarySchema),
    updatedAt: DateTimeSchema,
  },
  { additionalProperties: false },
);

export const CatalogQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 24 })),
    kind: Type.Optional(TitleKindSchema),
  },
  { additionalProperties: false },
);

export const SearchQuerySchema = Type.Object(
  {
    q: Type.String({ minLength: 1, maxLength: 200 }),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 20 })),
  },
  { additionalProperties: false },
);

export const CatalogResponseSchema = Type.Object(
  {
    items: Type.Array(CatalogCardSchema),
    nextCursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const SearchResponseSchema = Type.Object(
  { items: Type.Array(CatalogCardSchema) },
  { additionalProperties: false },
);

export const CatalogSnapshotSchema = Type.Object(
  {
    version: Type.Literal(1),
    generatedAt: DateTimeSchema,
    titles: Type.Array(TitleDetailSchema),
  },
  { additionalProperties: false },
);

export type TitleKind = Static<typeof TitleKindSchema>;
export type MediaKind = Static<typeof MediaKindSchema>;
export type LocalizedText = Static<typeof LocalizedTextSchema>;
export type OptionalLocalizedText = Static<typeof OptionalLocalizedTextSchema>;
export type CatalogCard = Static<typeof CatalogCardSchema>;
export type MediaItemSummary = Static<typeof MediaItemSummarySchema>;
export type TitleDetail = Static<typeof TitleDetailSchema>;
export type CatalogQuery = Static<typeof CatalogQuerySchema>;
export type SearchQuery = Static<typeof SearchQuerySchema>;
export type CatalogResponse = Static<typeof CatalogResponseSchema>;
export type CatalogSnapshot = Static<typeof CatalogSnapshotSchema>;
