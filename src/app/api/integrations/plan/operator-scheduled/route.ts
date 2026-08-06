import { NextRequest, NextResponse } from 'next/server';
import {
  LocalPublishJobError,
  parseIdempotencyKey,
} from '@/lib/local-publish-job-input';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { requirePlanIntegration } from '@/lib/plan-integration-auth';
import { markPlanOperatorScheduled } from '@/lib/plan-operator-scheduled';
import { loadPlanOperatorScheduledState } from '@/lib/plan-operator-scheduled-store';

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
    {
      status: known.status,
      headers: {
        ...NO_STORE_HEADERS,
        ...(known.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
      },
    },
  );
}

function authorize(request: NextRequest) {
  requirePlanIntegration(request.headers.get('authorization'));
}

export async function GET(request: NextRequest) {
  try {
    authorize(request);
    const notionPageId = request.nextUrl.searchParams.get('notionPageId')?.trim();
    if (!notionPageId || notionPageId.length > 64) {
      throw new LocalPublishJobError(
        'A valid notionPageId query parameter is required',
        'VALIDATION_ERROR',
        400,
      );
    }
    const execution = await loadPlanOperatorScheduledState(notionPageId);
    if (!execution) {
      return NextResponse.json(
        { error: 'No operator-scheduled execution state exists', code: 'PLAN_EXECUTION_NOT_FOUND' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json({ execution }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    authorize(request);
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
    const result = await markPlanOperatorScheduled(body, idempotencyKey);
    return NextResponse.json(
      { execution: result.execution },
      { status: result.created ? 201 : 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
