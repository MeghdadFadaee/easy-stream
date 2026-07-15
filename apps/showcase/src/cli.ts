#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { assertArchive, projectRoot, readConfig } from './config.js';
import { openDatabase } from './database.js';
import { prepareSelection, printStatus, pruneMedia } from './prepare.js';
import { scanIntoDatabase } from './scan.js';
import { startServer } from './server.js';
import { exportStaticShowcase, startStaticPreview } from './static.js';

function value(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

function help(): void {
  console.log(`Easy Stream Showcase

Usage:
  pnpm showcase scan
  pnpm showcase prepare --all [--force]
  pnpm showcase prepare --title <slug> [--quality <label>] [--force]
  pnpm showcase status
  pnpm showcase prune [--apply]
  pnpm showcase serve
  pnpm showcase export-static [--output <directory>]
  pnpm showcase preview-static [--output <directory>] [--port <number>]

Configuration is read from .env.showcase (see .env.showcase.example).`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  const command = args[0];
  if (!command || command === 'help' || command === '--help') return help();
  const config = await readConfig();
  const outputOption = value(args, '--output');
  const outputRoot = outputOption ? path.resolve(projectRoot, outputOption) : config.exportRoot;
  if (command === 'preview-static') {
    const previewPort = Number(value(args, '--port') ?? config.port);
    if (!Number.isInteger(previewPort) || previewPort < 1 || previewPort > 65535) throw new Error('--port must be between 1 and 65535');
    await startStaticPreview(outputRoot, config.host, previewPort);
    return;
  }
  await mkdir(config.dataRoot, { recursive: true, mode: 0o750 });
  const db = openDatabase(config.databasePath);
  try {
    if (command === 'scan') {
      await assertArchive(config);
      const result = await scanIntoDatabase(db, config);
      console.log(`Scanned ${result.titles} title(s), ${result.media} media item(s), ${result.variants} variant(s).`);
    } else if (command === 'prepare') {
      await assertArchive(config);
      const title = value(args, '--title');
      const quality = value(args, '--quality');
      const result = await prepareSelection(db, config, {
        all: args.includes('--all'),
        ...(title ? { title } : {}),
        ...(quality ? { quality } : {}),
        force: args.includes('--force'),
      });
      console.log(`Prepared ${result.ready}; failed ${result.failed}.`);
      if (result.failed) process.exitCode = 1;
    } else if (command === 'status') printStatus(db);
    else if (command === 'prune') await pruneMedia(db, config, args.includes('--apply'));
    else if (command === 'serve') await startServer(db, config);
    else if (command === 'export-static') {
      await assertArchive(config);
      const scanned = await scanIntoDatabase(db, config);
      console.log(`Scanned ${scanned.titles} title(s), ${scanned.media} media item(s), ${scanned.variants} variant(s).`);
      const prepared = await prepareSelection(db, config, { all: true });
      if (prepared.failed) throw new Error(`Cannot export because ${prepared.failed} media preparation job(s) failed`);
      await pruneMedia(db, config, true);
      const result = await exportStaticShowcase(db, config, { outputRoot });
      console.log(`Static showcase exported to ${result.outputRoot} (${result.files} files, ${result.bytes} bytes).`);
    }
    else throw new Error(`Unknown command: ${command}`);
  } finally {
    if (command !== 'serve') db.close();
  }
}

main().catch((error) => {
  console.error(`Error: ${(error as Error).message}`);
  process.exitCode = 1;
});
