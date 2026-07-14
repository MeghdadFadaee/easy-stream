import { Type, type Static } from '@sinclair/typebox';
import { DateTimeSchema, UuidSchema } from './common.js';

export const CompatibilityClassSchema = Type.Union([
  Type.Literal('COPY'),
  Type.Literal('AUDIO_TRANSCODE'),
  Type.Literal('VIDEO_TRANSCODE'),
  Type.Literal('HOLD_HDR'),
  Type.Literal('INVALID'),
]);

export const PlaybackStateSchema = Type.Union([
  Type.Literal('PREPARING'),
  Type.Literal('READY'),
  Type.Literal('UNSUPPORTED_CLIENT'),
  Type.Literal('FAILED'),
]);

export const SubtitleDeliverySchema = Type.Union([
  Type.Literal('ASS_JASSUB'),
  Type.Literal('WEBVTT'),
  Type.Literal('OFF'),
]);

export const ClientCapabilitiesSchema = Type.Object(
  {
    mse: Type.Boolean(),
    nativeHls: Type.Boolean(),
    hlsJs: Type.Boolean(),
    assRenderer: Type.Boolean(),
    supportedCodecs: Type.Array(Type.String({ maxLength: 128 }), { maxItems: 32 }),
    userAgent: Type.Optional(Type.String({ maxLength: 512 })),
  },
  { additionalProperties: false },
);

export const AudioTrackSchema = Type.Object(
  {
    id: UuidSchema,
    language: Type.String({ minLength: 2, maxLength: 35 }),
    label: Type.String({ maxLength: 100 }),
    default: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const SubtitleTrackSchema = Type.Object(
  {
    id: UuidSchema,
    language: Type.String({ minLength: 2, maxLength: 35 }),
    label: Type.String({ maxLength: 100 }),
    default: Type.Boolean(),
    forced: Type.Boolean(),
    assUrl: Type.Optional(Type.String()),
    vttUrl: Type.Optional(Type.String()),
    fontUrls: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const CreatePlaybackSessionSchema = Type.Object(
  {
    mediaItemId: UuidSchema,
    clientCapabilities: ClientCapabilitiesSchema,
  },
  { additionalProperties: false },
);

export const PlaybackSessionSchema = Type.Object(
  {
    id: UuidSchema,
    mediaItemId: UuidSchema,
    state: PlaybackStateSchema,
    manifestUrl: Type.Optional(Type.String()),
    generationId: Type.Optional(UuidSchema),
    durationSeconds: Type.Optional(Type.Number({ minimum: 0 })),
    audioTracks: Type.Optional(Type.Array(AudioTrackSchema)),
    subtitleTracks: Type.Optional(Type.Array(SubtitleTrackSchema)),
    pollAfterMs: Type.Optional(Type.Integer({ minimum: 250, maximum: 30000 })),
    reasonCode: Type.Optional(Type.String()),
    expiresAt: DateTimeSchema,
  },
  { additionalProperties: false },
);

export const PlaybackSessionParamsSchema = Type.Object(
  { id: UuidSchema },
  { additionalProperties: false },
);

export type CompatibilityClass = Static<typeof CompatibilityClassSchema>;
export type PlaybackState = Static<typeof PlaybackStateSchema>;
export type SubtitleDelivery = Static<typeof SubtitleDeliverySchema>;
export type ClientCapabilities = Static<typeof ClientCapabilitiesSchema>;
export type AudioTrack = Static<typeof AudioTrackSchema>;
export type SubtitleTrack = Static<typeof SubtitleTrackSchema>;
export type CreatePlaybackSession = Static<typeof CreatePlaybackSessionSchema>;
export type PlaybackSession = Static<typeof PlaybackSessionSchema>;
