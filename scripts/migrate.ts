#!/usr/bin/env tsx
/**
 * Standalone migration runner.
 *
 * Run manually:
 *   pnpm migrate
 *
 * Requires one of the following environment variables to be set:
 *   XHS_DATABASE_MIGRATION_URL   (preferred — use a direct/non-pooled URL)
 *   XHS_DATABASE_URL
 *   XHS_DATABASE_POSTGRES_URL
 *   DATABASE_URL
 *   POSTGRES_URL
 */

import path from 'path';
import { Pool } from 'pg';
import { runMigrations } from '../src/lib/migrations.js';

const connectionString =
  process.env.XHS_DATABASE_MIGRATION_URL ||
  process.env.XHS_DATABASE_URL ||
  process.env.XHS_DATABASE_POSTGRES_URL ||
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL;

if (!connectionString) {
  console.error(
    'ERROR: No database connection string found.\n' +
      'Set XHS_DATABASE_MIGRATION_URL (preferred for migrations), or any of:\n' +
      '  XHS_DATABASE_URL / XHS_DATABASE_POSTGRES_URL / DATABASE_URL / POSTGRES_URL',
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 1,
});

const migrationsDir = path.join(process.cwd(), 'migrations');

runMigrations({ migrationsDir, pool })
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('Migration runner failed:', err instanceof Error ? err.message : String(err));
    await pool.end();
    process.exit(1);
  });
