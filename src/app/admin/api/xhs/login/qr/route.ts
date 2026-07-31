import { NextRequest } from 'next/server';
import { GET as getQrCode } from '@/app/api/xhs/login/qr/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  return getQrCode(request);
}
