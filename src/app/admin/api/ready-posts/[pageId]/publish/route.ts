import { NextRequest } from 'next/server';
import { POST as publishReadyPost } from '@/app/api/xhs/ready-posts/[pageId]/publish/route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: { params: { pageId: string } },
) {
  return publishReadyPost(request, context);
}
