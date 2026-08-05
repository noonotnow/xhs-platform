import { NextRequest, NextResponse } from 'next/server';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { parseManualReconciliationId } from '@/lib/manual-reconciliation-route';
import { submitManualReconciliationResult } from '@/lib/manual-reconciliations';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import {
  parseClaimToken,
  requireLocalPublishWorker,
} from '@/lib/local-publish-worker-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
export const maxDuration = 30;

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    requireLocalPublishWorker(request.headers.get('authorization'));
    const claimToken = parseClaimToken(
      request.headers.get('x-manual-reconciliation-claim-token'),
    );
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new LocalPublishJobError(
        'Result body must be valid JSON',
        'VALIDATION_ERROR',
        400,
      );
    }
    const reconciliation = await submitManualReconciliationResult(
      parseManualReconciliationId(params.id),
      claimToken,
      body,
    );
    return NextResponse.json(
      { reconciliation },
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
