import { NextRequest, NextResponse } from 'next/server';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';
import { getRednotePublishAttempt } from '@/lib/rednote-publishing-attempt-store';
import { normalizeLocalPublishJobError } from '@/lib/local-publish-jobs';
import { parseWorkspaceId } from '@/lib/workspace-id';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const NO_STORE = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) {
    Object.entries(NO_STORE).forEach(([key, value]) => unauthorized.headers.set(key, value));
    return unauthorized;
  }
  try {
    const workspaceId = parseWorkspaceId(request.headers.get('x-workspace-id'));
    const attempt = await getRednotePublishAttempt(workspaceId, params.id);
    return NextResponse.json({ attempt }, { headers: NO_STORE });
  } catch (error) {
    const known = normalizeLocalPublishJobError(error);
    return NextResponse.json({ error: known.message, code: known.code }, {
      status: known.status,
      headers: NO_STORE,
    });
  }
}