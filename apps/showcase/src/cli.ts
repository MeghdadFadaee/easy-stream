#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { assertArchive, readConfig } from './config.js';
import { openDatabase } from './database.js';
import { prepareSelection, printStatus, pruneMedia } from './prepare.js';
import { scanIntoDatabase } from './scan.js';
import { startServer } from './server.js';

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

Configuration is read from .env.showcase (see .env.showcase.example).`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  const command = args[0];
  if (!command || command === 'help' || command === '--help') return help();
  const config = await readConfig();
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
    else throw new Error(`Unknown command: ${command}`);
  } finally {
    if (command !== 'serve') db.close();
  }
}

main().catch((error) => {
  console.error(`Error: ${(error as Error).message}`);
  process.exitCode = 1;
});
