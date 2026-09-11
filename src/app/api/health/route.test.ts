import { afterEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock next/server so NextResponse.json works outside the Next.js runtime
// ---------------------------------------------------------------------------
vi.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      body,
      status: init?.status ?? 200,
    }),
  },
}));

// ---------------------------------------------------------------------------
// sql mock — each call is configured per-test via sqlImpl
// ---------------------------------------------------------------------------
let sqlImpl: (...args: unknown[]) => Promise<{ rows: unknown[] }> = async () => ({ rows: [] });

vi.mock('@/lib/db', () => ({
  sql: new Proxy(
    async (...args: unknown[]) => sqlImpl(...args),
    {
      // Support tagged-template calls: sql`SELECT …`
      apply(_target, _this, args) {
        return sqlImpl(...args);
      },
    },
  ),
}));

// ---------------------------------------------------------------------------
// Helper: build a tagged-template call interceptor that matches queries
// by substring and returns the configured rows.
// ---------------------------------------------------------------------------
function makeSqlRouter(
  routes: Array<{ match: string; rows: unknown[] }>,
) {
  return async (...args: unknown[]) => {
    // Tagged template: args[0] is the TemplateStringsArray
    const strings = args[0] as TemplateStringsArray;
    const query = strings.join('').replace(/\s+/g, ' ').trim();
    for (const route of routes) {
      if (query.includes(route.match)) {
        return { rows: route.rows };
      }
    }
    throw new Error(`Unmocked SQL query: ${query}`);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/health — migration tracking', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('reports tracking_table_exists: false when schema_migrations does not exist', async () => {
    sqlImpl = makeSqlRouter([
      { match: 'SELECT 1 AS ok', rows: [{ ok: 1 }] },
      { match: 'information_schema.tables', rows: [{ exists: false }] },
    ]);

    const { GET } = await import('./route');
    const res = await GET();
    const body = (res as { body: { migrations: { tracking_table_exists: boolean; seeded_ok: null } } }).body;

    expect(body.migrations.tracking_table_exists).toBe(false);
    expect(body.migrations.seeded_ok).toBeNull();
  });

  it('reports seeded_ok: true when all expected migrations are present', async () => {
    const allMigrations = [
      { name: '001_initial' },
      { name: '002_xhs_publish_receipts' },
      { name: '003_local_publish_jobs' },
      { name: '004_external_post_reconciliations' },
      { name: '005_local_publish_job_lifecycle' },
      { name: '006_rednote_worker_lanes' },
      { name: '007_manual_reconciliation_requests' },
      { name: '008_rednote_publish_batches' },
      { name: '009_superseded_rednote_publish_batches' },
      { name: '010_rednote_publish_job_recoveries' },
      { name: '011_generation_aware_rednote_publish_job_recoveries' },
      { name: '012_recover_fixed_image_mode_hydration' },
      { name: '012_targeted_external_job_dispositions' },
      { name: '013_operator_success_attestations' },
      { name: '014_manual_scheduling_attestations' },
      { name: '015_plan_operator_scheduled_posts' },
      { name: '016_manual_first_receipt_lane' },
      { name: '017_rednote_publishing_attempts' },
    ];

    sqlImpl = makeSqlRouter([
      { match: 'SELECT 1 AS ok', rows: [{ ok: 1 }] },
      { match: 'information_schema.tables', rows: [{ exists: true }] },
      { match: 'schema_migrations', rows: allMigrations },
    ]);

    const { GET } = await import('./route');
    const res = await GET();
    const body = (res as { body: { migrations: { seeded_ok: boolean; missing: string[]; applied_count: number; expected_count: number } } }).body;

    expect(body.migrations.seeded_ok).toBe(true);
    expect(body.migrations.missing).toEqual([]);
    expect(body.migrations.applied_count).toBe(18);
    expect(body.migrations.expected_count).toBe(18);
  });

  it('reports seeded_ok: false and lists missing entries when some migrations are absent', async () => {
    // Simulate a partially seeded table (missing last two migrations)
    const partialMigrations = [
      { name: '001_initial' },
      { name: '002_xhs_publish_receipts' },
      { name: '003_local_publish_jobs' },
    ];

    sqlImpl = makeSqlRouter([
      { match: 'SELECT 1 AS ok', rows: [{ ok: 1 }] },
      { match: 'information_schema.tables', rows: [{ exists: true }] },
      { match: 'schema_migrations', rows: partialMigrations },
    ]);

    const { GET } = await import('./route');
    const res = await GET();
    const body = (res as { body: { migrations: { seeded_ok: boolean; missing: string[]; applied_count: number } } }).body;

    expect(body.migrations.seeded_ok).toBe(false);
    expect(body.migrations.missing).toContain('004_external_post_reconciliations');
    expect(body.migrations.missing).toContain('017_rednote_publishing_attempts');
    expect(body.migrations.applied_count).toBe(3);
  });

  it('does not return 503 when schema_migrations table is missing (pre-first-deploy)', async () => {
    sqlImpl = makeSqlRouter([
      { match: 'SELECT 1 AS ok', rows: [{ ok: 1 }] },
      { match: 'information_schema.tables', rows: [{ exists: false }] },
    ]);

    const { GET } = await import('./route');
    const res = await GET();

    expect((res as { status: number }).status).toBe(200);
  });

  it('returns 503 when the database is unreachable', async () => {
    sqlImpl = async () => {
      throw new Error('connection refused');
    };

    const { GET } = await import('./route');
    const res = await GET();

    expect((res as { status: number }).status).toBe(503);
    const body = (res as { body: { status: string; database: { connected: boolean } } }).body;
    expect(body.status).toBe('unhealthy');
    expect(body.database.connected).toBe(false);
  });
});
