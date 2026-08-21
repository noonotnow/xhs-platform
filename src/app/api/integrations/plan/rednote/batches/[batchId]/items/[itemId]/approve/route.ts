import { NextRequest, NextResponse } from 'next/server';
import { LocalPublishJobError, parseIdempotencyKey } from '@/lib/local-publish-job-input';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { requirePlanIntegration } from '@/lib/plan-integration-auth';
import { approvePlanRednoteBatchItem } from '@/lib/plan-rednote-batch-store';

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
 * Mark a single queued PLAN Rednote batch item as explicitly approved.
 * Approval must precede any publish attempt. Rejected items cannot be
 * approved — queue a new batch instead.
 *
 * Requires:
 *   Authorization: Bearer <PLAN_INTEGRATION_TOKEN>
 *   Idempotency-Key: <uuid>
 *   Content-Type: application/json
 *   Body: { notionPageId, expectedNotionVersion }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ batchId: string; itemId: string }> },
) {
  try {
    requirePlanIntegration(request.headers.get('authorization'));
    const idempotencyKey = parseIdempotencyKey(request.headers.get('idempotency-key'));
    const { batchId, itemId } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new LocalPublishJobError('Request body must be valid JSON', 'VALIDATION_ERROR', 400);
    }
    const b = body as Record<string, unknown>;
    if (typeof b.notionPageId !== 'string' || !b.notionPageId) {
      throw new LocalPublishJobError('notionPageId is required', 'VALIDATION_ERROR', 400);
    }
    if (typeof b.expectedNotionVersion !== 'string' || !b.expectedNotionVersion) {
      throw new LocalPublishJobError('expectedNotionVersion is required', 'VALIDATION_ERROR', 400);
    }
    const result = await approvePlanRednoteBatchItem(
      batchId,
      itemId,
      b.notionPageId,
      b.expectedNotionVersion,
      idempotencyKey,
    );
    return NextResponse.json({ approval: result.approval }, { status: result.status, headers: NO_STORE_HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}
