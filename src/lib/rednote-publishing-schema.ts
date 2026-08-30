import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient, QueryResultRow } from 'pg';

export const REDNOTE_SCHEMA_MIGRATIONS = ['018', '019', '020', '021'] as const;
export type RednoteSchemaMigration = (typeof REDNOTE_SCHEMA_MIGRATIONS)[number];
export type RednoteSchemaReadiness = Record<RednoteSchemaMigration, boolean>;
export const REDNOTE_SCHEMA_PREREQUISITES = [
  'local_publish_jobs',
  'manual_reconciliation_requests',
  'plan_operator_scheduled_posts',
  'external_post_reconciliations',
  'xhs_publish_receipts',
  'rednote_metric_collection_state',
  'post_performance_snapshots',
  'rednote_publish_batches',
  'rednote_publish_batch_items',
  'rednote_sweep_runs',
  'plan_rednote_batch_manifests',
  'plan_rednote_batch_manifest_items',
  'rednote_publish_job_recoveries',
  'local_publish_job_success_attestations',
  'local_publish_job_success_attestation_release_acks',
] as const;
export type RednoteSchemaPrerequisite = (typeof REDNOTE_SCHEMA_PREREQUISITES)[number];

export const REDNOTE_BASELINE_TABLES = REDNOTE_SCHEMA_PREREQUISITES.filter(
  (table) => table !== 'xhs_publish_receipts',
);

const baselineMigrationFiles = [
  '003_local_publish_jobs.sql',
  '004_external_post_reconciliations.sql',
  '005_local_publish_job_lifecycle.sql',
  '006_rednote_worker_lanes.sql',
  '007_manual_reconciliation_requests.sql',
  '008_rednote_publish_batches.sql',
  '009_superseded_rednote_publish_batches.sql',
  '010_plan_rednote_batch_handoff.sql',
  '010_rednote_publish_job_recoveries.sql',
  '011_generation_aware_rednote_publish_job_recoveries.sql',
  '012_recover_fixed_image_mode_hydration.sql',
  '013_targeted_external_job_dispositions.sql',
  '014_operator_success_attestations.sql',
  '015_manual_scheduling_attestations.sql',
  '016_plan_operator_scheduled_posts.sql',
  '017_manual_first_receipt_lane.sql',
] as const;

const migrationFiles: Record<RednoteSchemaMigration, readonly string[]> = {
  '018': ['018_rednote_publishing_attempts.sql'],
  '019': [
    '019_plan_operator_scheduled_stable_link_capture.sql',
    '019_local_publish_job_workspaces.sql',
  ],
  '020': ['020_ready_x3_authorization.sql'],
  '021': ['021_local_publish_worker_heartbeats.sql'],
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
      ('019', 'column', 'plan_operator_scheduled_posts', 'stable_link_captured_at'),
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

export class RednoteSchemaPrerequisitesMissingError extends Error {
  constructor(readonly missingPrerequisites: RednoteSchemaPrerequisite[]) {
    super('The prerequisite local-publishing schema is missing; no migrations were applied.');
  }
}

export class RednoteBaselineStateChangedError extends Error {
  constructor(
    readonly expectedMissing: RednoteSchemaPrerequisite[],
    readonly actualMissing: RednoteSchemaPrerequisite[],
  ) {
    super('The prerequisite schema changed after it was inspected; no baseline migrations were applied.');
  }
}

export class XhsReceiptSchemaIncompatibleError extends Error {
  constructor(readonly reason: string) {
    super(`The existing XHS receipt schema is not baseline-compatible: ${reason}`);
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

export function parseExpectedMissingPrerequisites(
  value: unknown,
): RednoteSchemaPrerequisite[] {
  if (!Array.isArray(value)) {
    throw new Error('expectedMissingPrerequisites must be an array');
  }
  const unique = new Set<RednoteSchemaPrerequisite>();
  for (const item of value) {
    if (
      typeof item !== 'string'
      || !REDNOTE_SCHEMA_PREREQUISITES.includes(item as RednoteSchemaPrerequisite)
    ) {
      throw new Error('expectedMissingPrerequisites contains an unsupported table');
    }
    unique.add(item as RednoteSchemaPrerequisite);
  }
  return REDNOTE_SCHEMA_PREREQUISITES.filter((table) => unique.has(table));
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

export async function readRednoteSchemaPrerequisites(
  queryable: Pick<PoolClient, 'query'>,
): Promise<Record<RednoteSchemaPrerequisite, boolean>> {
  const result = await queryable.query<{ table_name: string } & QueryResultRow>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])`,
    [REDNOTE_SCHEMA_PREREQUISITES],
  );
  const present = new Set(result.rows.map((row) => row.table_name));
  return Object.fromEntries(
    REDNOTE_SCHEMA_PREREQUISITES.map((table) => [table, present.has(table)]),
  ) as Record<RednoteSchemaPrerequisite, boolean>;
}

async function assertXhsReceiptBaselineCompatibility(
  queryable: Pick<PoolClient, 'query'>,
) {
  const columns = await queryable.query<{
    column_name: string;
    data_type: string;
    is_nullable: 'YES' | 'NO';
  } & QueryResultRow>(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'xhs_publish_receipts'`,
  );
  const byName = new Map(columns.rows.map((column) => [column.column_name, column]));
  const required = [
    ['notion_page_id', 'text', 'NO'],
    ['status', 'text', 'NO'],
    ['note_id', 'text', 'YES'],
    ['share_url', 'text', 'YES'],
    ['created_at', 'timestamp with time zone', 'YES'],
    ['updated_at', 'timestamp with time zone', 'YES'],
  ] as const;
  for (const [name, dataType, nullable] of required) {
    const column = byName.get(name);
    if (!column) throw new XhsReceiptSchemaIncompatibleError(`missing ${name}`);
    if (column.data_type !== dataType) {
      throw new XhsReceiptSchemaIncompatibleError(`${name} has type ${column.data_type}`);
    }
    if (column.is_nullable !== nullable) {
      throw new XhsReceiptSchemaIncompatibleError(`${name} nullability differs`);
    }
  }
  const primaryKey = await queryable.query<{ definition: string } & QueryResultRow>(
    `SELECT pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conrelid = 'public.xhs_publish_receipts'::regclass
       AND contype = 'p'`,
  );
  if (primaryKey.rows[0]?.definition !== 'PRIMARY KEY (notion_page_id)') {
    throw new XhsReceiptSchemaIncompatibleError(
      'expected the canonical notion_page_id primary key',
    );
  }
}

function sameOrderedValues<T extends string>(
  left: readonly T[],
  right: readonly T[],
) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export async function applyExpectedRednoteBaselineMigrations(
  client: PoolClient,
  expectedMissing: RednoteSchemaPrerequisite[],
) {
  await client.query(
    "SELECT pg_advisory_lock(hashtext('xhs-local-publishing-migrations'))",
  );
  try {
    const before = await readRednoteSchemaPrerequisites(client);
    const actualMissing = REDNOTE_SCHEMA_PREREQUISITES.filter(
      (table) => !before[table],
    );
    if (!sameOrderedValues(actualMissing, expectedMissing)) {
      throw new RednoteBaselineStateChangedError(expectedMissing, actualMissing);
    }
    if (!before.xhs_publish_receipts) {
      throw new XhsReceiptSchemaIncompatibleError('xhs_publish_receipts is missing');
    }
    if (!sameOrderedValues(actualMissing, REDNOTE_BASELINE_TABLES)) {
      throw new XhsReceiptSchemaIncompatibleError(
        'the database is not in the reviewed receipt-only baseline state',
      );
    }
    await assertXhsReceiptBaselineCompatibility(client);

    await client.query('BEGIN');
    try {
      for (const file of baselineMigrationFiles) {
        const sql = await readFile(path.join(process.cwd(), 'migrations', file), 'utf8');
        await client.query(sql);
      }
      const after = await readRednoteSchemaPrerequisites(client);
      const missingAfter = REDNOTE_SCHEMA_PREREQUISITES.filter(
        (table) => !after[table],
      );
      if (missingAfter.length > 0) {
        throw new Error('Baseline verification failed after migrations were applied');
      }
      await client.query('COMMIT');
      return { before, after, applied: baselineMigrationFiles };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.query(
      "SELECT pg_advisory_unlock(hashtext('xhs-local-publishing-migrations'))",
    );
  }
}

export async function applyExpectedRednoteSchemaMigrations(
  client: PoolClient,
  expectedMissing: RednoteSchemaMigration[],
) {
  await client.query(
    "SELECT pg_advisory_lock(hashtext('xhs-rednote-publishing-migrations'))",
  );
  try {
    const prerequisites = await readRednoteSchemaPrerequisites(client);
    const missingPrerequisites = REDNOTE_SCHEMA_PREREQUISITES.filter(
      (table) => !prerequisites[table],
    );
    if (missingPrerequisites.length > 0) {
      throw new RednoteSchemaPrerequisitesMissingError(missingPrerequisites);
    }
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
        for (const file of migrationFiles[migration]) {
          const sql = await readFile(
            path.join(process.cwd(), 'migrations', file),
            'utf8',
          );
          await client.query(sql);
        }
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