CREATE TYPE "title_kind" AS ENUM ('MOVIE', 'SERIES');
CREATE TYPE "media_kind" AS ENUM ('MOVIE', 'EPISODE');
CREATE TYPE "stream_kind" AS ENUM ('VIDEO', 'AUDIO');
CREATE TYPE "compatibility_class" AS ENUM ('COPY', 'AUDIO_TRANSCODE', 'VIDEO_TRANSCODE', 'HOLD_HDR', 'INVALID');
CREATE TYPE "package_state" AS ENUM ('QUEUED', 'BUILDING', 'READY', 'FAILED', 'EVICTED');
CREATE TYPE "job_state" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "playback_state" AS ENUM ('PREPARING', 'READY', 'UNSUPPORTED_CLIENT', 'FAILED');
--> statement-breakpoint
CREATE TABLE "titles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" varchar(240) NOT NULL,
  "kind" "title_kind" NOT NULL,
  "name_fa" text,
  "name_en" text,
  "synopsis_fa" text,
  "synopsis_en" text,
  "poster_url" text,
  "backdrop_url" text,
  "release_year" integer,
  "tmdb_id" integer,
  "published" boolean DEFAULT false NOT NULL,
  "published_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title_id" uuid NOT NULL,
  "kind" "media_kind" NOT NULL,
  "season_number" integer,
  "episode_number" integer,
  "name_fa" text,
  "name_en" text,
  "duration_seconds" double precision,
  "compatibility" "compatibility_class" DEFAULT 'INVALID' NOT NULL,
  "compatibility_reason" text,
  "published" boolean DEFAULT false NOT NULL,
  "published_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_files" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "media_item_id" uuid NOT NULL,
  "relative_path" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "modified_at_ns" bigint NOT NULL,
  "matroska_uid" varchar(128),
  "head_hash" varchar(128) NOT NULL,
  "tail_hash" varchar(128) NOT NULL,
  "fingerprint" varchar(128) NOT NULL,
  "probe_json" jsonb,
  "present" boolean DEFAULT true NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_streams" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_file_id" uuid NOT NULL,
  "stream_index" integer NOT NULL,
  "kind" "stream_kind" NOT NULL,
  "codec" varchar(64) NOT NULL,
  "codec_string" varchar(128),
  "language" varchar(35),
  "label" varchar(200),
  "is_default" boolean DEFAULT false NOT NULL,
  "channels" integer,
  "sample_rate" integer,
  "width" integer,
  "height" integer,
  "frame_rate" varchar(32),
  "bit_depth" integer,
  "pixel_format" varchar(64),
  "color_transfer" varchar(64),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subtitle_tracks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_file_id" uuid NOT NULL,
  "stream_index" integer NOT NULL,
  "codec" varchar(64) NOT NULL,
  "source_language" varchar(35),
  "normalized_language" varchar(35) NOT NULL,
  "label" varchar(200) NOT NULL,
  "source_default" boolean DEFAULT false NOT NULL,
  "source_forced" boolean DEFAULT false NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "is_forced" boolean DEFAULT false NOT NULL,
  "ass_path" text,
  "webvtt_path" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "font_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_file_id" uuid NOT NULL,
  "stream_index" integer NOT NULL,
  "sha256" varchar(64) NOT NULL,
  "mime_type" varchar(100) NOT NULL,
  "original_name" text NOT NULL,
  "storage_path" text,
  "approved" boolean DEFAULT false NOT NULL,
  "size_bytes" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_packages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "media_item_id" uuid NOT NULL,
  "source_fingerprint" varchar(128) NOT NULL,
  "profile_version" varchar(64) NOT NULL,
  "state" "package_state" DEFAULT 'QUEUED' NOT NULL,
  "manifest_path" text,
  "size_bytes" bigint DEFAULT 0 NOT NULL,
  "cache_resident" boolean DEFAULT false NOT NULL,
  "pinned" boolean DEFAULT false NOT NULL,
  "last_accessed_at" timestamp with time zone,
  "error_code" varchar(100),
  "error_detail" text,
  "ready_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type" varchar(100) NOT NULL,
  "state" "job_state" DEFAULT 'QUEUED' NOT NULL,
  "progress" real DEFAULT 0 NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "result" jsonb,
  "error" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" varchar(320) NOT NULL,
  "password_hash" text NOT NULL,
  "totp_secret_encrypted" text,
  "disabled" boolean DEFAULT false NOT NULL,
  "last_login_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "admin_id" uuid NOT NULL,
  "token_hash" varchar(64) NOT NULL,
  "csrf_token_hash" varchar(64) NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playback_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "media_item_id" uuid NOT NULL,
  "generation_id" uuid,
  "state" "playback_state" DEFAULT 'PREPARING' NOT NULL,
  "capabilities" jsonb NOT NULL,
  "reason_code" varchar(100),
  "poll_after_ms" integer,
  "response_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "titles"("id") ON DELETE cascade;
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE cascade;
ALTER TABLE "media_streams" ADD CONSTRAINT "media_streams_source_file_id_source_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "source_files"("id") ON DELETE cascade;
ALTER TABLE "subtitle_tracks" ADD CONSTRAINT "subtitle_tracks_source_file_id_source_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "source_files"("id") ON DELETE cascade;
ALTER TABLE "font_attachments" ADD CONSTRAINT "font_attachments_source_file_id_source_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "source_files"("id") ON DELETE cascade;
ALTER TABLE "media_packages" ADD CONSTRAINT "media_packages_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE cascade;
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "admins"("id") ON DELETE cascade;
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "titles_slug_uidx" ON "titles" ("slug");
CREATE INDEX "titles_published_idx" ON "titles" ("published", "published_at");
CREATE INDEX "titles_tmdb_idx" ON "titles" ("tmdb_id");
CREATE INDEX "media_items_title_idx" ON "media_items" ("title_id");
CREATE UNIQUE INDEX "media_items_episode_uidx" ON "media_items" ("title_id", "season_number", "episode_number");
CREATE INDEX "media_items_published_idx" ON "media_items" ("published");
CREATE UNIQUE INDEX "source_files_path_uidx" ON "source_files" ("relative_path");
CREATE UNIQUE INDEX "source_files_fingerprint_uidx" ON "source_files" ("fingerprint");
CREATE INDEX "source_files_media_item_idx" ON "source_files" ("media_item_id");
CREATE UNIQUE INDEX "media_streams_source_index_uidx" ON "media_streams" ("source_file_id", "stream_index");
CREATE INDEX "media_streams_source_idx" ON "media_streams" ("source_file_id");
CREATE UNIQUE INDEX "subtitle_tracks_source_index_uidx" ON "subtitle_tracks" ("source_file_id", "stream_index");
CREATE INDEX "subtitle_tracks_source_idx" ON "subtitle_tracks" ("source_file_id");
CREATE UNIQUE INDEX "font_attachments_source_index_uidx" ON "font_attachments" ("source_file_id", "stream_index");
CREATE INDEX "font_attachments_hash_idx" ON "font_attachments" ("sha256");
CREATE UNIQUE INDEX "media_packages_generation_uidx" ON "media_packages" ("media_item_id", "source_fingerprint", "profile_version");
CREATE INDEX "media_packages_lru_idx" ON "media_packages" ("cache_resident", "pinned", "last_accessed_at");
CREATE INDEX "jobs_state_created_idx" ON "jobs" ("state", "created_at");
CREATE UNIQUE INDEX "admins_email_uidx" ON "admins" ("email");
CREATE UNIQUE INDEX "admin_sessions_token_uidx" ON "admin_sessions" ("token_hash");
CREATE INDEX "admin_sessions_admin_idx" ON "admin_sessions" ("admin_id");
CREATE INDEX "playback_sessions_media_idx" ON "playback_sessions" ("media_item_id");
CREATE INDEX "playback_sessions_generation_idx" ON "playback_sessions" ("generation_id");
CREATE INDEX "playback_sessions_expires_idx" ON "playback_sessions" ("expires_at");
