import { NextRequest, NextResponse } from 'next/server';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { requireLocalPublishWorker } from '@/lib/local-publish-worker-auth';
import {
  claimDueRednoteMetricPosts,
  parseMetricBatchLimit,
} from '@/lib/rednote-metrics';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' };

export async function GET(request: NextRequest) {
  try {
    requireLocalPublishWorker(request.headers.get('authorization'));
    const limit = parseMetricBatchLimit(request.nextUrl.searchParams.get('limit'));
    const onDemand = request.nextUrl.searchParams.get('onDemand') === 'true';
    const items = await claimDueRednoteMetricPosts(limit, onDemand);
    return NextResponse.json({
      items,
      summary: {
        claimed: items.length,
        verified: 0,
        measured: 0,
        snapshotsWritten: 0,
        failures: 0,
      },
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const known = normalizeLocalPublishJobError(error);
    return NextResponse.json(
      { error: known.message, code: known.code },
      { status: known.status, headers: NO_STORE_HEADERS },
    );
  }
}
