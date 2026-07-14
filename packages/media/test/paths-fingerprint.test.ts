import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprintSource, isPathInside, walkArchive } from '../src/index.js';

describe('archive boundaries', () => {
  it('walks regular MKV files without following symlinks', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-walk-'));
    const root = path.join(base, 'archive');
    const outside = path.join(base, 'outside');
    await Promise.all([mkdir(path.join(root, 'series'), { recursive: true }), mkdir(outside)]);
    await writeFile(path.join(root, 'series', 'one.mkv'), 'safe');
    await writeFile(path.join(outside, 'secret.mkv'), 'secret');
    await symlink(path.join(outside, 'secret.mkv'), path.join(root, 'linked.mkv'));
    const files: string[] = [];
    for await (const file of walkArchive(root)) files.push(file);
    expect(files).toEqual([await realpath(path.join(root, 'series', 'one.mkv'))]);
    expect(isPathInside(root, path.join(root, 'series', 'one.mkv'))).toBe(true);
    expect(isPathInside(root, path.join(outside, 'secret.mkv'))).toBe(false);
  });

  it('fingerprints path, stat and both file edges', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-fingerprint-'));
    const source = path.join(root, 'movie.mkv');
    await writeFile(source, 'HEAD-middle-TAIL');
    const first = await fingerprintSource(root, source, 4);
    const same = await fingerprintSource(root, source, 4);
    expect(same.digest).toBe(first.digest);
    await writeFile(source, 'HEAd-middle-TAIL');
    const changed = await fingerprintSource(root, source, 4);
    expect(changed.digest).not.toBe(first.digest);
  });
});
