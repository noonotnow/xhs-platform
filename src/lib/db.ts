import { Pool, QueryResultRow } from 'pg';
import { readyX3SourceTransactionContext } from '@/lib/ready-x3-source-transaction';

let pool: Pool | null = null;

export function getPool() {
  if (pool) return pool;

  const connectionString = process.env.XHS_DATABASE_URL
    || process.env.XHS_DATABASE_POSTGRES_URL
    || process.env.DATABASE_URL
    || process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error(
      'XHS_DATABASE_URL, XHS_DATABASE_POSTGRES_URL, DATABASE_URL, or POSTGRES_URL is not configured',
    );
  }
  pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 4_000,
    query_timeout: 5_000,
    idleTimeoutMillis: 1_000,
    allowExitOnIdle: true,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : undefined,
  });
  // Serverless instances may resume after Neon has closed an idle socket.
  // pg removes that connection; do not turn its idle error into a process crash.
  pool.on('error', () => {
    console.warn('XHS database idle connection closed');
  });
  return pool;
}

/**
 * Tagged template literal that mirrors the @vercel/postgres `sql` interface.
 * Usage: const result = await sql`SELECT * FROM users WHERE id = ${id}`;
 */
export async function sql<T extends QueryResultRow = QueryResultRow>(
  strings: TemplateStringsArray,
  ...values: unknown[]
) {
  // Build a parameterized query: join template parts with $1, $2, ...
  const text = strings.reduce(
    (acc, str, i) => acc + (i > 0 ? `$${i}` : '') + str,
    '',
  );
  return (readyX3SourceTransactionContext.getStore()?.client ?? getPool()).query<T>(text, values);
}
