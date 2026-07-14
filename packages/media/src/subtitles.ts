import { randomUUID } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { normalizeStreamLanguage } from './language.js';
import { ensureWritableDirectory, resolveInside } from './paths.js';
import { runProcess } from './process.js';
import type { ExtractedSubtitle, MediaProbe } from './types.js';

const TEXT_SUBTITLE_CODECS = new Set(['ass', 'ssa', 'subrip', 'srt', 'webvtt', 'mov_text']);

export interface SubtitleExtractionOptions {
  archiveRoot: string;
  outputRoot: string;
  generation: string;
  ffmpegPath?: string;
  timeoutMs?: number;
}

export function assDialogueText(ass: string): string {
  return ass
    .split(/\r?\n/u)
    .filter((line) => /^Dialogue\s*:/iu.test(line))
    .map((line) => line.split(',').slice(9).join(','))
    .join('\n');
}

export function countAssCues(ass: string): number {
  return ass.split(/\r?\n/u).filter((line) => /^Dialogue\s*:/iu.test(line)).length;
}

export interface SubtitleReadOptions {
  archiveRoot: string;
  ffmpegPath?: string;
  timeoutMs?: number;
  maxDurationSeconds?: number;
}

export function subtitleAssArguments(
  source: string,
  streamIndex: number,
  maxDurationSeconds?: number,
): string[] {
  if (!Number.isInteger(streamIndex) || streamIndex < 0) throw new RangeError('streamIndex must be non-negative');
  if (maxDurationSeconds !== undefined
    && (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0 || maxDurationSeconds > 86_400)) {
    throw new RangeError('maxDurationSeconds must be greater than 0 and at most 86400');
  }
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', source,
    '-map', `0:${streamIndex}`,
    ...(maxDurationSeconds === undefined ? [] : ['-t', String(maxDurationSeconds)]),
    '-c:s', 'ass',
    '-f', 'ass',
    'pipe:1',
  ];
}

export async function readSubtitleAsAss(
  sourcePath: string,
  streamIndex: number,
  options: SubtitleReadOptions,
): Promise<string> {
  const source = await resolveInside(options.archiveRoot, sourcePath);
  const result = await runProcess(
    options.ffmpegPath ?? 'ffmpeg',
    subtitleAssArguments(source, streamIndex, options.maxDurationSeconds),
    { timeoutMs: options.timeoutMs ?? 120_000, maxOutputBytes: 16 * 1024 * 1024 },
  );
  return result.stdout;
}

async function atomicRename(temp: string, destination: string): Promise<void> {
  await rename(temp, destination);
}

export async function extractSubtitleVariants(
  sourcePath: string,
  probe: MediaProbe,
  options: SubtitleExtractionOptions,
): Promise<ExtractedSubtitle[]> {
  const source = await resolveInside(options.archiveRoot, sourcePath);
  const directory = await ensureWritableDirectory(
    options.outputRoot,
    path.join(options.outputRoot, options.generation, 'subtitles'),
  );
  const streams = probe.streams.filter(
    (stream) => stream.codec_type === 'subtitle' && TEXT_SUBTITLE_CODECS.has(stream.codec_name ?? ''),
  );
  const extracted: ExtractedSubtitle[] = [];

  for (const stream of streams) {
    const token = randomUUID();
    const tempAss = path.join(directory, `.${stream.index}-${token}.ass`);
    const tempVtt = path.join(directory, `.${stream.index}-${token}.vtt`);
    await runProcess(options.ffmpegPath ?? 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', source,
      '-map', `0:${stream.index}`,
      '-c:s', 'ass',
      tempAss,
    ], { timeoutMs: options.timeoutMs ?? 120_000 });
    const ass = await readFile(tempAss, 'utf8');
    const language = normalizeStreamLanguage(stream, assDialogueText(ass));
    const stem = `${String(stream.index).padStart(3, '0')}-${language}`;
    const assPath = path.join(directory, `${stem}.ass`);
    const vttPath = path.join(directory, `${stem}.vtt`);
    await runProcess(options.ffmpegPath ?? 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', tempAss,
      '-c:s', 'webvtt',
      tempVtt,
    ], { timeoutMs: options.timeoutMs ?? 120_000 });
    await atomicRename(tempAss, assPath);
    await atomicRename(tempVtt, vttPath);
    extracted.push({
      streamIndex: stream.index,
      language,
      assPath,
      vttPath,
      cueCount: countAssCues(ass),
      default: language === 'fa',
      forced: false,
    });
  }
  return extracted;
}
