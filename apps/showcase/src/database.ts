import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type PackageStatus = 'UNPREPARED' | 'PREPARING' | 'READY' | 'FAILED' | 'UNSUPPORTED';

export interface VariantRow {
  id: string;
  media_item_id: string;
  source_path: string;
  fingerprint: string;
  label: string;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  compatibility: string;
  status: PackageStatus;
  generation_id: string | null;
  manifest_path: string | null;
  audio_tracks: string;
  subtitle_tracks: string;
  error: string | null;
}

export function openDatabase(filename: string): DatabaseSync {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o750 });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS titles (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      name_fa TEXT NOT NULL, name_en TEXT, synopsis_fa TEXT, synopsis_en TEXT,
      poster_url TEXT, category TEXT, category_slug TEXT, release_year INTEGER,
      release_window TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY, title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, season_number INTEGER, episode_number INTEGER,
      name_fa TEXT, name_en TEXT, duration_seconds REAL NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS variants (
      id TEXT PRIMARY KEY, media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      source_path TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, label TEXT NOT NULL,
      width INTEGER, height INTEGER, video_codec TEXT, compatibility TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'UNPREPARED', generation_id TEXT, manifest_path TEXT,
      audio_tracks TEXT NOT NULL DEFAULT '[]', subtitle_tracks TEXT NOT NULL DEFAULT '[]',
      error TEXT, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS variants_media_status ON variants(media_item_id, status);
  `);
  return db;
}

export function variantRows(db: DatabaseSync, where = '', values: Array<string | number | null> = []): VariantRow[] {
  return db.prepare(`SELECT * FROM variants ${where}`).all(...values) as unknown as VariantRow[];
}
