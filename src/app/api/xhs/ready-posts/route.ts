import { NextRequest, NextResponse } from 'next/server';
import { listReadyXhsPosts, NotionPostsError } from '@/lib/notion-posts';
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
  if (unauthorized) return unauthorized;

  try {
    return NextResponse.json(await listReadyXhsPosts(), { headers: NO_STORE_HEADERS });
  } catch (error) {
    const known = error instanceof NotionPostsError
      ? error
      : new NotionPostsError('Failed to load ready posts', 'READY_POSTS_LOAD_FAILED', 502);
    if (!(error instanceof NotionPostsError)) console.error('Ready posts load failed:', error);
    return NextResponse.json(
      { error: known.message, code: known.code },
      { status: known.status, headers: NO_STORE_HEADERS },
    );
  }
}
