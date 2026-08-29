import { NextRequest, NextResponse } from 'next/server';
import { claimManualReconciliations } from '@/lib/manual-reconciliations';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { requireLocalPublishWorker } from '@/lib/local-publish-worker-auth';
import { parseWorkspaceId } from '@/lib/workspace-id';

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
    const workspaceId = parseWorkspaceId(request.headers.get('x-workspace-id'));
    const [reconciliation] = await claimManualReconciliations(1, workspaceId);
    if (!reconciliation) {
      return new NextResponse(null, { status: 204, headers: NO_STORE_HEADERS });
    }
    return NextResponse.json(reconciliation, { headers: NO_STORE_HEADERS });
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