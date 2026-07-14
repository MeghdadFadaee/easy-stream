import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, link, lstat, opendir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { assertWritableDestination, assertWritableRoot, ensureWritableDirectory, resolveInside, UnsafePathError } from './paths.js';
import { runProcess } from './process.js';
import type { ProcessResult, RunProcessOptions } from './process.js';
import type { MediaProbe, ProbeStream, StoredFont } from './types.js';

const MAX_FONT_BYTES = 10 * 1024 * 1024;
const MAX_FONT_COUNT = 128;
const MAX_TOTAL_FONT_BYTES = 128 * 1024 * 1024;

function attachmentLooksLikeFont(stream: ProbeStream): boolean {
  const mime = stream.tags?.mimetype?.toLowerCase() ?? '';
  const name = stream.tags?.filename?.toLowerCase() ?? '';
  return stream.codec_type === 'attachment'
    && (stream.codec_name === 'ttf' || stream.codec_name === 'otf'
      || mime.includes('font') || mime.includes('truetype') || mime.includes('opentype')
      || /\.(?:ttf|otf)$/iu.test(name));
}

export function validateSfntFont(data: Buffer): 'ttf' | 'otf' {
  if (data.length < 12 || data.length > MAX_FONT_BYTES) throw new Error('Font size is outside accepted bounds');
  const signature = data.subarray(0, 4).toString('ascii');
  let format: 'ttf' | 'otf';
  if (data.readUInt32BE(0) === 0x00010000 || signature === 'true' || signature === 'typ1') format = 'ttf';
  else if (signature === 'OTTO') format = 'otf';
  else throw new Error(`Unsupported font signature ${JSON.stringify(signature)}`);
  const numTables = data.readUInt16BE(4);
  if (numTables < 1 || numTables > 256 || 12 + numTables * 16 > data.length) {
    throw new Error('Malformed SFNT table directory');
  }
  for (let index = 0; index < numTables; index += 1) {
    const record = 12 + index * 16;
    const offset = data.readUInt32BE(record + 8);
    const length = data.readUInt32BE(record + 12);
    if (offset > data.length || length > data.length || offset + length > data.length) {
      throw new Error('SFNT table points outside the attachment');
    }
  }
  return format;
}

export interface FontExtractionOptions {
  archiveRoot: string;
  fontRoot: string;
  ffmpegPath?: string;
  sanitizerPath?: string;
  timeoutMs?: number;
  runner?: (binary: string, args: readonly string[], options?: RunProcessOptions) => Promise<ProcessResult>;
}

export function fontDumpArguments(streamIndex: number, destination: string, source: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    `-dump_attachment:${streamIndex}`, destination,
    '-i', source,
    // Attachment dumping happens as the input header opens. Do not decode the movie.
    '-t', '0',
    '-f', 'null', '-',
  ];
}

export async function extractAndStoreFonts(
  sourcePath: string,
  probe: MediaProbe,
  options: FontExtractionOptions,
): Promise<StoredFont[]> {
  const source = await resolveInside(options.archiveRoot, sourcePath);
  const staging = await ensureWritableDirectory(options.fontRoot, path.join(options.fontRoot, '.staging'), 0o700);
  const store = await ensureWritableDirectory(options.fontRoot, path.join(options.fontRoot, 'sha256'));
  const attachments = probe.streams.filter(attachmentLooksLikeFont);
  if (attachments.length > MAX_FONT_COUNT) throw new Error(`File has too many font attachments (${attachments.length})`);
  const declaredTotal = attachments.reduce((sum, stream) => sum + (stream.extradata_size ?? 0), 0);
  if (declaredTotal > MAX_TOTAL_FONT_BYTES) throw new Error('Declared font attachments exceed the total size limit');
  const output: StoredFont[] = [];
  const execute = options.runner ?? runProcess;

  for (const attachment of attachments) {
    if ((attachment.extradata_size ?? 0) > MAX_FONT_BYTES) {
      throw new Error(`Font attachment ${attachment.index} exceeds ${MAX_FONT_BYTES} bytes`);
    }
    const temporary = path.join(staging, `${randomUUID()}.font`);
    try {
      await execute(
        options.ffmpegPath ?? 'ffmpeg',
        fontDumpArguments(attachment.index, temporary, source),
        { timeoutMs: options.timeoutMs ?? 120_000 },
      );
      const data = await readFile(temporary);
      const format = validateSfntFont(data);
      if (options.sanitizerPath !== undefined) {
        await execute(options.sanitizerPath, [temporary], { timeoutMs: 30_000 });
      }
      const sha256 = createHash('sha256').update(data).digest('hex');
      const destination = path.join(store, `${sha256}.${format}`);
      try {
        await link(temporary, destination);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw error;
      }
      const stored = await lstat(destination);
      if (stored.isSymbolicLink() || !stored.isFile()) {
        throw new UnsafePathError(`Stored font is not a regular file: ${destination}`);
      }
      await access(destination, constants.R_OK);
      output.push({
        streamIndex: attachment.index,
        sha256,
        path: destination,
        originalName: path.basename(attachment.tags?.filename ?? `attachment-${attachment.index}`),
        size: data.length,
        format,
      });
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return output;
}

/** Publishes hash-named generation-local font links while retaining one global content store. */
export async function publishGenerationFonts(
  fonts: readonly StoredFont[],
  mediaRoot: string,
  generationDirectory: string,
): Promise<StoredFont[]> {
  await assertWritableRoot(mediaRoot);
  const root = await realpath(mediaRoot);
  const generation = await resolveInside(root, generationDirectory);
  const directory = await ensureWritableDirectory(root, path.join(generation, 'fonts'));
  const published: StoredFont[] = [];
  for (const font of fonts) {
    const source = await resolveInside(root, font.path);
    const destination = path.join(directory, `${font.sha256}.${font.format}`);
    try {
      await link(source, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') {
        try {
          await copyFile(source, destination, constants.COPYFILE_EXCL);
        } catch (copyError) {
          if ((copyError as NodeJS.ErrnoException).code !== 'EEXIST') throw copyError;
        }
      } else if (code !== 'EEXIST') {
        throw error;
      }
    }
    const details = await lstat(destination);
    if (details.isSymbolicLink() || !details.isFile() || details.size !== font.size) {
      throw new Error(`Published font failed verification: ${font.sha256}`);
    }
    published.push({ ...font, path: destination });
  }
  return published;
}

export interface FontPruneOptions {
  /** Avoid racing a package that extracted a font but has not published its hardlink yet. */
  minimumAgeMs?: number;
  now?: Date;
}

export interface FontPruneResult {
  removed: string[];
  retainedBytes: number;
}

/** Removes aged content-store files that have no generation hardlinks. */
export async function pruneOrphanedFonts(
  mediaRoot: string,
  options: FontPruneOptions = {},
): Promise<FontPruneResult> {
  const minimumAgeMs = options.minimumAgeMs ?? 60 * 60 * 1000;
  if (!Number.isFinite(minimumAgeMs) || minimumAgeMs < 0) throw new RangeError('Invalid font prune age');
  let root: string;
  try {
    await assertWritableRoot(mediaRoot);
    root = await realpath(mediaRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: [], retainedBytes: 0 };
    throw error;
  }
  let store: string;
  try {
    const storeCandidate = path.join(root, 'assets', 'fonts', 'sha256');
    await assertWritableDestination(root, storeCandidate);
    store = await resolveInside(root, storeCandidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: [], retainedBytes: 0 };
    throw error;
  }
  let handle: Awaited<ReturnType<typeof opendir>>;
  try {
    handle = await opendir(store);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: [], retainedBytes: 0 };
    throw error;
  }
  const cutoff = (options.now ?? new Date()).getTime() - minimumAgeMs;
  const removed: string[] = [];
  let retainedBytes = 0;
  for await (const entry of handle) {
    if (!/^[a-f0-9]{64}\.(?:ttf|otf)$/u.test(entry.name)) continue;
    const candidate = path.join(store, entry.name);
    const details = await lstat(candidate);
    if (details.isSymbolicLink()) throw new Error(`Symlink found in global font store: ${candidate}`);
    if (!details.isFile()) continue;
    if (details.nlink <= 1 && details.mtimeMs <= cutoff) {
      await rm(candidate, { force: false });
      removed.push(entry.name);
    } else {
      retainedBytes += details.size;
    }
  }
  return { removed, retainedBytes };
}
