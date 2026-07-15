import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShowcaseConfig } from './config.js';
import { openDatabase } from './database.js';
import { createStaticPreviewServer, exportStaticShowcase } from './static.js';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => databases.splice(0).forEach((database) => database.close()));

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-static-'));
  const config: ShowcaseConfig = {
    archiveRoot: path.join(root, 'archive'), dataRoot: root, databasePath: path.join(root, 'db.sqlite'),
    mediaRoot: path.join(root, 'media'), artworkRoot: path.join(root, 'artwork'), webRoot: path.join(root, 'web'),
    exportRoot: path.join(root, 'public'), host: '127.0.0.1', port: 8080,
    ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe',
  };
  const generationRoot = path.join(config.mediaRoot, 'generations', 'generation-1');
  await mkdir(path.join(generationRoot, 'video'), { recursive: true });
  await mkdir(path.join(generationRoot, 'subtitles'), { recursive: true });
  await mkdir(config.artworkRoot, { recursive: true });
  await writeFile(path.join(generationRoot, 'master.m3u8'), '#EXTM3U\nvideo/index.m3u8\n');
  await writeFile(path.join(generationRoot, 'video', 'index.m3u8'), '#EXTM3U\nsegment-000001.m4s\n');
  await writeFile(path.join(generationRoot, 'video', 'segment-000001.m4s'), 'segment');
  await writeFile(path.join(generationRoot, 'subtitles', 'fa.vtt'), 'WEBVTT');
  await writeFile(path.join(generationRoot, '.cache-entry.json'), '{"private":true}');
  await writeFile(path.join(config.artworkRoot, 'title.jpg'), 'poster');
  const db = openDatabase(config.databasePath);
  databases.push(db);
  db.prepare('INSERT INTO titles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'title-1', 'demo', 'MOVIE', 'دمو', 'Demo', null, null, '/images/archive/title.jpg',
    'Anime', 'anime', 2026, 'SUMMER', new Date().toISOString(),
  );
  db.prepare('INSERT INTO media_items VALUES (?,?,?,?,?,?,?,?)').run('media-1', 'title-1', 'MOVIE', null, null, 'دمو', 'Demo', 60);
  db.prepare('INSERT INTO variants VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'variant-1', 'media-1', 'demo.mkv', '{}', '720p', 1280, 720, 'h264', 'COPY', 'READY', 'generation-1',
    '/media/generations/generation-1/master.m3u8', '[]',
    JSON.stringify([{ id: 'fa', language: 'fa', label: 'فارسی', vttUrl: '/media/generations/generation-1/subtitles/fa.vtt', fontUrls: [] }]),
    null, new Date().toISOString(),
  );
  return { root, config, db, generationRoot };
}

describe('portable static showcase', () => {
  it('exports a self-contained relative catalog and only public media files', async () => {
    const { config, db, generationRoot } = await fixture();
    const result = await exportStaticShowcase(db, config, {
      buildViewer: async (outputRoot) => {
        await mkdir(path.join(outputRoot, 'assets'), { recursive: true });
        await writeFile(path.join(outputRoot, 'index.html'), '<h1>Easy Stream</h1>');
        await writeFile(path.join(outputRoot, 'assets', 'app.js'), 'console.log("showcase")');
      },
    });
    expect(result.outputRoot).toBe(config.exportRoot);
    const catalog = JSON.parse(await readFile(path.join(config.exportRoot, 'catalog.json'), 'utf8')) as {
      titles: Array<{ posterUrl: string }>;
      playbackByVariant: Record<string, { manifestUrl: string; subtitleTracks: Array<{ vttUrl: string }> }>;
    };
    expect(catalog.titles[0]?.posterUrl).toBe('./images/archive/title.jpg');
    expect(catalog.playbackByVariant['variant-1']).toMatchObject({
      manifestUrl: './media/generations/generation-1/master.m3u8',
      subtitleTracks: [{ vttUrl: './media/generations/generation-1/subtitles/fa.vtt' }],
    });
    await expect(readFile(path.join(config.exportRoot, 'media', 'generations', 'generation-1', '.cache-entry.json'))).rejects.toThrow();
    const source = await stat(path.join(generationRoot, 'master.m3u8'));
    const exported = await stat(path.join(config.exportRoot, 'media', 'generations', 'generation-1', 'master.m3u8'));
    if (source.dev === exported.dev) expect(exported.ino).toBe(source.ino);

    const preview = await createStaticPreviewServer(config.exportRoot);
    const manifest = await preview.inject({ method: 'GET', url: '/media/generations/generation-1/master.m3u8' });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['content-type']).toContain('application/vnd.apple.mpegurl');
    const segment = await preview.inject({ method: 'GET', url: '/media/generations/generation-1/video/segment-000001.m4s' });
    expect(segment.headers['content-type']).toContain('video/iso.segment');
    await preview.close();
  });

  it('refuses to replace a directory that it did not create', async () => {
    const { root, config, db } = await fixture();
    config.exportRoot = path.join(root, 'unmanaged');
    await mkdir(config.exportRoot);
    await writeFile(path.join(config.exportRoot, 'keep.txt'), 'important');
    await expect(exportStaticShowcase(db, config, { buildViewer: async () => undefined }))
      .rejects.toThrow(/Refusing to replace unmanaged directory/u);
    expect(await readFile(path.join(config.exportRoot, 'keep.txt'), 'utf8')).toBe('important');
  });
});
