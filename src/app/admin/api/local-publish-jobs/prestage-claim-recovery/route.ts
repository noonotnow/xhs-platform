import { NextRequest, NextResponse } from 'next/server';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  diagnoseReadyX3StaleBrowserFrameRecovery,
  requeueReadyX3InvalidClaimFailure,
  requeueReadyX3NotLoggedInFailure,
  requeueReadyX3ScheduleReadbackMismatch,
  requeueReadyX3StaleBrowserFrameFailure,
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
  let confirmation: unknown;
  try {
    const body = await request.json() as Record<string, unknown>;
    confirmation = body.confirm;
    if (
      body.confirm !== 'REQUEUE_EXACT_READY_X3_PRESTAGE_CLAIM' &&
      body.confirm !== 'REQUEUE_EXACT_READY_X3_INVALID_CLAIM_FAILURE' &&
      body.confirm !== 'REQUEUE_EXACT_READY_X3_NOT_LOGGED_IN_FAILURE' &&
      body.confirm !== 'REQUEUE_EXACT_READY_X3_STALE_BROWSER_FRAME_FAILURE' &&
      body.confirm !== 'REQUEUE_EXACT_READY_X3_SCHEDULE_READBACK_MISMATCH' &&
      body.confirm !== 'DIAGNOSE_EXACT_READY_X3_STALE_BROWSER_FRAME_RECOVERY'
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
    const result =
      body.confirm === 'DIAGNOSE_EXACT_READY_X3_STALE_BROWSER_FRAME_RECOVERY'
        ? await diagnoseReadyX3StaleBrowserFrameRecovery(recoveryInput)
        : body.confirm === 'REQUEUE_EXACT_READY_X3_INVALID_CLAIM_FAILURE'
        ? await requeueReadyX3InvalidClaimFailure(recoveryInput)
        : body.confirm === 'REQUEUE_EXACT_READY_X3_NOT_LOGGED_IN_FAILURE'
          ? await requeueReadyX3NotLoggedInFailure(recoveryInput)
          : body.confirm === 'REQUEUE_EXACT_READY_X3_SCHEDULE_READBACK_MISMATCH'
            ? await requeueReadyX3ScheduleReadbackMismatch(recoveryInput)
          : body.confirm === 'REQUEUE_EXACT_READY_X3_STALE_BROWSER_FRAME_FAILURE'
            ? await requeueReadyX3StaleBrowserFrameFailure(recoveryInput)
          : await requeueReadyX3PrestageClaim(recoveryInput);
    return NextResponse.json(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (
      confirmation === 'DIAGNOSE_EXACT_READY_X3_STALE_BROWSER_FRAME_RECOVERY' &&
      !(error instanceof LocalPublishJobError)
    ) {
      const databaseError = error as {
        code?: unknown;
        constraint?: unknown;
        message?: unknown;
      };
      const databaseCode =
        typeof databaseError.code === 'string' && /^[0-9A-Z]{5}$/.test(databaseError.code)
          ? databaseError.code
          : null;
      const constraint =
        typeof databaseError.constraint === 'string' &&
        /^[a-zA-Z0-9_]{1,128}$/.test(databaseError.constraint)
          ? databaseError.constraint
          : null;
      const message = typeof databaseError.message === 'string'
        ? databaseError.message
            .replace(/https?:\/\/\S+/g, '[url-redacted]')
            .replace(/postgres(?:ql)?:\/\/\S+/gi, '[database-url-redacted]')
            .slice(0, 500)
        : 'Unknown database error';
      return NextResponse.json(
        {
          error: 'Ready x3 recovery diagnostic failed',
          code: 'READY_X3_RECOVERY_DIAGNOSTIC_FAILED',
          databaseCode,
          constraint,
          message,
          rolledBack: true,
        },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    }
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