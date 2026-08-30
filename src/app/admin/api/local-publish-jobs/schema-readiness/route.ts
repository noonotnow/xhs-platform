import { NextRequest, NextResponse } from 'next/server';
    import { getPool } from '@/lib/db';
    import { requireXhsOperator } from '@/lib/xhs-operator-auth';

    export const dynamic = 'force-dynamic';
    export const revalidate = 0;
    export const runtime = 'nodejs';
    export const maxDuration = 30;

    const NO_STORE_HEADERS = {
    'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
    'CDN-Cache-Control': 'no-store',
    'Vercel-CDN-Cache-Control': 'no-store',
    };

    type ReadinessRow = {
    migration: '018' | '019' | '020' | '021';
    ready: boolean;
    };

    export async function GET(request: NextRequest) {
    const unauthorized = await requireXhsOperator(request);
    if (unauthorized) {
      for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
        unauthorized.headers.set(name, value);
      }
      return unauthorized;
    }

    try {
      const result = await getPool().query<ReadinessRow>(`
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
      `);

      const migrations = Object.fromEntries(
        result.rows.map((row) => [row.migration, row.ready]),
      ) as Record<ReadinessRow['migration'], boolean>;
      const ready = ['018', '019', '020', '021'].every(
        (migration) => migrations[migration as ReadinessRow['migration']] === true,
      );

      return NextResponse.json({ ready, migrations }, { headers: NO_STORE_HEADERS });
    } catch {
      return NextResponse.json(
        { error: 'Schema readiness is temporarily unavailable.', code: 'SCHEMA_READINESS_UNAVAILABLE' },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    }
    }
    