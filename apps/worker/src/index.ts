import { pathToFileURL } from 'node:url';
import { main } from './cli.js';

export * from './catalog.js';
export * from './registry.js';
export * from './cache-lifecycle.js';
export * from './work.js';

export { main } from './cli.js';

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
