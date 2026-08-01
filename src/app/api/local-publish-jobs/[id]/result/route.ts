import { NextRequest, NextResponse } from 'next/server';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  normalizeLocalPublishJobError,
  submitLocalPublishJobResult,
} from '@/lib/local-publish-jobs';
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

function parseJobId(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new LocalPublishJobError('Invalid local publish job id', 'VALIDATION_ERROR', 400);
  }
  return value.toLowerCase();
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    requireLocalPublishWorker(request.headers.get('authorization'));
    const claimToken = parseClaimToken(
      request.headers.get('x-local-publish-claim-token'),
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
    const job = await submitLocalPublishJobResult(
      parseJobId(params.id),
      claimToken,
      body,
    );
    return NextResponse.json({ job }, { headers: NO_STORE_HEADERS });
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
