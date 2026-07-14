import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { jobs } from './schema.js';

export async function markArchiveScanRunning(db: Database, jobId: string): Promise<boolean> {
  const [updated] = await db.update(jobs).set({
    state: 'RUNNING',
    progress: 0,
    error: null,
    attempts: sql`${jobs.attempts} + 1`,
    updatedAt: new Date(),
  }).where(and(
    eq(jobs.id, jobId),
    eq(jobs.type, 'ARCHIVE_SCAN'),
    // BullMQ may start a retry immediately after its failed event; accept either side of that
    // transition so automatic retries can move the same logical job back to RUNNING.
    inArray(jobs.state, ['QUEUED', 'RUNNING', 'FAILED']),
  )).returning({ id: jobs.id });
  return updated !== undefined;
}

export async function markArchiveScanSucceeded(
  db: Database,
  jobId: string,
  result: Record<string, unknown>,
): Promise<boolean> {
  const [updated] = await db.update(jobs).set({
    state: 'SUCCEEDED',
    progress: 1,
    result,
    error: null,
    updatedAt: new Date(),
  }).where(and(
    eq(jobs.id, jobId),
    eq(jobs.type, 'ARCHIVE_SCAN'),
    eq(jobs.state, 'RUNNING'),
  )).returning({ id: jobs.id });
  return updated !== undefined;
}

export async function markArchiveScanFailed(
  db: Database,
  jobId: string,
  error: string,
): Promise<boolean> {
  const [updated] = await db.update(jobs).set({
    state: 'FAILED',
    error: error.slice(0, 16_000),
    updatedAt: new Date(),
  }).where(and(
    eq(jobs.id, jobId),
    eq(jobs.type, 'ARCHIVE_SCAN'),
    inArray(jobs.state, ['QUEUED', 'RUNNING']),
  )).returning({ id: jobs.id });
  return updated !== undefined;
}
