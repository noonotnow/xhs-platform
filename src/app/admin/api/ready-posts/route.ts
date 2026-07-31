import { NextRequest } from 'next/server';
import { GET as getReadyPosts } from '@/app/api/xhs/ready-posts/route';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  return getReadyPosts(request);
}
