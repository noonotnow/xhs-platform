import { NextRequest, NextResponse } from 'next/server';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  getLocalPublishJobSummaries,
  normalizeLocalPublishJobError,
} from '@/lib/local-publish-jobs';
import { listStoredPublishBatches } from '@/lib/rednote-publish-batch-store';
import { projectPlanExecution } from '@/lib/plan-execution-projection';
import { parseWorkspaceId } from '@/lib/workspace-id';

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
    const notionPageId = request.nextUrl.searchParams.get('notionPageId')?.trim();
    if (!notionPageId || notionPageId.length > 200) {
      throw new LocalPublishJobError(
        'notionPageId is required and must be at most 200 characters',
        'VALIDATION_ERROR',
        400,
      );
    }
    const [jobs, batches] = await Promise.all([
      getLocalPublishJobSummaries(workspaceId),
      listStoredPublishBatches(workspaceId),
    ]);
    return NextResponse.json(
      { projection: projectPlanExecution(notionPageId, jobs, batches) },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
