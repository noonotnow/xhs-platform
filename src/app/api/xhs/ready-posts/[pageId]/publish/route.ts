import { NextRequest, NextResponse } from 'next/server';
import {
  normalizePublishError,
  publishReadyPost,
  ReadyPostPublishError,
} from '@/lib/ready-post-publisher';
import { requireXhsOperator } from '@/lib/xhs-operator-auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

export async function POST(
  request: NextRequest,
  { params }: { params: { pageId: string } },
) {
  const unauthorized = await requireXhsOperator(request);
  if (unauthorized) return unauthorized;

  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ReadyPostPublishError(
        'Request body must be valid JSON',
        'VALIDATION_ERROR',
        400,
      );
    }
    const result = await publishReadyPost(params.pageId, body);
    return NextResponse.json(result, { status: 201, headers: NO_STORE_HEADERS });
  } catch (error) {
    const known = normalizePublishError(error);
    return NextResponse.json(
      {
        error: known.message,
        code: known.code,
        ...(known instanceof ReadyPostPublishError && known.published
          ? { published: known.published }
          : {}),
      },
      { status: known.status, headers: NO_STORE_HEADERS },
    );
  }
}
