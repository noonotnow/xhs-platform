import { NextRequest, NextResponse } from 'next/server';
import { listReadyXhsPosts, normalizeNotionPostsError } from '@/lib/notion-posts';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
export const maxDuration = 30;

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

export async function GET(request: NextRequest) {
  const requestId = crypto.randomUUID();
  console.info('Ready posts request started', {
    requestId,
    path: request.nextUrl.pathname,
  });
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) {
    console.warn('Ready posts request unauthorized', { requestId });
    return unauthorized;
  }

  try {
    const result = await listReadyXhsPosts({ requestId });
    console.info('Ready posts request completed', {
      requestId,
      postCount: result.posts.length,
    });
    return NextResponse.json(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    const known = normalizeNotionPostsError(error);
    console.error('Ready posts request failed', {
      requestId,
      code: known.code,
      status: known.status,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: known.message, code: known.code },
      { status: known.status, headers: NO_STORE_HEADERS },
    );
  }
}
