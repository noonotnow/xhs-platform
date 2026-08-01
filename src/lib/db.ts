import { Pool, QueryResultRow } from 'pg';

let pool: Pool | null = null;

export function getPool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL or POSTGRES_URL is not configured');
  }
  pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : undefined,
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
  return getPool().query<T>(text, values);
}
