import { randomUUID } from 'node:crypto';
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { probeMedia } from './ffprobe.js';
import { fingerprintSource } from './fingerprint.js';
import { assessFfmpegWarnings, buildMasterPlaylist, validateMediaPlaylist, type MasterAudio } from './hls.js';
import { languageDisplayName, normalizeStreamLanguage } from './language.js';
import { assertWritableDestination, ensureWritableDirectory, resolveInside } from './paths.js';
import { runProcess } from './process.js';
import type { Classification, MediaProbe, PackageResult, SourceFingerprint } from './types.js';

export interface CompatibilityEncodeOptions {
  archiveRoot: string;
  derivedRoot: string;
  sourcePath: string;
  fingerprint: SourceFingerprint;
  probe: MediaProbe;
  classification: Classification;
  generation: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  segmentSeconds?: number;
}

function frameRate(probe: MediaProbe, videoIndex: number): number {
  const stream = probe.streams.find((candidate) => candidate.index === videoIndex);
  const raw = stream?.avg_frame_rate ?? stream?.r_frame_rate ?? '24/1';
  const [numeratorRaw, denominatorRaw] = raw.split('/');
  const numerator = Number(numeratorRaw);
  const denominator = Number(denominatorRaw ?? 1);
  const value = numerator / denominator;
  return Number.isFinite(value) && value > 0 && value <= 240 ? value : 24;
}

function renditions(probe: MediaProbe, indexes: readonly number[]): MasterAudio[] {
  return indexes.map((streamIndex, index) => {
    const stream = probe.streams.find((candidate) => candidate.index === streamIndex);
    if (stream === undefined) throw new Error(`Audio stream ${streamIndex} is missing`);
    const language = normalizeStreamLanguage(stream);
    return {
      streamIndex,
      language,
      name: languageDisplayName(language),
      uri: `audio-${streamIndex}-${language.replace(/[^a-z0-9-]/giu, '') || 'und'}/index.m3u8`,
      ...(stream.channels === undefined ? {} : { channels: stream.channels }),
      default: index === 0,
    };
  });
}

export function buildCompatibilityEncodeArguments(
  source: string,
  output: string,
  probe: MediaProbe,
  classification: Classification,
  segmentSeconds = 6,
): string[] {
  if (classification.class === 'HOLD_HDR') throw new Error('HDR_UNSUPPORTED_V1');
  if (classification.class === 'INVALID') throw new Error('INVALID_SOURCE');
  const videoIndex = classification.videoStreamIndex;
  if (videoIndex === undefined) throw new Error('No video stream selected');
  const audio = renditions(probe, classification.audioStreamIndexes);
  const gop = Math.max(1, Math.ceil(frameRate(probe, videoIndex) * segmentSeconds));
  const args = [
    '-hide_banner', '-loglevel', 'warning', '-nostdin', '-y',
    '-i', source,
    '-map', `0:${videoIndex}`,
  ];
  for (const item of audio) args.push('-map', `0:${item.streamIndex}`);
  args.push(
    '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
    '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-flags', '+cgop',
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
    '-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`,
  );
  audio.forEach((item, index) => {
    args.push(`-c:a:${index}`, 'aac', `-b:a:${index}`, (item.channels ?? 2) > 2 ? '384k' : '192k');
  });
  const variants = [
    'v:0,agroup:audio,name:video',
    ...audio.map((item, index) => `a:${index},agroup:audio,language:${item.language},default:${item.default ? 'yes' : 'no'},name:${path.dirname(item.uri)}`),
  ].join(' ');
  args.push(
    '-f', 'hls', '-hls_time', String(segmentSeconds),
    '-hls_segment_type', 'fmp4', '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments+temp_file',
    '-master_pl_name', 'master.ffmpeg.m3u8', '-var_stream_map', variants,
    '-hls_fmp4_init_filename', 'init-%v.mp4',
    '-hls_segment_filename', path.join(output, '%v', 'segment-%06d.m4s'),
    path.join(output, '%v', 'index.m3u8'),
  );
  return args;
}

function outputProbe(source: MediaProbe, videoIndex: number): MediaProbe {
  const { bit_rate: _ignoredBitrate, ...format } = source.format;
  return {
    ...source,
    streams: source.streams.map((stream) => {
      if (stream.index === videoIndex) {
        const pixels = (stream.width ?? 1920) * (stream.height ?? 1080);
        return {
          ...stream,
          codec_name: 'h264',
          profile: 'High',
          pix_fmt: 'yuv420p',
          bits_per_raw_sample: '8',
          mime_codec_string: 'avc1.640028',
          bit_rate: String(pixels > 1920 * 1080 ? 20_000_000 : 8_000_000),
        };
      }
      if (stream.codec_type === 'audio') return { ...stream, codec_name: 'aac', profile: 'LC', mime_codec_string: 'mp4a.40.2' };
      return stream;
    }),
    format,
  };
}

async function validateEncodedCodecs(videoPlaylist: string, audioPlaylists: readonly string[], ffprobePath: string): Promise<void> {
  const video = await probeMedia(videoPlaylist, { ffprobePath, timeoutMs: 120_000 });
  if (!video.streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264' && stream.pix_fmt === 'yuv420p')) {
    throw new Error('Compatibility output is not 8-bit H.264 yuv420p');
  }
  for (const playlist of audioPlaylists) {
    const audio = await probeMedia(playlist, { ffprobePath, timeoutMs: 120_000 });
    if (!audio.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac')) {
      throw new Error('Compatibility audio output is not AAC');
    }
  }
}

export async function prepareCompatibilityHls(options: CompatibilityEncodeOptions): Promise<PackageResult> {
  if (options.classification.class === 'HOLD_HDR') throw new Error('HDR_UNSUPPORTED_V1');
  if (options.classification.class !== 'VIDEO_TRANSCODE') {
    throw new Error(`Compatibility video encode is not required for ${options.classification.class}`);
  }
  if (!/^[a-z0-9][a-z0-9._-]{7,127}$/u.test(options.generation)) throw new Error('Invalid generation identifier');
  const source = await resolveInside(options.archiveRoot, options.sourcePath);
  const videoIndex = options.classification.videoStreamIndex;
  if (videoIndex === undefined) throw new Error('No video stream selected');
  const audio = renditions(options.probe, options.classification.audioStreamIndexes);
  const generationsRoot = path.join(options.derivedRoot, 'generations');
  await ensureWritableDirectory(options.derivedRoot, generationsRoot);
  const finalDirectory = await assertWritableDestination(options.derivedRoot, path.join(generationsRoot, options.generation));
  try {
    if ((await stat(path.join(finalDirectory, 'master.m3u8'))).isFile()) {
      const videoPlaylist = await validateMediaPlaylist(path.join(finalDirectory, 'video', 'index.m3u8'), { requireEnded: true, maxTargetDuration: 7 });
      const audioPlaylists = await Promise.all(audio.map((item) => validateMediaPlaylist(path.join(finalDirectory, item.uri), { requireEnded: true, maxTargetDuration: 7 })));
      return { generation: options.generation, outputDirectory: finalDirectory, masterPlaylist: path.join(finalDirectory, 'master.m3u8'), videoPlaylist, audioPlaylists, knownAacRepairs: 0 };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const staging = await assertWritableDestination(options.derivedRoot, path.join(options.derivedRoot, `.building-${options.generation}-${randomUUID()}`));
  await ensureWritableDirectory(options.derivedRoot, staging);
  let moved = false;
  try {
  const result = await runProcess(options.ffmpegPath ?? 'ffmpeg', buildCompatibilityEncodeArguments(
    source, staging, options.probe, options.classification, options.segmentSeconds ?? 6,
  ), { timeoutMs: 7 * 24 * 60 * 60 * 1000, maxOutputBytes: 64 * 1024 * 1024 });
  const warnings = assessFfmpegWarnings(result.stderr);
  if (warnings.unknown.length > 0) throw new Error(`Unrecognized FFmpeg warning(s): ${warnings.unknown.slice(0, 5).join(' | ')}`);
  const videoStaging = path.join(staging, 'video', 'index.m3u8');
  const audioStaging = audio.map((item) => path.join(staging, item.uri));
  const [videoValidation, ...audioValidation] = await Promise.all([
    validateMediaPlaylist(videoStaging, { requireEnded: true, maxTargetDuration: 7 }),
    ...audioStaging.map((playlist) => validateMediaPlaylist(playlist, { requireEnded: true, maxTargetDuration: 7 })),
  ]);
  if (videoValidation === undefined) throw new Error('Encoded video playlist is missing');
  for (const item of audioValidation) {
    if (Math.abs(item.totalDuration - videoValidation.totalDuration) > 0.25) throw new Error('Encoded A/V durations differ by more than 250 ms');
  }
  await validateEncodedCodecs(videoStaging, audioStaging, options.ffprobePath ?? 'ffprobe');
  const after = await fingerprintSource(options.archiveRoot, source, options.fingerprint.edgeBytes);
  if (after.digest !== options.fingerprint.digest) throw new Error('Source changed during compatibility encoding');
  const master = buildMasterPlaylist(outputProbe(options.probe, videoIndex), videoIndex, 'video/index.m3u8', audio);
  await writeFile(path.join(staging, 'master.m3u8'), master, { encoding: 'utf8', mode: 0o640 });
  await rename(staging, finalDirectory);
  moved = true;
  const videoPlaylist = await validateMediaPlaylist(path.join(finalDirectory, 'video', 'index.m3u8'), { requireEnded: true, maxTargetDuration: 7 });
  const audioPlaylists = await Promise.all(audio.map((item) => validateMediaPlaylist(path.join(finalDirectory, item.uri), { requireEnded: true, maxTargetDuration: 7 })));
  return {
    generation: options.generation,
    outputDirectory: finalDirectory,
    masterPlaylist: path.join(finalDirectory, 'master.m3u8'),
    videoPlaylist,
    audioPlaylists,
    knownAacRepairs: warnings.knownAacRepairs,
  };
  } finally {
    if (!moved) await rm(staging, { recursive: true, force: true });
  }
}
