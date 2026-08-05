import { NextRequest, NextResponse } from 'next/server';
import {
  claimNextLocalPublishJob,
  normalizeLocalPublishJobError,
} from '@/lib/local-publish-jobs';
import { requireLocalPublishWorker } from '@/lib/local-publish-worker-auth';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import type { LocalPublishWorkLane } from '@/types/local-publish-job';
import { workerCapabilities } from '@/lib/operator-success-attestation';
import { recordLocalPublishWorkerCapabilities } from '@/lib/operator-success-attestation-store';

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
    await recordLocalPublishWorkerCapabilities(
      workerCapabilities(request.headers.get('x-local-publish-worker-capabilities')),
    );
    const rawLane = request.nextUrl.searchParams.get('lane') ?? 'all';
    if (!['all', 'dispatch', 'verification'].includes(rawLane)) {
      throw new LocalPublishJobError(
        'lane must be dispatch or verification',
        'VALIDATION_ERROR',
        400,
      );
    }
    const job = await claimNextLocalPublishJob(rawLane as LocalPublishWorkLane);
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
