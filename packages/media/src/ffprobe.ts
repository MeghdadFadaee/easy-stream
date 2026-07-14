import { runProcess, type RunProcessOptions } from './process.js';
import type { MediaProbe, ProbeFormat, ProbeStream } from './types.js';

export interface ProbeOptions extends RunProcessOptions {
  ffprobePath?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProbeJson(raw: string): MediaProbe {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`ffprobe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value) || !Array.isArray(value.streams) || !isRecord(value.format)) {
    throw new Error('ffprobe JSON is missing streams or format');
  }
  const streams = value.streams.filter(isRecord) as unknown as ProbeStream[];
  if (!streams.every((stream) => Number.isInteger(stream.index))) {
    throw new Error('ffprobe returned a stream without a numeric index');
  }
  return {
    streams,
    format: value.format as ProbeFormat,
    chapters: Array.isArray(value.chapters) ? value.chapters.filter(isRecord) : [],
  };
}

export async function probeMedia(sourcePath: string, options: ProbeOptions = {}): Promise<MediaProbe> {
  const result = await runProcess(options.ffprobePath ?? 'ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    sourcePath,
  ], {
    timeoutMs: options.timeoutMs ?? 120_000,
    maxOutputBytes: options.maxOutputBytes ?? 64 * 1024 * 1024,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return parseProbeJson(result.stdout);
}

export { parseProbeJson };
