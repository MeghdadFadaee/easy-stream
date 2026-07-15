import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  lstat,
  link,
  mkdir,
  mkdtemp,
  opendir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { ShowcaseConfig } from './config.js';
import { projectRoot } from './config.js';
import { buildShowcaseSnapshot } from './snapshot.js';

const markerName = '.easy-stream-static-export';
const mediaExtensions = new Set(['.m3u8', '.m4s', '.mp4', '.ass', '.vtt', '.ttf', '.otf', '.woff', '.woff2']);
const artworkExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

export interface StaticExportResult {
  outputRoot: string;
  files: number;
  bytes: number;
}

export interface StaticExportOptions {
  outputRoot?: string;
  buildViewer?: (outputRoot: string) => Promise<void>;
}

interface CopyStats {
  files: number;
  bytes: number;
}

function run(command: string, args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, env: environment, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? 'unknown'}`}`));
    });
  });
}

async function buildStaticViewer(outputRoot: string): Promise<void> {
  const environment = {
    ...process.env,
    VITE_APP_EDITION: 'showcase',
    VITE_SHOWCASE_CATALOG_URL: './catalog.json',
    VITE_SHOWCASE_STATIC: 'true',
  };
  await run('corepack', ['pnpm', '--filter', '@easy-stream/web', 'exec', 'vue-tsc', '--noEmit'], environment);
  await run('corepack', ['pnpm', '--filter', '@easy-stream/web', 'exec', 'vite', 'build', '--outDir', outputRoot, '--emptyOutDir'], environment);
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function copyOrLink(source: string, destination: string): Promise<number> {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await link(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')) throw error;
    await copyFile(source, destination);
  }
  return (await stat(source)).size;
}

async function copyTree(
  sourceRoot: string,
  destinationRoot: string,
  allowedExtensions: ReadonlySet<string>,
): Promise<CopyStats> {
  const result = { files: 0, bytes: 0 };
  const directory = await opendir(sourceRoot);
  for await (const entry of directory) {
    if (entry.name.startsWith('.')) continue;
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    if (entry.isDirectory()) {
      const nested = await copyTree(source, destination, allowedExtensions);
      result.files += nested.files;
      result.bytes += nested.bytes;
    } else if (entry.isFile() && allowedExtensions.has(path.extname(entry.name).toLowerCase())) {
      result.bytes += await copyOrLink(source, destination);
      result.files += 1;
    }
  }
  return result;
}

async function treeStats(root: string): Promise<CopyStats> {
  const result = { files: 0, bytes: 0 };
  const directory = await opendir(root);
  for await (const entry of directory) {
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await treeStats(filename);
      result.files += nested.files;
      result.bytes += nested.bytes;
    } else if (entry.isFile()) {
      result.files += 1;
      result.bytes += (await stat(filename)).size;
    }
  }
  return result;
}

async function assertManagedTarget(outputRoot: string): Promise<void> {
  try {
    const target = await lstat(outputRoot);
    if (!target.isDirectory()) throw new Error(`Static export target is not a directory: ${outputRoot}`);
    await access(path.join(outputRoot, markerName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        await access(outputRoot);
      } catch (accessError) {
        if ((accessError as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw accessError;
      }
      throw new Error(`Refusing to replace unmanaged directory: ${outputRoot}`);
    }
    throw error;
  }
}

async function installStaging(stagingRoot: string, outputRoot: string): Promise<void> {
  const backupRoot = `${outputRoot}.backup-${randomUUID()}`;
  let hadExisting = false;
  try {
    await rename(outputRoot, backupRoot);
    hadExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await rename(stagingRoot, outputRoot);
  } catch (error) {
    if (hadExisting) await rename(backupRoot, outputRoot);
    throw error;
  }
  if (hadExisting) await rm(backupRoot, { recursive: true, force: true });
}

function relativeAssetUrl(localUrl: string): string {
  if (localUrl.startsWith('/media/') || localUrl.startsWith('/images/archive/')) return `.${localUrl}`;
  throw new Error(`Cannot export non-local asset URL: ${localUrl}`);
}

async function copyReadyMedia(db: DatabaseSync, config: ShowcaseConfig, stagingRoot: string): Promise<CopyStats> {
  const generations = db.prepare("SELECT DISTINCT generation_id FROM variants WHERE status='READY' AND generation_id IS NOT NULL")
    .all() as Array<{ generation_id: string }>;
  const total = { files: 0, bytes: 0 };
  for (const { generation_id: generationId } of generations) {
    const source = path.resolve(config.mediaRoot, 'generations', generationId);
    if (!contained(config.mediaRoot, source)) throw new Error(`Unsafe media generation path: ${generationId}`);
    const destination = path.join(stagingRoot, 'media', 'generations', generationId);
    const copied = await copyTree(source, destination, mediaExtensions);
    total.files += copied.files;
    total.bytes += copied.bytes;
  }
  return total;
}

async function copyReadyArtwork(db: DatabaseSync, config: ShowcaseConfig, stagingRoot: string): Promise<CopyStats> {
  const posters = db.prepare(`SELECT DISTINCT t.poster_url FROM titles t
    JOIN media_items m ON m.title_id=t.id JOIN variants v ON v.media_item_id=m.id
    WHERE v.status='READY' AND t.poster_url IS NOT NULL`).all() as Array<{ poster_url: string }>;
  const total = { files: 0, bytes: 0 };
  for (const { poster_url: posterUrl } of posters) {
    if (!posterUrl.startsWith('/images/archive/')) throw new Error(`Cannot export non-local poster URL: ${posterUrl}`);
    const relative = posterUrl.slice('/images/archive/'.length);
    const source = path.resolve(config.artworkRoot, relative);
    if (!contained(config.artworkRoot, source) || !artworkExtensions.has(path.extname(source).toLowerCase())) {
      throw new Error(`Unsafe artwork path: ${posterUrl}`);
    }
    total.bytes += await copyOrLink(source, path.join(stagingRoot, 'images', 'archive', relative));
    total.files += 1;
  }
  return total;
}

export async function exportStaticShowcase(
  db: DatabaseSync,
  config: ShowcaseConfig,
  options: StaticExportOptions = {},
): Promise<StaticExportResult> {
  const outputRoot = path.resolve(options.outputRoot ?? config.exportRoot);
  await assertManagedTarget(outputRoot);
  await mkdir(path.dirname(outputRoot), { recursive: true });
  const stagingRoot = await mkdtemp(path.join(path.dirname(outputRoot), `.${path.basename(outputRoot)}.staging-`));
  try {
    await (options.buildViewer ?? buildStaticViewer)(stagingRoot);
    await copyReadyMedia(db, config, stagingRoot);
    await copyReadyArtwork(db, config, stagingRoot);
    const catalog = `${JSON.stringify(buildShowcaseSnapshot(db, relativeAssetUrl), null, 2)}\n`;
    const marker = `${JSON.stringify({ format: 1, generatedAt: new Date().toISOString() })}\n`;
    await Promise.all([
      writeFile(path.join(stagingRoot, 'catalog.json'), catalog),
      writeFile(path.join(stagingRoot, markerName), marker),
    ]);
    const totals = await treeStats(stagingRoot);
    await installStaging(stagingRoot, outputRoot);
    return {
      outputRoot,
      files: totals.files,
      bytes: totals.bytes,
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function setStaticHeaders(response: { setHeader(name: string, value: string): void }, filename: string): void {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.m3u8') response.setHeader('content-type', 'application/vnd.apple.mpegurl');
  else if (extension === '.m4s') response.setHeader('content-type', 'video/iso.segment');
  else if (extension === '.mp4') response.setHeader('content-type', 'video/mp4');
  else if (extension === '.vtt') response.setHeader('content-type', 'text/vtt; charset=utf-8');
  else if (extension === '.ass') response.setHeader('content-type', 'text/plain; charset=utf-8');
  response.setHeader('cache-control', ['.m3u8', '.json', '.html'].includes(extension) ? 'no-cache' : 'public, max-age=31536000, immutable');
}

export async function createStaticPreviewServer(outputRoot: string) {
  await access(path.join(outputRoot, markerName)).catch(() => {
    throw new Error(`Static export is missing at ${outputRoot}. Run \`pnpm showcase export-static\` first.`);
  });
  const app = Fastify({ logger: true });
  await app.register(fastifyStatic, { root: outputRoot, prefix: '/', wildcard: false, setHeaders: setStaticHeaders });
  return app;
}

export async function startStaticPreview(outputRoot: string, host: string, port: number): Promise<void> {
  const app = await createStaticPreviewServer(outputRoot);
  await app.listen({ host, port });
  const shownHost = ['0.0.0.0', '::'].includes(host) ? os.hostname() : host;
  console.log(`Easy Stream static preview: http://${shownHost}:${port}`);
}
