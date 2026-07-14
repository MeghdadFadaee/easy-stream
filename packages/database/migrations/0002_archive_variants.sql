CREATE TYPE "release_window" AS ENUM ('SPRING', 'SUMMER', 'FALL', 'WINTER', 'MOVIE');
--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "category" varchar(100);
ALTER TABLE "titles" ADD COLUMN "category_slug" varchar(100);
ALTER TABLE "titles" ADD COLUMN "release_window" "release_window";
ALTER TABLE "media_items" ADD COLUMN "logical_key" varchar(80);
ALTER TABLE "media_items" ADD COLUMN "variants" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "source_files" ADD COLUMN "quality_label" varchar(64);
ALTER TABLE "source_files" ADD COLUMN "width" integer;
ALTER TABLE "source_files" ADD COLUMN "height" integer;
ALTER TABLE "source_files" ADD COLUMN "video_codec" varchar(64);
ALTER TABLE "source_files" ADD COLUMN "duration_seconds" double precision;
ALTER TABLE "source_files" ADD COLUMN "compatibility" "compatibility_class" DEFAULT 'INVALID' NOT NULL;
ALTER TABLE "source_files" ADD COLUMN "compatibility_reason" text;
ALTER TABLE "media_packages" ADD COLUMN "variant_id" uuid;
ALTER TABLE "playback_sessions" ADD COLUMN "variant_id" uuid;
--> statement-breakpoint
UPDATE "media_items"
SET "logical_key" = CASE
  WHEN "kind" = 'MOVIE' THEN 'movie'
  ELSE 's' || COALESCE("season_number", 1)::text || 'e' || COALESCE("episode_number", 0)::text
END;
--> statement-breakpoint
CREATE UNIQUE INDEX "media_items_logical_uidx" ON "media_items" ("title_id", "logical_key");
CREATE INDEX "titles_category_idx" ON "titles" ("category_slug", "release_year", "release_window");
