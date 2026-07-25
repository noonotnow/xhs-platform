import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

const DB_ENV_VARS = [
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

  const status = dbOk ? 200 : 503;

  return NextResponse.json(
    {
      status: dbOk ? 'healthy' : 'unhealthy',
      database: {
        connected: dbOk,
        error: dbError,
      },
      env_vars_set: envStatus,
    },
    { status },
  );
}
