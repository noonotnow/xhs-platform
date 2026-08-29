import { NextRequest, NextResponse } from 'next/server';
import {
  authorizeLocalPublishJob,
  normalizeLocalPublishJobError,
} from '@/lib/local-publish-jobs';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import {
  parseClaimToken,
  requireLocalPublishWorker,
} from '@/lib/local-publish-worker-auth';
import { parseWorkspaceId } from '@/lib/workspace-id';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const revalidate = 0;

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

export async function GET(
  request: NextRequest,
  context: { params: { id: string } },
) {
  try {
    requireLocalPublishWorker(request.headers.get('authorization'));
    const workspaceId = parseWorkspaceId(request.headers.get('x-workspace-id'));
    const claimToken = parseClaimToken(request.headers.get('x-local-publish-claim-token'));
    const job = await authorizeLocalPublishJob(parseJobId(context.params.id), claimToken, workspaceId);
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
