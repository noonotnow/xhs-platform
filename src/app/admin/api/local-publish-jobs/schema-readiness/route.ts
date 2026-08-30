import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import {
  applyExpectedRednoteSchemaMigrations,
  missingRednoteSchemaMigrations,
  parseExpectedMissing,
  readRednoteSchemaReadiness,
  RednoteSchemaStateChangedError,
} from '@/lib/rednote-publishing-schema';
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

async function authorize(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) {
    for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
      unauthorized.headers.set(name, value);
    }
  }
  return unauthorized;
}

export async function GET(request: NextRequest) {
  const unauthorized = await authorize(request);
  if (unauthorized) return unauthorized;

  try {
    const migrations = await readRednoteSchemaReadiness(getPool());
    return NextResponse.json(
      {
        ready: missingRednoteSchemaMigrations(migrations).length === 0,
        migrations,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    return NextResponse.json(
      {
        error: 'Schema readiness is temporarily unavailable.',
        code: 'SCHEMA_READINESS_UNAVAILABLE',
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
}

export async function POST(request: NextRequest) {
  const unauthorized = await authorize(request);
  if (unauthorized) return unauthorized;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  if (
    !body
    || typeof body !== 'object'
    || (body as { confirm?: unknown }).confirm !== 'APPLY_REDNOTE_PUBLISHING_MIGRATIONS'
  ) {
    return NextResponse.json(
      {
        error: 'Explicit migration confirmation is required.',
        code: 'MIGRATION_CONFIRMATION_REQUIRED',
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  let expectedMissing;
  try {
    expectedMissing = parseExpectedMissing(
      (body as { expectedMissing?: unknown }).expectedMissing,
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Invalid expected migration set.',
        code: 'INVALID_EXPECTED_MIGRATIONS',
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  const client = await getPool().connect();
  try {
    const result = await applyExpectedRednoteSchemaMigrations(client, expectedMissing);
    return NextResponse.json(
      { ready: true, migrations: result.after, applied: result.applied },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof RednoteSchemaStateChangedError) {
      return NextResponse.json(
        {
          error: error.message,
          code: 'SCHEMA_STATE_CHANGED',
          expectedMissing: error.expectedMissing,
          actualMissing: error.actualMissing,
        },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }
    console.error('RedNote publishing migrations failed', error);
    return NextResponse.json(
      {
        error: 'RedNote publishing migrations could not be applied.',
        code: 'MIGRATION_FAILED',
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  } finally {
    client.release();
  }
}