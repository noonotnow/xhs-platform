import { NextRequest, NextResponse } from 'next/server';
import { LocalPublishJobError, parseIdempotencyKey } from '@/lib/local-publish-job-input';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { requirePlanIntegration } from '@/lib/plan-integration-auth';
import { queuePlanRednoteBatch } from '@/lib/plan-rednote-batch-store';

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

/**
 * Accept a PLAN Rednote batch manifest. Items enter the 'queued' state and
 * require an explicit per-item approval before they may be published. This
 * route never triggers an immediate publish endpoint.
 *
 * Requires:
 *   Authorization: Bearer <PLAN_INTEGRATION_TOKEN>
 *   Idempotency-Key: <uuid>
 *   Content-Type: application/json
 */
export async function POST(request: NextRequest) {
  try {
    requirePlanIntegration(request.headers.get('authorization'));
    const idempotencyKey = parseIdempotencyKey(request.headers.get('idempotency-key'));
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new LocalPublishJobError('Request body must be valid JSON', 'VALIDATION_ERROR', 400);
    }
    const result = await queuePlanRednoteBatch(body, idempotencyKey);
    return NextResponse.json(result.receipt, { status: result.status, headers: NO_STORE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}
