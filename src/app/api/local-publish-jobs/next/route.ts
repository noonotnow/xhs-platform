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
import type { ExactJobActivationSelectors } from '@/lib/exact-job-activation-contract';

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
    const lane = rawLane as LocalPublishWorkLane;
    if (request.nextUrl.searchParams.has('nonce')) {
      throw new LocalPublishJobError(
        'Activation nonce must be supplied only in X-Local-Publish-Activation-Nonce',
        'ACTIVATION_NONCE_QUERY_FORBIDDEN',
        400,
      );
    }
    const selectorNames = [
      'contractRevision',
      'expectedJobId',
      'activationId',
      'expectedBatchId',
      'expectedItemId',
      'expectedManifestHash',
      'expectedItemHash',
      'expectedSourceRevision',
      'expectedReleaseId',
      'expectedWorkerAttestationId',
    ] as const;
    const selectors = Object.fromEntries(selectorNames.map((name) => {
      const values = request.nextUrl.searchParams.getAll(name);
      if (values.length > 1) {
        throw new LocalPublishJobError(
          'Activation selectors must each occur exactly once',
          'VALIDATION_ERROR',
          400,
        );
      }
      return [name, values[0]];
    })) as Record<(typeof selectorNames)[number], string | undefined>;
    const expectedJobId = selectors.expectedJobId;
    const nonce = request.headers.get('x-local-publish-activation-nonce')
      ?? undefined;
    const hasActivationSelector = nonce !== undefined || selectorNames.some(
      (name) => name !== 'expectedJobId' && selectors[name] !== undefined,
    );
    if (expectedJobId !== undefined && !hasActivationSelector) {
      validateExpectedVerificationJobId(lane, expectedJobId);
    }
    if (hasActivationSelector && expectedJobId === undefined) {
      throw new LocalPublishJobError(
        'Exact dispatch requires the complete exact-job activation v1 selector tuple',
        'EXACT_JOB_ACTIVATION_SELECTOR_MISMATCH',
        400,
      );
    }
    const claimToken = request.headers.get('x-local-publish-claim-token');
    if (!claimToken || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claimToken)) {
      throw new LocalPublishJobError(
        'A valid client-generated claim token is required',
        'VALIDATION_ERROR',
        400,
      );
    }
    const job = hasActivationSelector
      ? await claimActivatedLocalPublishJob(
        {
          lane,
          ...selectors,
          nonce,
        } as Omit<Partial<ExactJobActivationSelectors>, 'lane'> & {
          lane: LocalPublishWorkLane;
        },
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
