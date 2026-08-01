import { NextRequest, NextResponse } from 'next/server';
import {
  claimNextLocalPublishJob,
  normalizeLocalPublishJobError,
} from '@/lib/local-publish-jobs';
import { requireLocalPublishWorker } from '@/lib/local-publish-worker-auth';

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
    const job = await claimNextLocalPublishJob();
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
