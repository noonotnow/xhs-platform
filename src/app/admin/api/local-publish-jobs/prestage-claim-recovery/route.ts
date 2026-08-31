import { NextRequest, NextResponse } from 'next/server';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  requeueReadyX3InvalidClaimFailure,
  requeueReadyX3PrestageClaim,
} from '@/lib/rednote-publishing-attempt-store';
import { parseWorkspaceId } from '@/lib/workspace-id';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

export async function POST(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) return unauthorized;
  try {
    const body = await request.json() as Record<string, unknown>;
    if (
      body.confirm !== 'REQUEUE_EXACT_READY_X3_PRESTAGE_CLAIM' &&
      body.confirm !== 'REQUEUE_EXACT_READY_X3_INVALID_CLAIM_FAILURE'
    ) {
      throw new LocalPublishJobError(
        'Explicit pre-staging recovery confirmation is required',
        'RECOVERY_CONFIRMATION_REQUIRED',
        400,
      );
    }
    const recoveryInput = {
      workspaceId: parseWorkspaceId(request.headers.get('x-workspace-id')),
      jobId: String(body.jobId ?? ''),
      attemptId: String(body.attemptId ?? ''),
      sourceNotionPageId: String(body.sourceNotionPageId ?? ''),
      revision: String(body.revision ?? ''),
    };
    const result = body.confirm === 'REQUEUE_EXACT_READY_X3_INVALID_CLAIM_FAILURE'
      ? await requeueReadyX3InvalidClaimFailure(recoveryInput)
      : await requeueReadyX3PrestageClaim(recoveryInput);
    return NextResponse.json(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const known = error instanceof LocalPublishJobError
      ? error
      : new LocalPublishJobError(
          'Ready x3 pre-staging recovery failed',
          'READY_X3_PRESTAGE_RECOVERY_FAILED',
          503,
        );
    return NextResponse.json(
      { error: known.message, code: known.code },
      { status: known.status, headers: NO_STORE_HEADERS },
    );
  }
}