import { NextRequest } from 'next/server';
import { GET as getSession } from '@/app/api/xhs/session/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  return getSession(request);
}
