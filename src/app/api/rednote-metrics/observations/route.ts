import { NextRequest, NextResponse } from 'next/server';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { requireLocalPublishWorker } from '@/lib/local-publish-worker-auth';
import {
  parseMetricObservations,
  recordRednoteMetricObservations,
} from '@/lib/rednote-metrics';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store, max-age=0, must-revalidate' };

export async function POST(request: NextRequest) {
  try {
    requireLocalPublishWorker(request.headers.get('authorization'));
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new LocalPublishJobError('body must be valid JSON', 'VALIDATION_ERROR', 400);
    }
    const summary = await recordRednoteMetricObservations(parseMetricObservations(body));
    return NextResponse.json({ summary }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const known = normalizeLocalPublishJobError(error);
    return NextResponse.json(
      { error: known.message, code: known.code },
      { status: known.status, headers: NO_STORE_HEADERS },
    );
  }
}
