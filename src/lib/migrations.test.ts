import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { runMigrations } from './migrations.js';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(overrides: Partial<Record<string, QueryResult>> = {}): PoolClient {
  const defaultResult: QueryResult = { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };

  const query = vi.fn(async (sqlOrConfig: unknown): Promise<QueryResult> => {
    const text = typeof sqlOrConfig === 'string' ? sqlOrConfig : (sqlOrConfig as { text?: string }).text ?? '';
    for (const [pattern, result] of Object.entries(overrides)) {
      if (text.includes(pattern)) return result;
    }
    return defaultResult;
  });

  return { query, release: vi.fn() } as unknown as PoolClient;
}

function makePool(client: PoolClient): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runMigrations', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync('/tmp/migrations-test-');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates schema_migrations table on first run', async () => {
    const client = makeClient({
      'schema_migrations': { rows: [], rowCount: 0, command: '', oid: 0, fields: [] },
    });
    const pool = makePool(client);

    await runMigrations({ migrationsDir: tmpDir, pool, logger: vi.fn() });

    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (typeof c[0] === 'string' ? c[0] : ''),
    );
    expect(calls.some((s: string) => s.includes('CREATE TABLE IF NOT EXISTS schema_migrations'))).toBe(true);
  });

  it('seeds history and skips re-running when users table exists but tracking is empty', async () => {
    // Write one migration file.
    fs.writeFileSync(path.join(tmpDir, '001_initial.sql'), 'CREATE TABLE users (id INT)');

    const client = makeClient({
      'SELECT name FROM schema_migrations': { rows: [], rowCount: 0, command: '', oid: 0, fields: [] },
      "table_name = 'users'": { rows: [{ exists: true }], rowCount: 1, command: '', oid: 0, fields: [] },
    });
    const pool = makePool(client);
    const logger = vi.fn();

    await runMigrations({ migrationsDir: tmpDir, pool, logger });

    // Should NOT have executed the migration SQL itself.
    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (typeof c[0] === 'string' ? c[0] : ''),
    );
    expect(calls.some((s: string) => s.includes('CREATE TABLE users'))).toBe(false);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('Seeding migration history'));
  });

  it('runs pending migrations and records them', async () => {
    fs.writeFileSync(path.join(tmpDir, '002_add_posts.sql'), 'CREATE TABLE posts (id INT)');

    // tracking table already has 001 applied
    const client = makeClient({
      'SELECT name FROM schema_migrations': {
        rows: [{ name: '001_initial' }],
        rowCount: 1,
        command: '',
        oid: 0,
        fields: [],
      },
    });
    const pool = makePool(client);
    const logger = vi.fn();

    await runMigrations({ migrationsDir: tmpDir, pool, logger });

    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (typeof c[0] === 'string' ? c[0] : ''),
    );
    expect(calls.some((s: string) => s.includes('CREATE TABLE posts'))).toBe(true);
    expect(calls.some((s: string) => s.includes('INSERT INTO schema_migrations'))).toBe(true);
  });

  it('throws and rolls back when a migration fails', async () => {
    fs.writeFileSync(path.join(tmpDir, '001_bad.sql'), 'NOT VALID SQL');

    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'NOT VALID SQL') throw new Error('syntax error');
        if (sql.includes('SELECT name FROM schema_migrations')) return { rows: [] };
        if (sql.includes("table_name = 'users'")) return { rows: [{ exists: false }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = makePool(client);

    await expect(
      runMigrations({ migrationsDir: tmpDir, pool, logger: vi.fn() }),
    ).rejects.toThrow('001_bad');

    const calls = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => (typeof c[0] === 'string' ? c[0] : ''),
    );
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  it('reports no pending migrations when all are tracked', async () => {
    fs.writeFileSync(path.join(tmpDir, '001_initial.sql'), 'CREATE TABLE users (id INT)');

    const client = makeClient({
      'SELECT name FROM schema_migrations': {
        rows: [{ name: '001_initial' }],
        rowCount: 1,
        command: '',
        oid: 0,
        fields: [],
      },
    });
    const pool = makePool(client);
    const logger = vi.fn();

    await runMigrations({ migrationsDir: tmpDir, pool, logger });

    expect(logger).toHaveBeenCalledWith('No pending migrations.');
  });
});
