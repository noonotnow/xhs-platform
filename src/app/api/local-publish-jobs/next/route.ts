import { NextRequest, NextResponse } from 'next/server';
import {
  claimNextLocalPublishJob,
  claimActivatedLocalPublishJob,
  normalizeLocalPublishJobError,
  validateExpectedVerificationJobId,
} from '@/lib/local-publish-jobs';
import {
  parseLocalPublishWorkerId,
  requireLocalPublishWorker,
} from '@/lib/local-publish-worker-auth';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type { LocalPublishWorkLane } from '@/types/local-publish-job';
import { parseWorkspaceId } from '@/lib/workspace-id';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  'X-XHS-Deployment-Commit': process.env.VERCEL_GIT_COMMIT_SHA ?? 'unknown',
};

export async function GET(request: NextRequest) {
  try {
    requireLocalPublishWorker(request.headers.get('authorization'));
    const workspaceId = parseWorkspaceId(request.headers.get('x-workspace-id'));
    const rawLane = request.nextUrl.searchParams.get('lane') ?? 'all';
    if (!['all', 'dispatch', 'verification'].includes(rawLane)) {
      throw new LocalPublishJobError(
        'lane must be dispatch or verification',
        'VALIDATION_ERROR',
        400,
      );
    }
    const expectedJobIds = request.nextUrl.searchParams.getAll('expectedJobId');
    const activationIds = request.nextUrl.searchParams.getAll('activationId');
    const nonces = request.nextUrl.searchParams.getAll('nonce');
    const expectedJobId = expectedJobIds[0];
    if (
      expectedJobIds.length > 1
      || activationIds.length > 1
      || nonces.length > 1
    ) {
      throw new LocalPublishJobError(
        'Activation selectors must each occur exactly once',
        'VALIDATION_ERROR',
        400,
      );
    }
    const lane = rawLane as LocalPublishWorkLane;
    const claimToken = request.headers.get('x-local-publish-claim-token');
    if (!claimToken || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claimToken)) {
      throw new LocalPublishJobError(
        'A valid client-generated claim token is required',
        'VALIDATION_ERROR',
        400,
      );
    }
    const activationId = activationIds[0];
    const nonce = nonces[0];
    const hasActivationSelector = activationId !== undefined || nonce !== undefined;
    if (expectedJobId !== undefined && !hasActivationSelector) {
      validateExpectedVerificationJobId(lane, expectedJobId);
    }
    if (hasActivationSelector && expectedJobId === undefined) {
      throw new LocalPublishJobError(
        'Activation dispatch requires expectedJobId',
        'VALIDATION_ERROR',
        400,
      );
    }
    const job = hasActivationSelector
      ? await claimActivatedLocalPublishJob(
        { lane, expectedJobId, activationId, nonce },
        workspaceId,
        claimToken,
        parseLocalPublishWorkerId(
          request.headers.get('x-local-publish-worker-id'),
        ),
      )
      : expectedJobId
      ? await claimNextLocalPublishJob(lane, expectedJobId, workspaceId, claimToken)
      : await claimNextLocalPublishJob(lane, undefined, workspaceId, claimToken);
    if (!job) {
      return new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json(job, { headers: NO_STORE_HEADERS });
  } catch (error) {
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
}
