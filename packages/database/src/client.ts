import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export function createDatabase(connectionString: string, options?: { max?: number }) {
  const client = postgres(connectionString, {
    max: options?.max ?? 10,
    prepare: false,
    transform: { undefined: null },
  });

  return {
    client,
    db: drizzle(client, { schema }),
    async close(): Promise<void> {
      await client.end({ timeout: 5 });
    },
  };
}

export type Database = ReturnType<typeof createDatabase>['db'];
