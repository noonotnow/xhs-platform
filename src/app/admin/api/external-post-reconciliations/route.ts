import { NextRequest, NextResponse } from 'next/server';
import {
  externalReconciliationSummary,
  listExternalReconciliations,
} from '@/lib/external-post-reconciliation-store';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

export async function GET(request: NextRequest) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) {
    for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
      unauthorized.headers.set(name, value);
    }
    return unauthorized;
  }

  try {
    const records = await listExternalReconciliations();
    return NextResponse.json(
      { reconciliations: records.map(externalReconciliationSummary) },
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
