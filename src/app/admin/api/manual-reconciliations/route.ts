import { NextRequest, NextResponse } from 'next/server';
import { parseIdempotencyKey, LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  createManualReconciliation,
  getManualReconciliationSummaries,
} from '@/lib/manual-reconciliations';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
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

function errorResponse(error: unknown) {
  const known = normalizeLocalPublishJobError(error);
  return NextResponse.json(
    { error: known.message, code: known.code },
    { status: known.status, headers: NO_STORE_HEADERS },
  );
}

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
    return NextResponse.json(
      { reconciliations: await getManualReconciliationSummaries() },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const unauthorized = await authorize(request);
  if (unauthorized) return unauthorized;
  try {
    const idempotencyKey = parseIdempotencyKey(
      request.headers.get('idempotency-key'),
    );
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new LocalPublishJobError(
        'Request body must be valid JSON',
        'VALIDATION_ERROR',
        400,
      );
    }
    const result = await createManualReconciliation(body, idempotencyKey);
    return NextResponse.json(
      { reconciliation: result.reconciliation },
      { status: result.created ? 201 : 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
