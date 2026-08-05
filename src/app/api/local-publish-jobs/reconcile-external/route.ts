import { NextRequest, NextResponse } from 'next/server';
import { parseExternalPostSnapshot } from '@/lib/external-post-reconciliation-input';
import { reconcileVerifiedExternalPost } from '@/lib/external-post-reconciliations';
import {
  LocalPublishJobError,
  parseIdempotencyKey,
} from '@/lib/local-publish-job-input';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { requireLocalPublishWorker } from '@/lib/local-publish-worker-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
export const maxDuration = 30;

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

export async function POST(request: NextRequest) {
  try {
    requireLocalPublishWorker(request.headers.get('authorization'));
    const idempotencyKey = parseIdempotencyKey(
      request.headers.get('idempotency-key'),
    );
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new LocalPublishJobError(
        'Request body must be valid JSON',
        'VALIDATION_ERROR',
        400,
      );
    }
    const result = await reconcileVerifiedExternalPost({
      snapshot: parseExternalPostSnapshot(body),
      idempotencyKey,
    });
    return NextResponse.json(
      { reconciliation: result },
      { headers: NO_STORE_HEADERS },
    );
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
