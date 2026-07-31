import { NextRequest } from 'next/server';
import { POST as loginWithCookie } from '@/app/api/xhs/login/cookie/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  return loginWithCookie(request);
}
