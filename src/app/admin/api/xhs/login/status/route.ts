import { NextRequest } from 'next/server';
import { GET as getLoginStatus } from '@/app/api/xhs/login/status/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  return getLoginStatus(request);
}
