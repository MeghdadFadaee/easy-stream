import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

export const titleKind = pgEnum('title_kind', ['MOVIE', 'SERIES']);
export const releaseWindow = pgEnum('release_window', ['SPRING', 'SUMMER', 'FALL', 'WINTER', 'MOVIE']);
export const mediaKind = pgEnum('media_kind', ['MOVIE', 'EPISODE']);
export const streamKind = pgEnum('stream_kind', ['VIDEO', 'AUDIO']);
export const compatibilityClass = pgEnum('compatibility_class', [
  'COPY',
  'AUDIO_TRANSCODE',
  'VIDEO_TRANSCODE',
  'HOLD_HDR',
  'INVALID',
]);
export const packageState = pgEnum('package_state', [
  'QUEUED',
  'BUILDING',
  'READY',
  'FAILED',
  'EVICTED',
]);
export const jobState = pgEnum('job_state', [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
]);
export const playbackState = pgEnum('playback_state', [
  'PREPARING',
  'READY',
  'UNSUPPORTED_CLIENT',
  'FAILED',
]);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const titles = pgTable(
  'titles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: varchar('slug', { length: 240 }).notNull(),
    kind: titleKind('kind').notNull(),
    nameFa: text('name_fa'),
    nameEn: text('name_en'),
    synopsisFa: text('synopsis_fa'),
    synopsisEn: text('synopsis_en'),
    posterUrl: text('poster_url'),
    backdropUrl: text('backdrop_url'),
    releaseYear: integer('release_year'),
    category: varchar('category', { length: 100 }),
    categorySlug: varchar('category_slug', { length: 100 }),
    releaseWindow: releaseWindow('release_window'),
    tmdbId: integer('tmdb_id'),
    published: boolean('published').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('titles_slug_uidx').on(table.slug),
    index('titles_published_idx').on(table.published, table.publishedAt),
    index('titles_tmdb_idx').on(table.tmdbId),
  ],
);

export const mediaItems = pgTable(
  'media_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    titleId: uuid('title_id')
      .notNull()
      .references(() => titles.id, { onDelete: 'cascade' }),
    kind: mediaKind('kind').notNull(),
    logicalKey: varchar('logical_key', { length: 80 }),
    seasonNumber: integer('season_number'),
    episodeNumber: integer('episode_number'),
    nameFa: text('name_fa'),
    nameEn: text('name_en'),
    durationSeconds: doublePrecision('duration_seconds'),
    compatibility: compatibilityClass('compatibility').notNull().default('INVALID'),
    compatibilityReason: text('compatibility_reason'),
    variants: jsonb('variants').$type<Array<{
      id: string;
      label: string;
      width?: number;
      height?: number;
      videoCodec?: string;
      compatibility: string;
      available: boolean;
      isDefault: boolean;
    }>>().notNull().default([]),
    published: boolean('published').notNull().default(false),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index('media_items_title_idx').on(table.titleId),
    uniqueIndex('media_items_logical_uidx').on(table.titleId, table.logicalKey),
    uniqueIndex('media_items_episode_uidx').on(
      table.titleId,
      table.seasonNumber,
      table.episodeNumber,
    ),
    index('media_items_published_idx').on(table.published),
  ],
);

export const sourceFiles = pgTable(
  'source_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mediaItemId: uuid('media_item_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    relativePath: text('relative_path').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    modifiedAtNs: bigint('modified_at_ns', { mode: 'bigint' }).notNull(),
    matroskaUid: varchar('matroska_uid', { length: 128 }),
    headHash: varchar('head_hash', { length: 128 }).notNull(),
    tailHash: varchar('tail_hash', { length: 128 }).notNull(),
    fingerprint: varchar('fingerprint', { length: 128 }).notNull(),
    qualityLabel: varchar('quality_label', { length: 64 }),
    width: integer('width'),
    height: integer('height'),
    videoCodec: varchar('video_codec', { length: 64 }),
    durationSeconds: doublePrecision('duration_seconds'),
    compatibility: compatibilityClass('compatibility').notNull().default('INVALID'),
    compatibilityReason: text('compatibility_reason'),
    probeJson: jsonb('probe_json').$type<Record<string, unknown>>(),
    present: boolean('present').notNull().default(true),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('source_files_path_uidx').on(table.relativePath),
    uniqueIndex('source_files_fingerprint_uidx').on(table.fingerprint),
    index('source_files_media_item_idx').on(table.mediaItemId),
  ],
);

export const mediaStreams = pgTable(
  'media_streams',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceFileId: uuid('source_file_id')
      .notNull()
      .references(() => sourceFiles.id, { onDelete: 'cascade' }),
    streamIndex: integer('stream_index').notNull(),
    kind: streamKind('kind').notNull(),
    codec: varchar('codec', { length: 64 }).notNull(),
    codecString: varchar('codec_string', { length: 128 }),
    language: varchar('language', { length: 35 }),
    label: varchar('label', { length: 200 }),
    isDefault: boolean('is_default').notNull().default(false),
    channels: integer('channels'),
    sampleRate: integer('sample_rate'),
    width: integer('width'),
    height: integer('height'),
    frameRate: varchar('frame_rate', { length: 32 }),
    bitDepth: integer('bit_depth'),
    pixelFormat: varchar('pixel_format', { length: 64 }),
    colorTransfer: varchar('color_transfer', { length: 64 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('media_streams_source_index_uidx').on(table.sourceFileId, table.streamIndex),
    index('media_streams_source_idx').on(table.sourceFileId),
  ],
);

export const subtitleTracks = pgTable(
  'subtitle_tracks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceFileId: uuid('source_file_id')
      .notNull()
      .references(() => sourceFiles.id, { onDelete: 'cascade' }),
    streamIndex: integer('stream_index').notNull(),
    codec: varchar('codec', { length: 64 }).notNull(),
    sourceLanguage: varchar('source_language', { length: 35 }),
    normalizedLanguage: varchar('normalized_language', { length: 35 }).notNull(),
    label: varchar('label', { length: 200 }).notNull(),
    sourceDefault: boolean('source_default').notNull().default(false),
    sourceForced: boolean('source_forced').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    isForced: boolean('is_forced').notNull().default(false),
    assPath: text('ass_path'),
    webvttPath: text('webvtt_path'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('subtitle_tracks_source_index_uidx').on(table.sourceFileId, table.streamIndex),
    index('subtitle_tracks_source_idx').on(table.sourceFileId),
  ],
);

export const fontAttachments = pgTable(
  'font_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceFileId: uuid('source_file_id')
      .notNull()
      .references(() => sourceFiles.id, { onDelete: 'cascade' }),
    streamIndex: integer('stream_index').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    originalName: text('original_name').notNull(),
    storagePath: text('storage_path'),
    approved: boolean('approved').notNull().default(false),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('font_attachments_source_index_uidx').on(table.sourceFileId, table.streamIndex),
    index('font_attachments_hash_idx').on(table.sha256),
  ],
);

export const mediaPackages = pgTable(
  'media_packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mediaItemId: uuid('media_item_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    // Scanner variant IDs are deterministic external identifiers, like generation IDs.
    variantId: uuid('variant_id'),
    sourceFingerprint: varchar('source_fingerprint', { length: 128 }).notNull(),
    profileVersion: varchar('profile_version', { length: 64 }).notNull(),
    state: packageState('state').notNull().default('QUEUED'),
    manifestPath: text('manifest_path'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    cacheResident: boolean('cache_resident').notNull().default(false),
    pinned: boolean('pinned').notNull().default(false),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    errorCode: varchar('error_code', { length: 100 }),
    errorDetail: text('error_detail'),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('media_packages_generation_uidx').on(
      table.mediaItemId,
      table.sourceFingerprint,
      table.profileVersion,
    ),
    index('media_packages_lru_idx').on(table.cacheResident, table.pinned, table.lastAccessedAt),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: varchar('type', { length: 100 }).notNull(),
    state: jobState('state').notNull().default('QUEUED'),
    progress: real('progress').notNull().default(0),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb('result').$type<Record<string, unknown>>(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
    ...timestamps,
  },
  (table) => [index('jobs_state_created_idx').on(table.state, table.createdAt)],
);

export const admins = pgTable(
  'admins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull(),
    passwordHash: text('password_hash').notNull(),
    totpSecretEncrypted: text('totp_secret_encrypted'),
    disabled: boolean('disabled').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...timestamps,
  },
  (table) => [uniqueIndex('admins_email_uidx').on(table.email)],
);

export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminId: uuid('admin_id')
      .notNull()
      .references(() => admins.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    csrfTokenHash: varchar('csrf_token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('admin_sessions_token_uidx').on(table.tokenHash),
    index('admin_sessions_admin_idx').on(table.adminId),
  ],
);

export const playbackSessions = pgTable(
  'playback_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mediaItemId: uuid('media_item_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id'),
    // Packaging generation IDs are deterministic UUIDs owned by the media worker. They are
    // deliberately not media_packages.id, so this column must not reference that primary key.
    generationId: uuid('generation_id'),
    state: playbackState('state').notNull().default('PREPARING'),
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>().notNull(),
    reasonCode: varchar('reason_code', { length: 100 }),
    pollAfterMs: integer('poll_after_ms'),
    responseJson: jsonb('response_json').$type<Record<string, unknown>>().notNull().default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('playback_sessions_media_idx').on(table.mediaItemId),
    index('playback_sessions_generation_idx').on(table.generationId),
    index('playback_sessions_expires_idx').on(table.expiresAt),
  ],
);

export type TitleRow = typeof titles.$inferSelect;
export type MediaItemRow = typeof mediaItems.$inferSelect;
export type SourceFileRow = typeof sourceFiles.$inferSelect;
export type MediaPackageRow = typeof mediaPackages.$inferSelect;
export type AdminRow = typeof admins.$inferSelect;
export type AdminSessionRow = typeof adminSessions.$inferSelect;
export type PlaybackSessionRow = typeof playbackSessions.$inferSelect;
