import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeCacheMetadata } from './cache.js';
import { probeMedia } from './ffprobe.js';
import { fingerprintSource } from './fingerprint.js';
import {
  assessFfmpegWarnings,
  buildMasterPlaylist,
  finalizeEventPlaylist,
  validateMediaPlaylist,
  type MasterAudio,
} from './hls.js';
import { languageDisplayName, normalizeStreamLanguage } from './language.js';
import { assertWritableDestination, ensureWritableDirectory, resolveInside } from './paths.js';
import { runProcess } from './process.js';
import { SingleFlight } from './single-flight.js';
import type { Classification, MediaProbe, PackageResult, SourceFingerprint } from './types.js';

const GENERATION_PATTERN = /^[a-z0-9][a-z0-9._-]{7,127}$/u;

export interface PackagingProgress {
  state: 'PREPARING' | 'READY' | 'FAILED';
  generation: string;
  outputDirectory: string;
  playable?: boolean;
  error?: string;
}

export interface PackageHlsOptions {
  archiveRoot: string;
  cacheRoot: string;
  sourcePath: string;
  fingerprint: SourceFingerprint;
  probe: MediaProbe;
  classification: Classification;
  generation?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  segmentSeconds?: number;
  maxTargetDuration?: number;
  profileVersion?: string;
  progressIntervalMs?: number;
  activeBuildMaxAgeMs?: number;
  onProgress?: (progress: PackagingProgress) => void | Promise<void>;
}

function buildGeneration(fingerprint: SourceFingerprint, profileVersion: string): string {
  const profile = profileVersion.toLowerCase().replace(/[^a-z0-9._-]/gu, '-').slice(0, 32);
  return `${profile}-${fingerprint.digest.slice(0, 32)}`;
}

function audioRenditions(probe: MediaProbe, indexes: readonly number[]): MasterAudio[] {
  return indexes.map((streamIndex, index) => {
    const stream = probe.streams.find((candidate) => candidate.index === streamIndex);
    if (stream === undefined) throw new Error(`Audio stream ${streamIndex} is missing`);
    const language = normalizeStreamLanguage(stream);
    const safeLanguage = language.replace(/[^a-z0-9-]/giu, '').toLowerCase() || 'und';
    return {
      streamIndex,
      language,
      name: languageDisplayName(language),
      uri: `audio-${streamIndex}-${safeLanguage}/index.m3u8`,
      ...(stream.channels === undefined ? {} : { channels: stream.channels }),
      default: index === 0,
    };
  });
}

function ffmpegArguments(
  source: string,
  output: string,
  videoIndex: number,
  audio: readonly MasterAudio[],
  classification: Classification,
  segmentSeconds: number,
): string[] {
  const arguments_: string[] = [
    '-hide_banner', '-loglevel', 'warning', '-nostdin', '-y',
    '-i', source,
    '-map', `0:${videoIndex}`,
  ];
  for (const item of audio) arguments_.push('-map', `0:${item.streamIndex}`);
  arguments_.push('-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn', '-c:v', 'copy');
  if (classification.class === 'AUDIO_TRANSCODE') {
    audio.forEach((item, index) => {
      arguments_.push(`-c:a:${index}`, 'aac', `-b:a:${index}`, (item.channels ?? 2) > 2 ? '384k' : '192k');
    });
  } else {
    arguments_.push('-c:a', 'copy');
  }
  const variants = [
    'v:0,agroup:audio,name:video',
    ...audio.map((item, index) => {
      const folder = path.dirname(item.uri);
      return `a:${index},agroup:audio,language:${item.language},default:${item.default ? 'yes' : 'no'},name:${folder}`;
    }),
  ].join(' ');
  arguments_.push(
    '-f', 'hls',
    '-hls_time', String(segmentSeconds),
    '-hls_segment_type', 'fmp4',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-master_pl_name', 'master.live.m3u8',
    '-var_stream_map', variants,
    '-hls_fmp4_init_filename', 'init-%v.mp4',
    '-hls_segment_filename', path.join(output, '%v', 'segment-%06d.m4s'),
    path.join(output, '%v', 'index.m3u8'),
  );
  return arguments_;
}

export class GenerationBuildActiveError extends Error {
  constructor(readonly generation: string) {
    super(`Generation is already being built: ${generation}`);
    this.name = 'GenerationBuildActiveError';
  }
}

async function existingPackage(
  generation: string,
  outputDirectory: string,
  masterPlaylist: string,
  videoPlaylistPath: string,
  audioPlaylistPaths: readonly string[],
  ffprobePath: string,
  maxTargetDuration: number,
): Promise<PackageResult | undefined> {
  try {
    const [videoPlaylist, ...audioPlaylists] = await Promise.all([
      validateMediaPlaylist(videoPlaylistPath, { requireEnded: true, maxTargetDuration }),
      ...audioPlaylistPaths.map((playlist) => validateMediaPlaylist(playlist, { requireEnded: true, maxTargetDuration })),
    ]);
    if (videoPlaylist === undefined) return undefined;
    const master = await readFile(masterPlaylist, 'utf8');
    if (!master.startsWith('#EXTM3U') || !master.includes('video/index.m3u8')) return undefined;
    await validateCodecs(videoPlaylistPath, audioPlaylistPaths, ffprobePath);
    return { generation, outputDirectory, masterPlaylist, videoPlaylist, audioPlaylists, knownAacRepairs: 0 };
  } catch {
    return undefined;
  }
}

async function validateCodecs(videoPlaylist: string, audioPlaylists: readonly string[], ffprobePath: string): Promise<void> {
  const video = await probeMedia(videoPlaylist, { ffprobePath, timeoutMs: 120_000 });
  if (!video.streams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264')) {
    throw new Error('Packaged video does not probe as H.264');
  }
  for (const playlist of audioPlaylists) {
    const audio = await probeMedia(playlist, { ffprobePath, timeoutMs: 120_000 });
    if (!audio.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac')) {
      throw new Error(`Packaged audio does not probe as AAC: ${playlist}`);
    }
  }
}

async function writeMaster(destination: string, content: string): Promise<void> {
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o640 });
  await rename(temporary, destination);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function packageProgressiveHls(options: PackageHlsOptions): Promise<PackageResult> {
  if (!['COPY', 'AUDIO_TRANSCODE'].includes(options.classification.class)) {
    throw new Error(`Source cannot be JIT packaged: ${options.classification.class}`);
  }
  const source = await resolveInside(options.archiveRoot, options.sourcePath);
  const generation = options.generation ?? buildGeneration(options.fingerprint, options.profileVersion ?? 'cmaf-v1');
  if (!GENERATION_PATTERN.test(generation)) throw new Error('Invalid generation identifier');
  const generationsRoot = path.join(options.cacheRoot, 'generations');
  await ensureWritableDirectory(options.cacheRoot, generationsRoot);
  const outputDirectory = await assertWritableDestination(options.cacheRoot, path.join(generationsRoot, generation));
  const videoIndex = options.classification.videoStreamIndex;
  if (videoIndex === undefined) throw new Error('Classification selected no video stream');
  const audio = audioRenditions(options.probe, options.classification.audioStreamIndexes);
  const videoPlaylistPath = path.join(outputDirectory, 'video', 'index.m3u8');
  const audioPlaylistPaths = audio.map((item) => path.join(outputDirectory, item.uri));
  const masterPlaylist = path.join(outputDirectory, 'master.m3u8');
  const master = buildMasterPlaylist(options.probe, videoIndex, 'video/index.m3u8', audio);
  let outputExists = false;
  try {
    outputExists = (await stat(outputDirectory)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (outputExists) {
    const ready = await existingPackage(
      generation,
      outputDirectory,
      masterPlaylist,
      videoPlaylistPath,
      audioPlaylistPaths,
      options.ffprobePath ?? 'ffprobe',
      options.maxTargetDuration ?? 18,
    );
    if (ready !== undefined) {
      await options.onProgress?.({ state: 'READY', generation, outputDirectory, playable: true });
      return ready;
    }
    let building = false;
    let lastAccessedAt = 0;
    try {
      const metadata = JSON.parse(await readFile(path.join(outputDirectory, '.cache-entry.json'), 'utf8')) as {
        building?: boolean; lastAccessedAt?: string;
      };
      building = metadata.building === true;
      lastAccessedAt = Date.parse(metadata.lastAccessedAt ?? '');
    } catch {
      // An unrecognized partial directory is treated as a failed build and archived.
    }
    if (building && Number.isFinite(lastAccessedAt)
      && Date.now() - lastAccessedAt < (options.activeBuildMaxAgeMs ?? 26 * 60 * 60 * 1000)) {
      throw new GenerationBuildActiveError(generation);
    }
    const failedName = `failed-${Date.now()}-${generation}`;
    const failedDirectory = path.join(generationsRoot, failedName);
    await rename(outputDirectory, failedDirectory);
    try {
      await writeCacheMetadata(generationsRoot, failedDirectory, {
        key: failedName,
        lastAccessedAt: new Date().toISOString(),
        active: false,
        building: false,
        pinned: false,
      });
    } catch {
      // The archived directory remains diagnostic-only even without cache metadata.
    }
  }
  try {
    await mkdir(outputDirectory, { recursive: false, mode: 0o750 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new GenerationBuildActiveError(generation);
    throw error;
  }
  // This stable URL exists before playable=true; it references atomically published EVENT playlists.
  await writeMaster(masterPlaylist, master);
  await writeCacheMetadata(generationsRoot, outputDirectory, {
    key: generation,
    lastAccessedAt: new Date().toISOString(),
    active: false,
    building: true,
    pinned: false,
    bytes: 0,
  });
  await options.onProgress?.({ state: 'PREPARING', generation, outputDirectory, playable: false });

  let settled = false;
  let processResult: Awaited<ReturnType<typeof runProcess>> | undefined;
  let processError: unknown;
  const processPromise = runProcess(options.ffmpegPath ?? 'ffmpeg', ffmpegArguments(
    source,
    outputDirectory,
    videoIndex,
    audio,
    options.classification,
    options.segmentSeconds ?? 6,
  ), { timeoutMs: 24 * 60 * 60 * 1000, maxOutputBytes: 64 * 1024 * 1024 }).then(
    (result) => { processResult = result; },
    (error: unknown) => { processError = error; },
  ).finally(() => { settled = true; });

  let playableReported = false;
  try {
    while (!settled && !playableReported) {
      await delay(options.progressIntervalMs ?? 250);
      try {
        await Promise.all([
          validateMediaPlaylist(videoPlaylistPath, { minSegments: 2, maxTargetDuration: options.maxTargetDuration ?? 18 }),
          ...audioPlaylistPaths.map((playlist) => validateMediaPlaylist(playlist, { minSegments: 2, maxTargetDuration: options.maxTargetDuration ?? 18 })),
        ]);
        playableReported = true;
        await options.onProgress?.({ state: 'PREPARING', generation, outputDirectory, playable: true });
      } catch {
        // The producer publishes manifests and segments atomically; absence here means not ready yet.
      }
    }
    await processPromise;
    if (processError !== undefined) throw processError;
    if (processResult === undefined) throw new Error('FFmpeg completed without a result');
    const afterFingerprint = await fingerprintSource(options.archiveRoot, source, options.fingerprint.edgeBytes);
    if (afterFingerprint.digest !== options.fingerprint.digest) throw new Error('Source changed during packaging');
    const warnings = assessFfmpegWarnings(processResult.stderr);
    if (warnings.unknown.length > 0) {
      throw new Error(`Unrecognized FFmpeg warning(s): ${warnings.unknown.slice(0, 5).join(' | ')}`);
    }
    const initial = await Promise.all([
      validateMediaPlaylist(videoPlaylistPath, { requireEnded: true, maxTargetDuration: options.maxTargetDuration ?? 18 }),
      ...audioPlaylistPaths.map((playlist) => validateMediaPlaylist(playlist, { requireEnded: true, maxTargetDuration: options.maxTargetDuration ?? 18 })),
    ]);
    const [videoInitial, ...audioInitial] = initial;
    if (videoInitial === undefined) throw new Error('Video playlist validation did not run');
    for (const item of audioInitial) {
      if (Math.abs(item.totalDuration - videoInitial.totalDuration) > 0.25) {
        throw new Error(`A/V duration differs by more than 250 ms (${videoInitial.totalDuration} vs ${item.totalDuration})`);
      }
    }
    await validateCodecs(videoPlaylistPath, audioPlaylistPaths, options.ffprobePath ?? 'ffprobe');
    await Promise.all([videoPlaylistPath, ...audioPlaylistPaths].map(finalizeEventPlaylist));
    const [videoPlaylist, ...audioPlaylists] = await Promise.all([
      validateMediaPlaylist(videoPlaylistPath, { requireEnded: true, maxTargetDuration: options.maxTargetDuration ?? 18 }),
      ...audioPlaylistPaths.map((playlist) => validateMediaPlaylist(playlist, { requireEnded: true, maxTargetDuration: options.maxTargetDuration ?? 18 })),
    ]);
    if (videoPlaylist === undefined) throw new Error('Final video playlist is missing');
    await writeCacheMetadata(generationsRoot, outputDirectory, {
      key: generation,
      lastAccessedAt: new Date().toISOString(),
      active: false,
      building: false,
      pinned: false,
    });
    await options.onProgress?.({ state: 'READY', generation, outputDirectory, playable: true });
    return { generation, outputDirectory, masterPlaylist, videoPlaylist, audioPlaylists, knownAacRepairs: warnings.knownAacRepairs };
  } catch (error) {
    try {
      const details = await stat(outputDirectory);
      if (details.isDirectory()) {
        await writeCacheMetadata(generationsRoot, outputDirectory, {
          key: generation,
          lastAccessedAt: new Date().toISOString(),
          active: false,
          building: false,
          pinned: false,
        });
      }
    } catch {
      // Preserve the original packaging error.
    }
    await options.onProgress?.({
      state: 'FAILED',
      generation,
      outputDirectory,
      playable: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export class ProgressiveHlsPackager {
  readonly #singleFlight = new SingleFlight();

  package(options: PackageHlsOptions): Promise<PackageResult> {
    const generation = options.generation ?? buildGeneration(options.fingerprint, options.profileVersion ?? 'cmaf-v1');
    return this.#singleFlight.run(generation, async () => await packageProgressiveHls({ ...options, generation }));
  }
}

export async function readGeneratedMaster(outputDirectory: string): Promise<string> {
  return await readFile(path.join(outputDirectory, 'master.m3u8'), 'utf8');
}
