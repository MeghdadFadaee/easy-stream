import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ShowcaseConfig {
  archiveRoot: string;
  dataRoot: string;
  databasePath: string;
  mediaRoot: string;
  artworkRoot: string;
  webRoot: string;
  host: string;
  port: number;
  ffmpegPath: string;
  ffprobePath: string;
}

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

async function loadEnvironment(filename = path.join(projectRoot, '.env.showcase')): Promise<void> {
  try {
    const source = await readFile(filename, 'utf8');
    for (const line of source.split(/\r?\n/u)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/u);
      if (!match || process.env[match[1]!] !== undefined) continue;
      let value = match[2]!;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[match[1]!] = value;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function readConfig(): Promise<ShowcaseConfig> {
  await loadEnvironment();
  const archiveRoot = path.resolve(projectRoot, process.env.SHOWCASE_ARCHIVE_ROOT ?? './archive');
  const dataRoot = path.resolve(projectRoot, process.env.SHOWCASE_DATA_ROOT ?? './data/showcase');
  const port = Number(process.env.SHOWCASE_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SHOWCASE_PORT must be between 1 and 65535');
  const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  return {
    archiveRoot,
    dataRoot,
    databasePath: path.join(dataRoot, 'showcase.sqlite'),
    mediaRoot: path.join(dataRoot, 'media'),
    artworkRoot: path.join(dataRoot, 'artwork'),
    webRoot,
    host: process.env.SHOWCASE_HOST ?? '127.0.0.1',
    port,
    ffmpegPath: process.env.SHOWCASE_FFMPEG ?? 'ffmpeg',
    ffprobePath: process.env.SHOWCASE_FFPROBE ?? 'ffprobe',
  };
}

export async function assertArchive(config: ShowcaseConfig): Promise<void> {
  await access(config.archiveRoot);
}
