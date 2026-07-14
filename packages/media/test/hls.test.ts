import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessFfmpegWarnings,
  buildMasterPlaylist,
  finalizeEventPlaylist,
  parseMediaPlaylist,
  validateMediaPlaylist,
} from '../src/index.js';
import { audio, probe, video } from './fixtures.js';

async function playlistFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-hls-'));
  await Promise.all([
    writeFile(path.join(directory, 'init.mp4'), 'init'),
    writeFile(path.join(directory, 'segment-000.m4s'), 'one'),
    writeFile(path.join(directory, 'segment-001.m4s'), 'two'),
  ]);
  const playlist = path.join(directory, 'index.m3u8');
  await writeFile(playlist, [
    '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10', '#EXT-X-PLAYLIST-TYPE:EVENT',
    '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:9.2,', 'segment-000.m4s', '#EXTINF:4.0,',
    'segment-001.m4s', '#EXT-X-ENDLIST', '',
  ].join('\n'));
  return playlist;
}

describe('HLS validation', () => {
  it('checks all local fMP4 references and finalizes EVENT to VOD atomically', async () => {
    const playlist = await playlistFixture();
    const result = await validateMediaPlaylist(playlist, { requireEnded: true, minSegments: 2, maxTargetDuration: 18 });
    expect(result).toMatchObject({ segmentCount: 2, maxDuration: 9.2, totalDuration: 13.2 });
    await finalizeEventPlaylist(playlist);
    expect(await readFile(playlist, 'utf8')).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
  });

  it('rejects traversal and remote segment URIs', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'easy-stream-hls-unsafe-'));
    await writeFile(path.join(directory, 'init.mp4'), 'init');
    const traversal = path.join(directory, 'traversal.m3u8');
    await writeFile(traversal, '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5,\n../secret.m4s');
    await expect(validateMediaPlaylist(traversal)).rejects.toThrow('Unsafe or external HLS URI');
    const remote = path.join(directory, 'remote.m3u8');
    await writeFile(remote, '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5,\nhttps://evil.invalid/a.m4s');
    await expect(validateMediaPlaylist(remote)).rejects.toThrow('Unsafe or external HLS URI');
  });

  it('permits only the bounded -32 AAC rounding warning', () => {
    const known = assessFfmpegWarnings('[mp4 @ a] Packet duration: -32 / dts: 580456 in stream 0 is out of range');
    expect(known).toMatchObject({ knownAacRepairs: 1, unknown: [] });
    expect(assessFfmpegWarnings('[mp4 @ a] Packet duration: -64 / dts: 10 in stream 0 is out of range').unknown)
      .toHaveLength(1);
    expect(assessFfmpegWarnings('Non-monotonous DTS').unknown).toHaveLength(1);
  });

  it('uses declared/container bitrate and a conservative video fallback', () => {
    const declared = buildMasterPlaylist(probe(), 0, 'video/index.m3u8', [{
      streamIndex: 1, language: 'ja', name: 'Japanese', uri: 'audio/index.m3u8', default: true,
    }]);
    expect(declared).toContain('AVERAGE-BANDWIDTH=852432');
    const missing = probe([video({ tags: {}, bit_rate: undefined }), audio({ tags: {}, bit_rate: undefined })]);
    missing.format.bit_rate = undefined;
    const conservative = buildMasterPlaylist(missing, 0, 'video/index.m3u8', [{
      streamIndex: 1, language: 'ja', name: 'Japanese', uri: 'audio/index.m3u8', default: true,
    }]);
    const bandwidth = Number(conservative.match(/BANDWIDTH=(\d+)/u)?.[1]);
    expect(bandwidth).toBeGreaterThan(8_000_000);
  });
});
