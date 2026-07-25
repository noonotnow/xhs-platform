import { Pool, QueryResultRow } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

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
  return pool.query<T>(text, values);
}

export { pool };
