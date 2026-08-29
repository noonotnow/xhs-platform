import { NextRequest, NextResponse } from 'next/server';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';
import { approveRednotePublishAttempt } from '@/lib/rednote-publishing-attempt-store';
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

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) {
    Object.entries(NO_STORE).forEach(([key, value]) => unauthorized.headers.set(key, value));
    return unauthorized;
  }
  try {
    const workspaceId = parseWorkspaceId(request.headers.get('x-workspace-id'));
    const body = await request.json();
    if (
      !body || typeof body !== 'object' ||
      (body as Record<string, unknown>).contractVersion !== 'publishing-v1'
    ) {
      return NextResponse.json(
        { error: 'The publishing-v1 contract version is required', code: 'STALE_REVISION' },
        { status: 409, headers: NO_STORE },
      );
    }
    const attempt = await approveRednotePublishAttempt(workspaceId, params.id);
    return NextResponse.json({ attempt }, { headers: NO_STORE });
  } catch (error) {
    const known = normalizeLocalPublishJobError(error);
    return NextResponse.json({ error: known.message, code: known.code }, {
      status: known.status,
      headers: NO_STORE,
    });
  }
}