import { link, mkdtemp, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractAndStoreFonts,
  fontDumpArguments,
  pruneOrphanedFonts,
  publishGenerationFonts,
  validateSfntFont,
} from '../src/index.js';
import { probe } from './fixtures.js';

function minimalSfnt(): Buffer {
  const data = Buffer.alloc(28);
  data.writeUInt32BE(0x00010000, 0);
  data.writeUInt16BE(1, 4);
  data.write('head', 12, 'ascii');
  data.writeUInt32BE(28, 20);
  data.writeUInt32BE(0, 24);
  return data;
}

describe('font attachment safety', () => {
  it('validates the SFNT directory rather than trusting an extension', () => {
    expect(validateSfntFont(minimalSfnt())).toBe('ttf');
    expect(() => validateSfntFont(Buffer.from('not a font'))).toThrow();
  });

  it('builds a header-only FFmpeg dump command', () => {
    const args = fontDumpArguments(4, '/cache/font', '/archive/movie.mkv');
    expect(args).toContain('-dump_attachment:4');
    expect(args.slice(args.indexOf('-i') + 2)).toContain('-t');
    expect(args[args.indexOf('-t') + 1]).toBe('0');
  });

  it('cleans staging data when extracted font validation fails', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-font-'));
    const archive = path.join(base, 'archive');
    const fontRoot = path.join(base, 'fonts');
    await mkdir(archive);
    const source = path.join(archive, 'movie.mkv');
    await writeFile(source, 'archive');
    const mediaProbe = probe([{ index: 4, codec_type: 'attachment', codec_name: 'ttf', extradata_size: 10, tags: { filename: 'bad.ttf' } }]);
    await expect(extractAndStoreFonts(source, mediaProbe, {
      archiveRoot: archive,
      fontRoot,
      async runner(_binary, args) {
        const destination = args[args.indexOf('-dump_attachment:4') + 1];
        if (destination === undefined) throw new Error('Missing mock destination');
        await writeFile(destination, 'invalid');
        return { code: 0, stdout: '', stderr: '' };
      },
    })).rejects.toThrow('Font size');
    expect(await readdir(path.join(fontRoot, '.staging'))).toEqual([]);
  });

  it('publishes deduplicated fonts under the signed generation path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-font-publish-'));
    const sourceDirectory = path.join(root, 'assets', 'fonts', 'sha256');
    const generation = path.join(root, 'generations', '11111111-1111-4111-8111-111111111111');
    await Promise.all([mkdir(sourceDirectory, { recursive: true }), mkdir(generation, { recursive: true })]);
    const data = minimalSfnt();
    const sha256 = 'a'.repeat(64);
    const source = path.join(sourceDirectory, `${sha256}.ttf`);
    await writeFile(source, data);
    const font = { streamIndex: 4, sha256, path: source, originalName: 'source.ttf', size: data.length, format: 'ttf' as const };
    const first = await publishGenerationFonts([font], root, generation);
    const second = await publishGenerationFonts([font], root, generation);
    expect(first[0]?.path).toBe(path.join(await realpath(generation), 'fonts', `${sha256}.ttf`));
    expect(second[0]?.path).toBe(first[0]?.path);
    expect(await readFile(first[0]!.path)).toEqual(data);
  });

  it('prunes only global fonts with no generation hardlinks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-font-prune-'));
    const store = path.join(root, 'assets', 'fonts', 'sha256');
    const generationFonts = path.join(root, 'generations', 'generation-id', 'fonts');
    await Promise.all([mkdir(store, { recursive: true }), mkdir(generationFonts, { recursive: true })]);
    const orphan = `${'a'.repeat(64)}.ttf`;
    const retained = `${'b'.repeat(64)}.otf`;
    await Promise.all([
      writeFile(path.join(store, orphan), minimalSfnt()),
      writeFile(path.join(store, retained), minimalSfnt()),
    ]);
    await link(path.join(store, retained), path.join(generationFonts, retained));
    const result = await pruneOrphanedFonts(root, { minimumAgeMs: 0, now: new Date(Date.now() + 1000) });
    expect(result.removed).toEqual([orphan]);
    expect(result.retainedBytes).toBe(minimalSfnt().length);
    await expect(stat(path.join(store, orphan))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(path.join(store, retained))).nlink).toBe(2);
  });
});
