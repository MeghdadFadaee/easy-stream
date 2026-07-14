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

export const ReleaseWindowSchema = Type.Union([
  Type.Literal('SPRING'),
  Type.Literal('SUMMER'),
  Type.Literal('FALL'),
  Type.Literal('WINTER'),
  Type.Literal('MOVIE'),
]);

const CatalogCompatibilityClassSchema = Type.Union([
  Type.Literal('COPY'),
  Type.Literal('AUDIO_TRANSCODE'),
  Type.Literal('VIDEO_TRANSCODE'),
  Type.Literal('HOLD_HDR'),
  Type.Literal('INVALID'),
]);

export const MediaVariantSchema = Type.Object(
  {
    id: UuidSchema,
    label: Type.String({ minLength: 1, maxLength: 64 }),
    width: Type.Optional(Type.Integer({ minimum: 1 })),
    height: Type.Optional(Type.Integer({ minimum: 1 })),
    videoCodec: Type.Optional(Type.String({ maxLength: 64 })),
    compatibility: CatalogCompatibilityClassSchema,
    available: Type.Boolean(),
    isDefault: Type.Boolean(),
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
    category: Type.Optional(Type.String({ maxLength: 100 })),
    categorySlug: Type.Optional(Type.String({ maxLength: 100 })),
    releaseWindow: Type.Optional(ReleaseWindowSchema),
    playable: Type.Boolean(),
    resumeMediaItemId: Type.Optional(UuidSchema),
    variants: Type.Optional(Type.Array(MediaVariantSchema)),
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
    compatibility: CatalogCompatibilityClassSchema,
    published: Type.Boolean(),
    variants: Type.Optional(Type.Array(MediaVariantSchema)),
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
    category: Type.Optional(Type.String({ maxLength: 100 })),
    categorySlug: Type.Optional(Type.String({ maxLength: 100 })),
    releaseWindow: Type.Optional(ReleaseWindowSchema),
    playable: Type.Boolean(),
    resumeMediaItemId: Type.Optional(UuidSchema),
    variants: Type.Optional(Type.Array(MediaVariantSchema)),
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
    category: Type.Optional(Type.String({ maxLength: 100 })),
    year: Type.Optional(Type.Integer({ minimum: 1888, maximum: 2200 })),
    releaseWindow: Type.Optional(ReleaseWindowSchema),
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

export const CatalogSectionsQuerySchema = Type.Object(
  { limitPerSection: Type.Optional(Type.Integer({ minimum: 1, maximum: 40, default: 12 })) },
  { additionalProperties: false },
);

export const CatalogSectionSchema = Type.Object(
  {
    slug: Type.String(),
    name: Type.String(),
    items: Type.Array(CatalogCardSchema),
    hasMore: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const CatalogSectionsResponseSchema = Type.Object(
  { sections: Type.Array(CatalogSectionSchema) },
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
export type ReleaseWindow = Static<typeof ReleaseWindowSchema>;
export type MediaVariant = Static<typeof MediaVariantSchema>;
export type CatalogCard = Static<typeof CatalogCardSchema>;
export type MediaItemSummary = Static<typeof MediaItemSummarySchema>;
export type TitleDetail = Static<typeof TitleDetailSchema>;
export type CatalogQuery = Static<typeof CatalogQuerySchema>;
export type SearchQuery = Static<typeof SearchQuerySchema>;
export type CatalogResponse = Static<typeof CatalogResponseSchema>;
export type CatalogSectionsQuery = Static<typeof CatalogSectionsQuerySchema>;
export type CatalogSection = Static<typeof CatalogSectionSchema>;
export type CatalogSectionsResponse = Static<typeof CatalogSectionsResponseSchema>;
export type CatalogSnapshot = Static<typeof CatalogSnapshotSchema>;
