import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import {
  applyExpectedRednoteBaselineMigrations,
  applyExpectedRednoteSchemaMigrations,
  missingRednoteSchemaMigrations,
  parseExpectedMissing,
  parseExpectedMissingPrerequisites,
  readRednoteSchemaPrerequisites,
  readRednoteSchemaReadiness,
  RednoteBaselineStateChangedError,
  RednoteSchemaPrerequisitesMissingError,
  RednoteSchemaStateChangedError,
  XhsReceiptSchemaIncompatibleError,
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
    const [migrations, prerequisites] = await Promise.all([
      readRednoteSchemaReadiness(getPool()),
      readRednoteSchemaPrerequisites(getPool()),
    ]);
    return NextResponse.json(
      {
        ready: missingRednoteSchemaMigrations(migrations).length === 0
          && Object.values(prerequisites).every(Boolean),
        prerequisites,
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
  if (!body || typeof body !== 'object') {
    return NextResponse.json(
      {
        error: 'Explicit migration confirmation is required.',
        code: 'MIGRATION_CONFIRMATION_REQUIRED',
      },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const confirm = (body as { confirm?: unknown }).confirm;

  if (confirm === 'APPLY_LOCAL_PUBLISHING_BASELINE') {
    let expectedMissing;
    try {
      expectedMissing = parseExpectedMissingPrerequisites(
        (body as { expectedMissingPrerequisites?: unknown })
          .expectedMissingPrerequisites,
      );
    } catch (error) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : 'Invalid expected table set.',
          code: 'INVALID_EXPECTED_PREREQUISITES',
        },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const client = await getPool().connect();
    try {
      const result = await applyExpectedRednoteBaselineMigrations(
        client,
        expectedMissing,
      );
      return NextResponse.json(
        { ready: true, prerequisites: result.after, applied: result.applied },
        { headers: NO_STORE_HEADERS },
      );
    } catch (error) {
      if (error instanceof RednoteBaselineStateChangedError) {
        return NextResponse.json(
          {
            error: error.message,
            code: 'BASELINE_STATE_CHANGED',
            expectedMissing: error.expectedMissing,
            actualMissing: error.actualMissing,
          },
          { status: 409, headers: NO_STORE_HEADERS },
        );
      }
      if (error instanceof XhsReceiptSchemaIncompatibleError) {
        return NextResponse.json(
          {
            error: error.message,
            code: 'RECEIPT_SCHEMA_INCOMPATIBLE',
          },
          { status: 409, headers: NO_STORE_HEADERS },
        );
      }
      console.error('Local publishing baseline migrations failed', error);
      return NextResponse.json(
        {
          error: 'Local publishing baseline migrations could not be applied.',
          code: 'BASELINE_MIGRATION_FAILED',
          detail: error instanceof Error ? error.message : 'Unknown migration error',
        },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    } finally {
      client.release();
    }
  }

  if (confirm !== 'APPLY_REDNOTE_PUBLISHING_MIGRATIONS') {
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
    if (error instanceof RednoteSchemaPrerequisitesMissingError) {
      return NextResponse.json(
        {
          error: error.message,
          code: 'SCHEMA_PREREQUISITES_MISSING',
          missingPrerequisites: error.missingPrerequisites,
        },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }
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
        detail: error instanceof Error ? error.message : 'Unknown migration error',
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  } finally {
    client.release();
  }
}