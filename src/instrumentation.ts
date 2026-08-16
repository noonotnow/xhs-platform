/**
 * Next.js instrumentation hook — runs once at server startup.
 *
 * Applies any pending database migrations so the schema is always current
 * before the first request is handled.  A failure is logged but does not
 * prevent the server from starting; routes that need the missing schema will
 * surface errors naturally.
 *
 * This file is loaded automatically by Next.js when
 * `experimental.instrumentationHook` is enabled in next.config.js.
 */

export async function register() {
  // Only run migrations on the server side (not in the Edge runtime or
  // during client-side bundle evaluation).
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // Dynamic imports keep pg and fs out of the Edge bundle.
  const path = await import('path');
  const { Pool } = await import('pg');
  const { runMigrations } = await import('./lib/migrations.js');

  const connectionString =
    process.env.XHS_DATABASE_MIGRATION_URL ||
    process.env.XHS_DATABASE_URL ||
    process.env.XHS_DATABASE_POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL;

  if (!connectionString) {
    console.warn(
      '[migrations] No database connection string found; skipping auto-migration. ' +
        'Set XHS_DATABASE_MIGRATION_URL or DATABASE_URL.',
    );
    return;
  }

  const pool = new Pool({
    connectionString,
    ssl:
      process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : undefined,
    max: 1,
  });

  const migrationsDir = path.join(process.cwd(), 'migrations');

  try {
    await runMigrations({
      migrationsDir,
      pool,
      logger: (msg) => console.log(`[migrations] ${msg}`),
    });
  } catch (err) {
    console.error(
      '[migrations] Auto-migration failed:',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    await pool.end();
  }
}
