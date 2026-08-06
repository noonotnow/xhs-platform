import { NextRequest, NextResponse } from 'next/server';
import { LocalPublishJobError, parseIdempotencyKey } from '@/lib/local-publish-job-input';
import { ManualPostHandlingError } from '@/lib/manual-post-handling-input';
import { normalizeManualPostHandlingError } from '@/lib/manual-post-handling-store';
import {
  getManualPostHandlingSummaries,
  markManualPostHandled,
} from '@/lib/manual-post-handlings';
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
  const known = normalizeManualPostHandlingError(error);
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
      { handlings: await getManualPostHandlingSummaries() },
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
      throw new ManualPostHandlingError(
        'Request body must be valid JSON',
        'VALIDATION_ERROR',
        400,
      );
    }
    const result = await markManualPostHandled(body, idempotencyKey);
    return NextResponse.json(
      { handling: result.handling },
      { status: result.created ? 201 : 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof LocalPublishJobError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: NO_STORE_HEADERS },
      );
    }
    return errorResponse(error);
  }
}
