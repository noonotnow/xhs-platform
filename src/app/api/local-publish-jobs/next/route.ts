import { NextRequest, NextResponse } from 'next/server';
import {
  claimNextLocalPublishJob,
  normalizeLocalPublishJobError,
  validateExpectedVerificationJobId,
} from '@/lib/local-publish-jobs';
import { requireLocalPublishWorker } from '@/lib/local-publish-worker-auth';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type { LocalPublishWorkLane } from '@/types/local-publish-job';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

export async function GET(request: NextRequest) {
  try {
    requireLocalPublishWorker(request.headers.get('authorization'));
    const rawLane = request.nextUrl.searchParams.get('lane') ?? 'all';
    if (!['all', 'dispatch', 'verification'].includes(rawLane)) {
      throw new LocalPublishJobError(
        'lane must be dispatch or verification',
        'VALIDATION_ERROR',
        400,
      );
    }
    const expectedJobIds = request.nextUrl.searchParams.getAll('expectedJobId');
    const expectedJobId = expectedJobIds[0];
    if (expectedJobIds.length > 1) {
      throw new LocalPublishJobError(
        'expectedJobId must be one exact UUID',
        'VALIDATION_ERROR',
        400,
      );
    }
    const lane = rawLane as LocalPublishWorkLane;
    if (expectedJobId !== undefined) {
      validateExpectedVerificationJobId(lane, expectedJobId);
    }
    const job = expectedJobId
      ? await claimNextLocalPublishJob(lane, expectedJobId)
      : await claimNextLocalPublishJob(lane);
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
