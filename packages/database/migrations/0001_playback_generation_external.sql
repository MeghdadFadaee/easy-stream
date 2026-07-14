ALTER TABLE "playback_sessions" DROP CONSTRAINT IF EXISTS "playback_sessions_generation_id_media_packages_id_fk";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "playback_sessions_generation_idx" ON "playback_sessions" ("generation_id");
