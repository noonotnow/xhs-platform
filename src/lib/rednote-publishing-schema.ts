import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient, QueryResultRow } from 'pg';

export const REDNOTE_SCHEMA_MIGRATIONS = ['018', '019', '020', '021'] as const;
export type RednoteSchemaMigration = (typeof REDNOTE_SCHEMA_MIGRATIONS)[number];
export type RednoteSchemaReadiness = Record<RednoteSchemaMigration, boolean>;

const migrationFiles: Record<RednoteSchemaMigration, string> = {
  '018': '018_rednote_publishing_attempts.sql',
  '019': '019_local_publish_job_workspaces.sql',
  '020': '020_ready_x3_authorization.sql',
  '021': '021_local_publish_worker_heartbeats.sql',
};

const READINESS_SQL = `
  WITH required_objects(migration, kind, table_name, object_name) AS (
    VALUES
      ('018', 'table', NULL, 'rednote_publish_attempts'),
      ('018', 'table', NULL, 'rednote_publish_attempt_events'),
      ('018', 'table', NULL, 'rednote_publish_attempt_receipts'),
      ('018', 'column', 'rednote_publish_attempts', 'source_local_publish_job_id'),
      ('018', 'column', 'rednote_publish_attempts', 'active'),
      ('018', 'column', 'rednote_publish_attempts', 'payload_revision'),
      ('018', 'column', 'rednote_publish_attempts', 'terminal_outcome'),
      ('018', 'column', 'rednote_publish_attempts', 'receipt_lookup_state'),
      ('018', 'column', 'rednote_publish_attempts', 'terminal_at'),
      ('018', 'column', 'rednote_publish_attempts', 'approved_at'),
      ('018', 'column', 'rednote_publish_attempts', 'claim_expires_at'),
      ('018', 'column', 'rednote_publish_attempts', 'dispatch_authorized_at'),
      ('018', 'column', 'rednote_publish_attempt_events', 'attempt_id'),
      ('018', 'column', 'rednote_publish_attempt_receipts', 'attempt_id'),
      ('018', 'column', 'rednote_publish_attempt_receipts', 'rednote_note_id'),
      ('018', 'column', 'rednote_publish_attempt_receipts', 'rednote_url'),
      ('018', 'column', 'rednote_publish_attempt_receipts', 'captured_at'),
      ('019', 'column', 'local_publish_jobs', 'workspace_id'),
      ('019', 'column', 'manual_reconciliation_requests', 'workspace_id'),
      ('019', 'column', 'rednote_publish_attempts', 'workspace_id'),
      ('020', 'column', 'rednote_publish_attempts', 'authorization_kind'),
      ('020', 'routine', NULL, 'guard_ready_x3_authorization_immutable'),
      ('020', 'trigger', 'rednote_publish_attempts', 'ready_x3_authorization_immutable'),
      ('021', 'table', NULL, 'local_publish_worker_heartbeats'),
      ('021', 'column', 'local_publish_worker_heartbeats', 'workspace_id'),
      ('021', 'column', 'local_publish_worker_heartbeats', 'worker_id'),
      ('021', 'column', 'local_publish_worker_heartbeats', 'contract_revision'),
      ('021', 'column', 'local_publish_worker_heartbeats', 'compatibility_revision'),
      ('021', 'column', 'local_publish_worker_heartbeats', 'polling_interval_seconds'),
      ('021', 'column', 'local_publish_worker_heartbeats', 'last_poll_at'),
      ('021', 'column', 'local_publish_worker_heartbeats', 'next_poll_at'),
      ('021', 'column', 'local_publish_worker_heartbeats', 'last_heartbeat_at'),
      ('021', 'column', 'local_publish_worker_heartbeats', 'lease_expires_at')
  )
  SELECT
    migration,
    bool_and(
      CASE kind
        WHEN 'table' THEN EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = object_name
        )
        WHEN 'column' THEN EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND information_schema.columns.table_name = required_objects.table_name
            AND column_name = object_name
        )
        WHEN 'routine' THEN EXISTS (
          SELECT 1 FROM information_schema.routines
          WHERE routine_schema = 'public' AND routine_name = object_name
        )
        WHEN 'trigger' THEN EXISTS (
          SELECT 1 FROM information_schema.triggers
          WHERE trigger_schema = 'public'
            AND event_object_schema = 'public'
            AND event_object_table = required_objects.table_name
            AND trigger_name = object_name
        )
        ELSE false
      END
    ) AS ready
  FROM required_objects
  GROUP BY migration
  ORDER BY migration
`;

type ReadinessRow = QueryResultRow & {
  migration: RednoteSchemaMigration;
  ready: boolean;
};

export class RednoteSchemaStateChangedError extends Error {
  constructor(
    readonly expectedMissing: RednoteSchemaMigration[],
    readonly actualMissing: RednoteSchemaMigration[],
  ) {
    super('The production schema changed after it was inspected; no migrations were applied.');
  }
}

export function parseExpectedMissing(value: unknown): RednoteSchemaMigration[] {
  if (!Array.isArray(value)) throw new Error('expectedMissing must be an array');
  const unique = new Set<RednoteSchemaMigration>();
  for (const item of value) {
    if (
      typeof item !== 'string'
      || !REDNOTE_SCHEMA_MIGRATIONS.includes(item as RednoteSchemaMigration)
    ) {
      throw new Error('expectedMissing contains an unsupported migration');
    }
    unique.add(item as RednoteSchemaMigration);
  }
  return REDNOTE_SCHEMA_MIGRATIONS.filter((migration) => unique.has(migration));
}

export async function readRednoteSchemaReadiness(
  queryable: Pick<PoolClient, 'query'>,
): Promise<RednoteSchemaReadiness> {
  const result = await queryable.query<ReadinessRow>(READINESS_SQL);
  return Object.fromEntries(
    REDNOTE_SCHEMA_MIGRATIONS.map((migration) => [
      migration,
      result.rows.find((row) => row.migration === migration)?.ready === true,
    ]),
  ) as RednoteSchemaReadiness;
}

export function missingRednoteSchemaMigrations(readiness: RednoteSchemaReadiness) {
  return REDNOTE_SCHEMA_MIGRATIONS.filter((migration) => !readiness[migration]);
}

export async function applyExpectedRednoteSchemaMigrations(
  client: PoolClient,
  expectedMissing: RednoteSchemaMigration[],
) {
  await client.query(
    "SELECT pg_advisory_lock(hashtext('xhs-rednote-publishing-migrations'))",
  );
  try {
    const before = await readRednoteSchemaReadiness(client);
    const actualMissing = missingRednoteSchemaMigrations(before);
    if (
      actualMissing.length !== expectedMissing.length
      || actualMissing.some((migration, index) => migration !== expectedMissing[index])
    ) {
      throw new RednoteSchemaStateChangedError(expectedMissing, actualMissing);
    }

    await client.query('BEGIN');
    try {
      for (const migration of expectedMissing) {
        const sql = await readFile(
          path.join(process.cwd(), 'migrations', migrationFiles[migration]),
          'utf8',
        );
        await client.query(sql);
      }

      const after = await readRednoteSchemaReadiness(client);
      if (missingRednoteSchemaMigrations(after).length > 0) {
        throw new Error('Schema verification failed after migrations were applied');
      }
      await client.query('COMMIT');
      return { before, after, applied: expectedMissing };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.query(
      "SELECT pg_advisory_unlock(hashtext('xhs-rednote-publishing-migrations'))",
    );
  }
}