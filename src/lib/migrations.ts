/**
 * Migration runner for xhs-platform.
 *
 * Behaviour (in order):
 *
 * 1. Creates the `schema_migrations` tracking table if it does not exist.
 *
 * 2. Reconciliation — if `schema_migrations` is empty but the `users` table
 *    already exists, the database was populated before migration tracking was
 *    introduced.  All migration filenames currently in the `migrations/`
 *    directory are recorded as applied without re-running their SQL, so the
 *    history reflects what is actually in the DB.
 *
 * 3. Runs every pending migration (present in `migrations/` but absent from
 *    `schema_migrations`) in ascending alphabetical-filename order, each
 *    inside its own transaction.  A failure halts the run and throws, leaving
 *    subsequent migrations unrun and unrecorded.
 */

import fs from 'fs';
import path from 'path';
import type { Pool, PoolClient } from 'pg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function listMigrationFiles(migrationsDir: string): Promise<string[]> {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // alphabetical — numeric prefixes keep chronological order
}

async function appliedMigrations(client: PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name',
  );
  return new Set(rows.map((r) => r.name));
}

async function usersTableExists(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'users'
    ) AS exists
  `);
  return rows[0]?.exists === true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunMigrationsOptions {
  /** Absolute path to the migrations directory. */
  migrationsDir: string;
  pool: Pool;
  logger?: (msg: string) => void;
}

export async function runMigrations({
  migrationsDir,
  pool,
  logger = console.log,
}: RunMigrationsOptions): Promise<void> {
  const client = await pool.connect();
  try {
    // ── 1. Create tracking table ──────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         SERIAL                   PRIMARY KEY,
        name       TEXT                     NOT NULL UNIQUE,
        applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ── 2. Discover migration files ───────────────────────────────────────
    const files = await listMigrationFiles(migrationsDir);
    if (files.length === 0) {
      logger('No migration files found.');
      return;
    }

    // ── 3. Reconciliation ─────────────────────────────────────────────────
    let tracked = await appliedMigrations(client);

    if (tracked.size === 0 && (await usersTableExists(client))) {
      logger(
        'schema_migrations is empty but the users table already exists — ' +
          'database was populated before tracking was introduced. ' +
          'Seeding migration history without re-running SQL.',
      );
      for (const file of files) {
        const name = file.replace(/\.sql$/, '');
        await client.query(
          `INSERT INTO schema_migrations (name)
           VALUES ($1)
           ON CONFLICT (name) DO NOTHING`,
          [name],
        );
        logger(`  seeded: ${name}`);
      }
      tracked = await appliedMigrations(client);
    }

    // ── 4. Run pending migrations ─────────────────────────────────────────
    const pending = files.filter((f) => !tracked.has(f.replace(/\.sql$/, '')));

    if (pending.length === 0) {
      logger('No pending migrations.');
      return;
    }

    for (const file of pending) {
      const name = file.replace(/\.sql$/, '');
      logger(`Running migration: ${name}`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name) VALUES ($1)',
          [name],
        );
        await client.query('COMMIT');
        logger(`  ✓ ${name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration ${name} failed: ${message}`);
      }
    }

    logger(`Applied ${pending.length} migration(s).`);
  } finally {
    client.release();
  }
}
