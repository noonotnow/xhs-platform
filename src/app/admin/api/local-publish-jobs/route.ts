import { NextRequest, NextResponse } from 'next/server';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';
import { parseIdempotencyKey, LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  normalizeLocalPublishJobError,
  queueLocalPublishJob,
} from '@/lib/local-publish-jobs';
import { parseWorkspaceId } from '@/lib/workspace-id';
import { readRednotePublishingOperational } from '@/lib/rednote-publishing-attempt-store';

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

export async function GET(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) {
    for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
      unauthorized.headers.set(name, value);
    }
    return unauthorized;
  }

  try {
    const workspaceId = parseWorkspaceId(request.headers.get('x-workspace-id'));
    const operational = await readRednotePublishingOperational(workspaceId);
    return NextResponse.json(
      operational,
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) {
    for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
      unauthorized.headers.set(name, value);
    }
    return unauthorized;
  }

  try {
    const workspaceId = parseWorkspaceId(request.headers.get('x-workspace-id'));
    const idempotencyKey = parseIdempotencyKey(request.headers.get('idempotency-key'));
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
    const result = await queueLocalPublishJob(body, idempotencyKey, workspaceId);
    return NextResponse.json(
      { job: result.job, attempt: result.attempt },
      { status: result.created ? 201 : 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
