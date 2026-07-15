import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShowcaseConfig } from './config.js';
import { openDatabase } from './database.js';
import { createServer } from './server.js';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

describe('showcase server', () => {
  it('only exposes prepared media and creates immediate guest playback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-showcase-'));
    const webRoot = path.join(root, 'web');
    await mkdir(webRoot);
    await writeFile(path.join(webRoot, 'index.html'), '<h1>showcase</h1>');
    const config: ShowcaseConfig = {
      archiveRoot: path.join(root, 'archive'), dataRoot: root, databasePath: path.join(root, 'db.sqlite'),
      mediaRoot: path.join(root, 'media'), artworkRoot: path.join(root, 'artwork'), webRoot,
      host: '127.0.0.1', port: 8080, ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe',
    };
    const db = openDatabase(config.databasePath);
    databases.push(db);
    db.prepare('INSERT INTO titles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('title-1', 'demo', 'MOVIE', 'Demo', 'Demo', null, null, null, 'Anime', 'anime', 2026, 'SUMMER', new Date().toISOString());
    db.prepare('INSERT INTO media_items VALUES (?,?,?,?,?,?,?,?)').run('media-1', 'title-1', 'MOVIE', null, null, 'Demo', 'Demo', 60);
    db.prepare('INSERT INTO variants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('variant-1', 'media-1', 'demo.mkv', '{}', '720p', 1280, 720, 'h264', 'COPY', 'READY', 'generation-1', '/media/generations/generation-1/master.m3u8', '[]', '[]', null, new Date().toISOString());
    const app = await createServer(db, config);
    const catalog = await app.inject({ method: 'GET', url: '/api/v1/catalog/sections' });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().sections[0].items[0].slug).toBe('demo');
    const playback = await app.inject({ method: 'POST', url: '/api/v1/playback-sessions', payload: { mediaItemId: 'media-1' } });
    expect(playback.statusCode).toBe(200);
    expect(playback.json()).toMatchObject({ state: 'READY', manifestUrl: '/media/generations/generation-1/master.m3u8' });
    await app.close();
  });
});
