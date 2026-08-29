import { NextRequest, NextResponse } from 'next/server';
import { heartbeatLocalPublishJob, normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { parseClaimToken, requireLocalPublishWorker } from '@/lib/local-publish-worker-auth';
import { parseWorkspaceId } from '@/lib/workspace-id';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const NO_STORE = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    requireLocalPublishWorker(request.headers.get('authorization'));
    const workspaceId = parseWorkspaceId(request.headers.get('x-workspace-id'));
    const claimToken = parseClaimToken(request.headers.get('x-local-publish-claim-token'));
    const job = await heartbeatLocalPublishJob(params.id, claimToken, workspaceId);
    return NextResponse.json({ job }, { headers: NO_STORE });
  } catch (error) {
    const known = normalizeLocalPublishJobError(error);
    return NextResponse.json({ error: known.message, code: known.code }, {
      status: known.status,
      headers: {
        ...NO_STORE,
        ...(known.status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
      },
    });
  }
}