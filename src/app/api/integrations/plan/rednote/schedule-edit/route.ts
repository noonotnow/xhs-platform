import { NextRequest, NextResponse } from 'next/server';
import {
  LocalPublishJobError,
  parseIdempotencyKey,
} from '@/lib/local-publish-job-input';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import {
  prepareReadyX3ScheduleEdit,
  reconcileReadyX3ScheduleEdit,
} from '@/lib/ready-x3-schedule-edits';
import { requirePlanIntegration } from '@/lib/plan-integration-auth';
import { parseWorkspaceId } from '@/lib/workspace-id';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

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
  return {
    workspaceId: parseWorkspaceId(request.headers.get('x-workspace-id')),
    idempotencyKey: parseIdempotencyKey(request.headers.get('idempotency-key')),
    actorId: 'plan-integration',
  };
}

async function readJson(request: NextRequest) {
  try {
    return await request.json() as unknown;
  } catch {
    throw new LocalPublishJobError(
      'Request body must be valid JSON',
      'VALIDATION_ERROR',
      400,
    );
  }
}

function objectBody(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalPublishJobError(
      'Request body must be a JSON object',
      'VALIDATION_ERROR',
      400,
    );
  }
  return value as Record<string, unknown>;
}

function sourcePageId(value: unknown) {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 64) {
    throw new LocalPublishJobError(
      'notionPageId must be a non-empty page id of at most 64 characters',
      'VALIDATION_ERROR',
      400,
    );
  }
  return value.trim();
}

function expectedRevision(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== 'string'
    || value.trim().length < 1
    || value.trim().length > 64
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new LocalPublishJobError(
      'expectedSourceRevisionAfter must be a source revision string of at most 64 characters',
      'VALIDATION_ERROR',
      400,
    );
  }
  return value.trim();
}

export async function POST(request: NextRequest) {
  try {
    const auth = authorize(request);
    const body = objectBody(await readJson(request));
    const operation = await prepareReadyX3ScheduleEdit({
      ...auth,
      sourceNotionPageId: sourcePageId(body.notionPageId),
      scheduledDateAfter: body.scheduledDateAfter,
    });
    return NextResponse.json(
      { operation },
      {
        status: operation.state === 'prepared' ? 202 : 200,
        headers: NO_STORE_HEADERS,
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = authorize(request);
    const body = objectBody(await readJson(request));
    const operation = await reconcileReadyX3ScheduleEdit({
      ...auth,
      sourceNotionPageId: sourcePageId(body.notionPageId),
      expectedSourceRevisionAfter: expectedRevision(body.expectedSourceRevisionAfter),
    });
    return NextResponse.json(
      { operation },
      {
        status: operation.state === 'prepared' ? 202 : 200,
        headers: NO_STORE_HEADERS,
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}