import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

const DB_ENV_VARS = [
  'XHS_DATABASE_URL',
  'XHS_DATABASE_POSTGRES_URL',
  'DATABASE_URL',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_URL_NO_SSL',
  'POSTGRES_USER',
  'POSTGRES_HOST',
  'POSTGRES_PASSWORD',
  'POSTGRES_DATABASE',
];

/**
 * The canonical set of migration names that must appear in schema_migrations
 * after the first deployment of the migration runner.  Each entry is the SQL
 * filename in /migrations/ with its .sql extension removed.
 *
 * If a new migration file is added, append its name here so the health check
 * immediately detects if it was never applied.
 */
const EXPECTED_MIGRATIONS: readonly string[] = [
  '001_initial',
  '002_xhs_publish_receipts',
  '003_local_publish_jobs',
  '004_external_post_reconciliations',
  '005_local_publish_job_lifecycle',
  '006_rednote_worker_lanes',
  '007_manual_reconciliation_requests',
  '008_rednote_publish_batches',
  '009_superseded_rednote_publish_batches',
  '010_rednote_publish_job_recoveries',
  '011_generation_aware_rednote_publish_job_recoveries',
  '012_recover_fixed_image_mode_hydration',
  '012_targeted_external_job_dispositions',
  '013_operator_success_attestations',
  '014_manual_scheduling_attestations',
  '015_plan_operator_scheduled_posts',
  '016_manual_first_receipt_lane',
  '017_rednote_publishing_attempts',
];

export async function GET() {
  const envStatus: Record<string, boolean> = {};
  for (const key of DB_ENV_VARS) {
    envStatus[key] = !!process.env[key];
  }

  let dbOk = false;
  let dbError: string | null = null;

  try {
    const result = await sql`SELECT 1 AS ok`;
    dbOk = result.rows[0]?.ok === 1;
  } catch (err) {
    dbError = err instanceof Error ? err.message : String(err);
  }

  // ── Migration tracking status ─────────────────────────────────────────────
  // Queries schema_migrations to confirm that the first-deploy reconciliation
  // ran successfully.  The table may not exist before the migration runner
  // executes for the first time — that case is reported but does not flip the
  // HTTP status to 503.
  let migrations: {
    tracking_table_exists: boolean;
    expected_count: number;
    applied_count: number | null;
    missing: string[] | null;
    seeded_ok: boolean | null;
    error: string | null;
  } = {
    tracking_table_exists: false,
    expected_count: EXPECTED_MIGRATIONS.length,
    applied_count: null,
    missing: null,
    seeded_ok: null,
    error: null,
  };

  if (dbOk) {
    try {
      const tableCheck = await sql`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'schema_migrations'
        ) AS exists
      `;
      const tableExists = tableCheck.rows[0]?.exists === true;
      migrations.tracking_table_exists = tableExists;

      if (tableExists) {
        const { rows } = await sql`
          SELECT name FROM schema_migrations ORDER BY name
        `;
        const appliedNames: string[] = rows.map((r: { name: string }) => r.name);
        const appliedSet = new Set(appliedNames);
        const missing = EXPECTED_MIGRATIONS.filter((m) => !appliedSet.has(m));

        migrations.applied_count = appliedNames.length;
        migrations.missing = missing;
        migrations.seeded_ok = missing.length === 0;
      }
    } catch (err) {
      migrations.error = err instanceof Error ? err.message : String(err);
    }
  }

  const status = dbOk ? 200 : 503;

  return NextResponse.json(
    {
      status: dbOk ? 'healthy' : 'unhealthy',
      database: {
        connected: dbOk,
        error: dbError,
      },
      migrations,
      env_vars_set: envStatus,
    },
    { status },
  );
}
