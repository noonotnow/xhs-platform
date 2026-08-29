import { NextRequest, NextResponse } from 'next/server';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import { parseManualReconciliationId } from '@/lib/manual-reconciliation-route';
import { retryFailedManualReconciliation } from '@/lib/manual-reconciliations';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';
import { parseWorkspaceId } from '@/lib/workspace-id';

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
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) {
    for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
      unauthorized.headers.set(name, value);
    }
    return unauthorized;
  }
  try {
    const workspaceId = parseWorkspaceId(request.headers.get('x-workspace-id'));
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new LocalPublishJobError(
        'Retry body must be valid JSON',
        'VALIDATION_ERROR',
        400,
      );
    }
    const reconciliation = await retryFailedManualReconciliation(
      parseManualReconciliationId(params.id),
      body,
      workspaceId,
    );
    return NextResponse.json(
      { reconciliation },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    const known = normalizeLocalPublishJobError(error);
    return NextResponse.json(
      { error: known.message, code: known.code },
      { status: known.status, headers: NO_STORE_HEADERS },
    );
  }
}
